import { SMTPServer } from 'smtp-server';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('smtp');

/**
 * Inbound SMTP gateway. Replaces the abandoned `mailin` package.
 * Emits: 'mail' (parsed mail object) for every accepted message,
 *        'oversize' ({ from, size, recipients }) when DATA is cut mid-stream.
 * Returns the emitter with a .close(cb) for graceful shutdown.
 *
 * 2026-10 refactor:
 *  - MIME parsing runs in a worker thread (parser-worker.js) so a 5 MB
 *    message never stalls the main event loop; the worker respawns on crash
 *    and in-flight parses fail with a retryable 451.
 *  - per-IP guards: concurrent connection cap (tracked at the raw net layer —
 *    smtp-server's session does not expose the socket during onConnect) and
 *    a per-IP accepted-mail rate window. Without these, one host can occupy
 *    the whole maxConnections pool or flood mail at every mailbox name.
 */
export function startSmtpGateway() {
  const gateway = new EventEmitter();

  /* ---------- parse worker ---------- */

  let parseSeq = 0;
  const pendingParses = new Map(); // id -> resolve({ mail } | { error })
  let worker = null;
  let closing = false;

  const spawnWorker = () => {
    worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'parser-worker.js'));
    worker.on('message', ({ id, mail, error }) => {
      const settle = pendingParses.get(id);
      if (!settle) return;
      pendingParses.delete(id);
      settle(error ? { error } : { mail });
    });
    worker.on('error', (err) => log.error('parser worker error:', err.message));
    worker.on('exit', (code) => {
      if (closing) return;
      log.warn(`parser worker exited (code ${code}), respawning`);
      // every in-flight parse must settle or its SMTP callback hangs until
      // dataTimeout; fail them retryable
      for (const [id, settle] of pendingParses) {
        pendingParses.delete(id);
        settle({ error: 'parser unavailable' });
      }
      setTimeout(spawnWorker, 250).unref();
    });
  };
  spawnWorker();

  const parseMail = (raw) =>
    new Promise((resolve) => {
      const id = ++parseSeq;
      pendingParses.set(id, resolve);
      // Buffer.concat may return a view into Node's shared Buffer pool —
      // transferring `raw.buffer` would detach the pool for every Buffer.
      // Copy into a private ArrayBuffer, then transfer it (zero-copy handoff).
      const ab = new ArrayBuffer(raw.byteLength);
      new Uint8Array(ab).set(raw);
      worker.postMessage({ id, raw: ab }, [ab]);
    });

  /* ---------- SMTP server ---------- */

  const server = new SMTPServer({
    banner: config.smtp.banner,
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'], // inbound MX traffic only; nobody authenticates, TLS unused
    size: config.smtp.maxMailBytes,
    maxConnections: config.smtp.maxConnections, // bound memory: each session may buffer up to maxMailBytes
    dataTimeout: config.smtp.dataTimeoutMs,     // kick sessions that stall mid-DATA

    onRcptTo(address, session, cb) {
      // routing happens after DATA (see onData); accept any syntactically valid recipient
      cb();
    },

    onData(stream, session, cb) {
      // per-IP mail rate guard runs before a single message byte is buffered
      const ip = (session.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
      const now = Date.now();
      let seen = mailRateByIp.get(ip);
      if (!seen) mailRateByIp.set(ip, (seen = []));
      while (seen.length && now - seen[0] > 60_000) seen.shift();
      if (seen.length >= config.smtp.maxMailsPerIpPerMin) {
        log.warn(`mail rate limit hit for ${ip} (${seen.length}/min)`);
        const err = new Error('Too many messages from your network, slow down');
        err.responseCode = 421;
        return cb(err);
      }
      seen.push(now);

      const chunks = [];
      let size = 0;
      let tooBig = false;
      let done = false;   // guard: after a stream error, 'end' still fires — cb must only run once
      let dataEnded = false; // 'end' seen: parsing in flight, don't let 'close' race it
      const finish = (err) => {
        if (done) return;
        done = true;
        cb(err);
      };

      stream.on('data', (chunk) => {
        if (tooBig) return;
        size += chunk.length;
        if (size > config.smtp.maxMailBytes) {
          tooBig = true;
          chunks.length = 0;
          stream.destroy(); // stop draining the rest of an oversized message
          // recipient is known from the SMTP envelope (RCPT TO), which arrived
          // before DATA — let the realtime layer notify the watching browser
          log.warn(`rejected oversize mail (${size} bytes) from ${session.envelope.mailFrom?.address ?? '?'}`);
          gateway.emit('oversize', {
            from: session.envelope.mailFrom?.address ?? 'unknown',
            size,
            recipients: (session.envelope.rcptTo ?? []).map((r) => r.address),
          });
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', async () => {
        if (tooBig) {
          const err = new Error('Message too big');
          err.responseCode = 552;
          return finish(err);
        }
        if (done) return;
        dataEnded = true;
        try {
          const raw = Buffer.concat(chunks);
          const { mail, error } = await parseMail(raw);
          if (error) throw new Error(error);
          gateway.emit('mail', mail);
          log.info(`accepted mail (${size} bytes) from ${session.envelope.mailFrom?.address ?? '?'}`);
          finish();
        } catch (err) {
          log.warn('parse error:', err.message);
          const perr = new Error('Unable to process message');
          perr.responseCode = 451;
          finish(perr);
        }
      });

      stream.on('error', (err) => {
        log.warn('stream error:', err.message);
        finish(err);
      });

      // destroy() suppresses 'end' — settle the callback on 'close' instead
      stream.on('close', () => {
        if (done || dataEnded) return;
        const err = new Error(tooBig ? 'Message too big' : 'Connection closed early');
        err.responseCode = tooBig ? 552 : 451;
        finish(err);
      });
    },

    onError(err) {
      log.error('server error:', err.message);
    },
  });

  /* ---------- per-IP concurrency guard (raw net layer) ---------- */

  const connsByIp = new Map();    // ip -> live connection count
  const mailRateByIp = new Map(); // ip -> array of accepted-mail timestamps

  // `server.server` is smtp-server's underlying net.Server. Hooking it is the
  // only reliable "connection closed" signal — the session object never
  // exposes the socket, and onConnect fires before it is attached.
  server.server.on('connection', (sock) => {
    const ip = (sock.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const count = (connsByIp.get(ip) ?? 0) + 1;
    connsByIp.set(ip, count);
    sock.once('close', () => {
      const n = (connsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsByIp.delete(ip);
      else connsByIp.set(ip, n);
    });
    if (count > config.smtp.maxConnPerIp) {
      log.warn(`connection refused for ${ip}: ${count} concurrent sessions`);
      // the banner may already be out (smtp-server greets first) — still
      // answer 421 so a well-behaved sender gets a real code, then cut it
      sock.write('421 Too many concurrent connections from your network\r\n', () => sock.destroy());
    }
  });

  server.on('error', (err) => log.error('socket error:', err.message));
  server.listen(config.smtp.port, config.smtp.host, () => {
    log.info(`listening on ${config.smtp.host}:${config.smtp.port}`);
  });

  // stop accepting new connections; existing sessions get `timeoutMs` to finish
  gateway.close = (timeoutMs = 2000, cb = () => {}) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      closing = true;
      worker?.terminate();
      cb();
    };
    server.close(() => done());
    setTimeout(() => { server.unref(); done(); }, timeoutMs).unref();
    log.info('closing: no new SMTP connections accepted');
  };

  return gateway;
}
