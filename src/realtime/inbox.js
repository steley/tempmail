import { Server } from 'socket.io';
import config from '../config.js';
import { newMailboxName, isValidMailboxName } from '../lib/id.js';

/**
 * Realtime layer. Wire protocol is identical to the original forsaken-mail
 * so the refreshed frontend keeps working unchanged:
 *   client -> server: 'request shortid' | 'set shortid'
 *   server -> client: 'shortid' (name)  |  'mail' ({ headers, html, text })
 */
export function attachRealtime(httpServer, mailGateway) {
  const io = new Server(httpServer, { cors: { origin: false } });
  const socketsByMailbox = new Map(); // mailbox name -> Set<socket>

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
      if (set.size === 0) socketsByMailbox.delete(prev);
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
      if (!isValidMailboxName(requested) || isReserved(requested)) {
        // reject silently (same UX as the old blacklist) but never register it
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
    if (targets) for (const socket of targets) socket.emit('mail', mail);
  });

  return io;
}
