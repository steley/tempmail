import { Server } from 'socket.io';
import config from '../config.js';
import { newMailboxName, isValidMailboxName } from '../lib/id.js';
import { createLogger } from '../lib/logger.js';
import { errorInfo } from '../lib/errors.js';

const log = createLogger('realtime');

/**
 * Realtime layer. Wire protocol is identical to the original forsaken-mail
 * so the refreshed frontend keeps working unchanged:
 *   client -> server: 'request shortid' | 'set shortid'
 *   server -> client: 'shortid' (name)  |  'mail' ({ headers, html, text })
 */
export function attachRealtime(httpServer, mailGateway) {
  // serveClient=false: the client bundle ships as public/js/socket.io.min.js
  // so it gets express's long immutable cache instead of socket.io's no-cache default
  const io = new Server(httpServer, { serveClient: false });
  const socketsByMailbox = new Map(); // mailbox name -> Set<socket>
  const owners = new Map();           // mailbox name -> owner token (reconnect reclaim)
  const rateWindow = new Map();       // mailbox name -> array of broadcast timestamps

  const claim = (socket, name, token) => {
    release(socket);
    socket.data.mailbox = name;
    if (!socketsByMailbox.has(name)) socketsByMailbox.set(name, new Set());
    socketsByMailbox.get(name).add(socket);
    if (token) owners.set(name, token);
  };

  const release = (socket) => {
    const prev = socket.data.mailbox;
    if (!prev) return;
    const set = socketsByMailbox.get(prev);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        socketsByMailbox.delete(prev);
        owners.delete(prev);
        rateWindow.delete(prev); // no listeners left — reset the rate window too
      }
    }
    socket.data.mailbox = null;
  };

  const isReserved = (name) => config.smtp.reservedNames.includes(name);

  // per-mailbox sliding-window rate limit (abuse guard), shared by mail
  // broadcasts and oversize-drop notifications so a flood of either consumes
  // the same budget
  const broadcast = (mailbox, event, payload) => {
    const targets = socketsByMailbox.get(mailbox);
    if (!targets) return;

    const now = Date.now();
    let seen = rateWindow.get(mailbox);
    if (!seen) rateWindow.set(mailbox, (seen = []));
    while (seen.length && now - seen[0] > 60_000) seen.shift();
    if (seen.length >= config.smtp.ratePerMinute) {
      if (!seen.warned) {
        log.warn(`rate limit hit for "${mailbox}" — dropping further broadcasts this minute`);
        seen.warned = true;
        // previously silent — users saw mails vanish with no explanation
        const info = errorInfo('E_RATE_LIMITED');
        for (const socket of targets) {
          socket.emit('server error', { code: 'E_RATE_LIMITED', message: info.message });
        }
      }
      return;
    }
    seen.warned = false;
    seen.push(now);

    for (const socket of targets) socket.emit(event, payload);
  };

  io.on('connection', (socket) => {
    socket.on('request shortid', (token) => {
      claim(socket, newMailboxName(), typeof token === 'string' ? token : null);
      socket.emit('shortid', socket.data.mailbox);
    });

    socket.on('set shortid', (name, token) => {
      const reject = (code) => {
        socket.emit('shortid rejected', {
          name: String(name ?? '').trim().toLowerCase(),
          code,
          message: errorInfo(code).message,
        });
      };
      const requested = String(name ?? '').trim().toLowerCase();
      if (!isValidMailboxName(requested)) {
        reject('E_SHORTID_INVALID');
        return;
      }
      if (isReserved(requested)) {
        reject('E_SHORTID_RESERVED');
        return;
      }
      if (socketsByMailbox.has(requested)) {
        const owner = owners.get(requested);
        if (owner && typeof token === 'string' && token === owner) {
          // same browser reconnecting (e.g. after a transport drop) — the old
          // socket is a zombie the server hasn't reaped yet (ping timeout up
          // to ~25s). Kick it and let this connection take over (audit F-fix).
          for (const stale of socketsByMailbox.get(requested)) {
            stale.data.mailbox = null; // prevent release() from tearing down the set we're about to reuse
            stale.disconnect(true);
          }
          socketsByMailbox.delete(requested);
        } else {
          // somebody else is listening on this mailbox — no silent sharing (audit F1)
          reject('E_SHORTID_TAKEN');
          return;
        }
      }
      claim(socket, requested, typeof token === 'string' ? token : null);
      socket.emit('shortid', socket.data.mailbox);
    });

    socket.on('disconnect', () => release(socket)); // fixed: old version leaked every dead socket
  });

  mailGateway.on('mail', (mail) => {
    const to = String(mail.recipients ?? mail.headers.to ?? '').toLowerCase();
    const mailboxes = new Set(); // dedupe: one mail per mailbox even with duplicate recipients
    for (const m of to.matchAll(/([\w._-]+)@[\w._-]+/g)) mailboxes.add(m[1]);
    if (mailboxes.size === 0) return;
    for (const mailbox of mailboxes) broadcast(mailbox, 'mail', mail);
  });

  // a mail was rejected mid-DATA for exceeding the size limit; the envelope
  // recipients are the best available address (parsed To/Cc never materialised)
  mailGateway.on('oversize', ({ from, size, recipients }) => {
    const to = String(recipients ?? '').toLowerCase();
    const mailboxes = new Set();
    for (const m of to.matchAll(/([\w._-]+)@[\w._-]+/g)) mailboxes.add(m[1]);
    if (mailboxes.size === 0) return;
    const info = errorInfo('E_MAIL_TOO_BIG');
    for (const mailbox of mailboxes) {
      broadcast(mailbox, 'server error', {
        code: 'E_MAIL_TOO_BIG',
        message: `${info.message} (from ${from}, ${(size / 1024 / 1024).toFixed(1)} MB)`,
      });
    }
  });

  return io;
}
