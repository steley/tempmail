import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { EventEmitter } from 'node:events';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('smtp');

/**
 * Inbound SMTP gateway. Replaces the abandoned `mailin` package.
 * Emits: 'mail' (parsedMail) for every accepted message.
 * Returns the emitter with a .close(cb) for graceful shutdown.
 */
export function startSmtpGateway() {
  const gateway = new EventEmitter();

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
            recipients: (session.envelope.rcptTo ?? []).map((r) => r.address).join(','),
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
          const parsed = await simpleParser(raw);
          gateway.emit('mail', {
            headers: {
              from: parsed.from?.text ?? 'unknown',
              to: parsed.to?.text ?? '',
              subject: parsed.subject ?? '',
              date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            },
            // route every To/Cc recipient, not just the first (audit F6)
            recipients: [parsed.to, parsed.cc]
              .flatMap((f) => (Array.isArray(f) ? f.map((a) => a.text) : [f?.text]))
              .filter(Boolean)
              .join(','),
            html: parsed.html ?? null,
            text: parsed.text ?? '',
          });
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

  server.on('error', (err) => log.error('socket error:', err.message));
  server.listen(config.smtp.port, config.smtp.host, () => {
    log.info(`listening on ${config.smtp.host}:${config.smtp.port}`);
  });

  // stop accepting new connections; existing sessions get `timeoutMs` to finish
  gateway.close = (timeoutMs = 2000, cb = () => {}) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; cb(); } };
    server.close(() => done());
    setTimeout(() => { server.unref(); done(); }, timeoutMs).unref();
    log.info('closing: no new SMTP connections accepted');
  };

  return gateway;
}
