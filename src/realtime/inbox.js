import { Server } from 'socket.io';
import config from '../config.js';
import { newMailboxName, isValidMailboxName } from '../lib/id.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('realtime');

/**
 * Realtime layer. Wire protocol is identical to the original forsaken-mail
 * so the refreshed frontend keeps working unchanged:
 *   client -> server: 'request shortid' | 'set shortid'
 *   server -> client: 'shortid' (name)  |  'mail' ({ headers, html, text })
 */
export function attachRealtime(httpServer, mailGateway) {
  const io = new Server(httpServer, { cors: { origin: false } });
  const socketsByMailbox = new Map(); // mailbox name -> Set<socket>
  const rateWindow = new Map();       // mailbox name -> array of broadcast timestamps

  const claim = (socket, name) => {
    release(socket);
    socket.data.mailbox = name;
    if (!socketsByMailbox.has(name)) socketsByMailbox.set(name, new Set());
    socketsByMailbox.get(name).add(socket);
  };

  const release = (socket) => {
    const prev = socket.data.mailbox;
    if (!prev) return;
    const set = socketsByMailbox.get(prev);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        socketsByMailbox.delete(prev);
        rateWindow.delete(prev); // no listeners left — reset the rate window too
      }
    }
    socket.data.mailbox = null;
  };

  const isReserved = (name) => config.smtp.reservedNames.includes(name);

  io.on('connection', (socket) => {
    socket.on('request shortid', () => {
      claim(socket, newMailboxName());
      socket.emit('shortid', socket.data.mailbox);
    });

    socket.on('set shortid', (name) => {
      const requested = String(name ?? '').trim().toLowerCase();
      if (!isValidMailboxName(requested)) {
        socket.emit('shortid rejected', { name: requested, reason: 'invalid' });
        return;
      }
      if (isReserved(requested)) {
        socket.emit('shortid rejected', { name: requested, reason: 'reserved' });
        return;
      }
      claim(socket, requested);
      socket.emit('shortid', socket.data.mailbox);
    });

    socket.on('disconnect', () => release(socket)); // fixed: old version leaked every dead socket
  });

  mailGateway.on('mail', (mail) => {
    const to = String(mail.headers.to ?? '').toLowerCase();
    const match = to.match(/([\w._-]+)@[\w._-]+/);
    if (!match) return;
    const targets = socketsByMailbox.get(match[1]);
    if (!targets) return;

    // per-mailbox sliding-window rate limit on broadcasts (abuse guard)
    const now = Date.now();
    let seen = rateWindow.get(match[1]);
    if (!seen) rateWindow.set(match[1], (seen = []));
    while (seen.length && now - seen[0] > 60_000) seen.shift();
    if (seen.length >= config.smtp.ratePerMinute) {
      if (!seen.warned) {
        log.warn(`rate limit hit for "${match[1]}" — dropping further broadcasts this minute`);
        seen.warned = true;
      }
      return;
    }
    seen.warned = false;
    seen.push(now);

    for (const socket of targets) socket.emit('mail', mail);
  });

  return io;
}
