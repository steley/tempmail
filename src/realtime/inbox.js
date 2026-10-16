import { Server } from 'socket.io';
import config from '../config.js';
import { newMailboxName, isValidMailboxName } from '../lib/id.js';
import { createLogger } from '../lib/logger.js';
import { errorInfo } from '../lib/errors.js';
import { createMailboxStore } from '../store/mailbox-store.js';

const log = createLogger('realtime');

/**
 * Realtime layer. Wire protocol is identical to the original forsaken-mail
 * so the refreshed frontend keeps working unchanged:
 *   client -> server: 'request shortid' | 'set shortid'
 *   server -> client: 'shortid' (name)  |  'mail' ({ headers, html, text })
 * 2026-10 additions: 'mail history' (array of stored mails, sent once right
 * after a claim) — pure addition, old clients ignore unknown events.
 * Recovery links: after every claim the server also emits 'recovery'
 * { token, expiresAt }. A client that presents a live token via the
 * 'recover' event reclaims that mailbox (kicking current listeners) — so a
 * user can reopen the inbox on another device / after clearing storage.
 * Tokens live exactly as long as the replay-buffer TTL: no store, no mail.
 */
export function attachRealtime(httpServer, mailGateway) {
  // serveClient=false: the client bundle ships as public/js/socket.io.min.js
  // so it gets express's long immutable cache instead of socket.io's no-cache default
  const io = new Server(httpServer, { serveClient: false });
  // per-process id: lets the client detect a server restart (in-memory store
  // is gone, mail ids restart from 1) and reset its list instead of mixing
  // mails from two different store generations
  const bootId = crypto.randomUUID();
  const socketsByMailbox = new Map(); // mailbox name -> Set<socket>
  const owners = new Map();           // mailbox name -> Set<valid claim tokens>
  const rateWindow = new Map();       // mailbox name -> array of broadcast timestamps
  const store = createMailboxStore(config.store); // offline replay buffer (Phase 1)

  // --- recovery tokens (in-memory, same TTL as the replay buffer) ---
  const recByToken = new Map(); // token -> { name, expireAt }
  const recByName = new Map();  // mailbox name -> token (stable per mailbox)
  const recSweep = () => {
    const now = Date.now();
    for (const [token, rec] of recByToken) {
      if (rec.expireAt <= now) {
        recByName.delete(rec.name);
        recByToken.delete(token);
        // reclaim rights die with the token too (unless someone is live on it)
        if (!socketsByMailbox.has(rec.name)) owners.delete(rec.name);
      }
    }
  };
  const recTimer = setInterval(recSweep, Math.max(5_000, config.store.ttlMs / 4));
  recTimer.unref();

  // one token per mailbox, reused across re-claims so a saved recovery link
  // keeps working; a new random address simply gets its own fresh token
  const issueRecovery = (name) => {
    const existing = recByName.get(name);
    if (existing && recByToken.has(existing)) return existing;
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    recByToken.set(token, { name, expireAt: Date.now() + config.store.ttlMs });
    recByName.set(name, token);
    return token;
  };

  // global broadcast fuse: an attacker spraying mail at thousands of mailbox
  // names can otherwise turn every accepted mail into N socket emits. The
  // fuse counts ALL broadcasts in a rolling second; over the limit they are
  // dropped (logged, throttled). Live mail for a single quiet mailbox is
  // unaffected — the fuse only trips under cross-mailbox floods.
  let fuseCount = 0;
  let fuseWindowStart = Date.now();
  let fuseLastWarn = 0;
  const fuseOk = () => {
    const now = Date.now();
    if (now - fuseWindowStart >= 1_000) {
      fuseWindowStart = now;
      fuseCount = 0;
    }
    if (++fuseCount > config.realtime.maxBroadcastsPerSec) {
      if (now - fuseLastWarn > 5_000) {
        fuseLastWarn = now;
        log.warn(`global broadcast fuse tripped (> ${config.realtime.maxBroadcastsPerSec}/s) — dropping broadcasts`);
      }
      return false;
    }
    return true;
  };

  const claim = (socket, name, tokens) => {
    release(socket);
    socket.data.mailbox = name;
    if (!socketsByMailbox.has(name)) socketsByMailbox.set(name, new Set());
    socketsByMailbox.get(name).add(socket);
    if (!owners.has(name)) owners.set(name, new Set());
    for (const t of tokens) if (t) owners.get(name).add(t);
    // offline replay (Phase 1): mails that arrived while this browser was
    // disconnected are flushed once, right after the claim is acked. Old
    // clients simply ignore the unknown 'mail history' event.
    socket.emit('boot', { id: bootId });
    const history = store.take(name);
    if (history.length) socket.emit('mail history', history);
  };

  const release = (socket) => {
    const prev = socket.data.mailbox;
    if (!prev) return;
    const set = socketsByMailbox.get(prev);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        socketsByMailbox.delete(prev);
        // NOTE: owners and the recovery token are deliberately kept — a saved
        // recovery link must keep working after the tab closes. They are
        // cleaned up by recSweep when the TTL expires.
        rateWindow.delete(prev); // no listeners left — reset the rate window too
      }
    }
    socket.data.mailbox = null;
  };

  const isReserved = (name) => config.smtp.reservedNames.includes(name);

  // pull mailbox names out of the recipient list and keep only names the claim
  // path would accept. `recipients` is an array of structured addresses from
  // mailparser/envelope — local parts only, so display names containing "@"
  // can never route mail to an unintended mailbox. A raw header text string
  // (defensive fallback) still goes through the old address-shaped regex.
  const extractMailboxes = (recipients) => {
    const out = new Set();
    let addrs;
    if (Array.isArray(recipients)) {
      addrs = recipients; // structured addresses from mailparser/envelope
    } else {
      // defensive fallback: raw header text — address-shaped substrings only
      addrs = Array.from(
        String(recipients ?? '').matchAll(/([\w._-]+)@[\w._-]+/g),
        (m) => m[0],
      );
    }
    for (const addr of addrs) {
      if (!addr) continue;
      const local = String(addr).split('@')[0].trim().toLowerCase();
      if (isValidMailboxName(local)) out.add(local);
    }
    return out;
  };

  // per-mailbox sliding-window rate limit — throttles notification spam
  // (oversize notices) only. Real mail is NEVER dropped here: capping pushes
  // lets an attacker's junk flood hide a user's verification code while SMTP
  // still answers 250. A visible flood beats an invisible loss.
  const broadcast = (mailbox, event, payload) => {
    const targets = socketsByMailbox.get(mailbox);
    if (!targets) return;

    // global fuse (Phase 3): counts every emit, mail included. Trips only
    // under cross-mailbox floods; a single quiet mailbox never gets near it.
    if (!fuseOk()) return;

    // rate limit only machine-generated notifications ('mail deleted' is
    // user-driven — throttling it would desync open tabs)
    if (event !== 'mail' && event !== 'mail deleted') {
      const now = Date.now();
      let seen = rateWindow.get(mailbox);
      if (!seen) rateWindow.set(mailbox, (seen = []));
      while (seen.length && now - seen[0] > 60_000) seen.shift();
      if (seen.length >= config.smtp.ratePerMinute) {
        if (!seen.warned) {
          seen.warned = true;
          log.warn(`rate limit hit for "${mailbox}" — dropping further notifications this minute`);
          // tell the user once — silence is indistinguishable from lost mail
          const info = errorInfo('E_RATE_LIMITED');
          for (const socket of targets) {
            socket.emit('server error', { code: 'E_RATE_LIMITED', message: info.message });
          }
        }
        return;
      }
      seen.warned = false;
      seen.push(now);
    }

    for (const socket of targets) socket.emit(event, payload);
  };

  io.on('connection', (socket) => {
    socket.on('request shortid', (token) => {
      const name = newMailboxName();
      claim(socket, name, [typeof token === 'string' ? token : null]);
      socket.emit('shortid', name);
      const rt = issueRecovery(name);
      socket.emit('recovery', { token: rt, expiresAt: recByToken.get(rt).expireAt });
    });

    // recovery link: token holder reclaims the mailbox. The token is
    // authoritative — current listeners (e.g. the original tab) are kicked.
    socket.on('recover', (rawToken, clientToken) => {
      const token = typeof rawToken === 'string' ? rawToken : '';
      const rec = recByToken.get(token);
      if (!rec) {
        socket.emit('recovery rejected', { message: 'This recovery link has expired or is invalid.' });
        return;
      }
      const name = rec.name;
      if (socketsByMailbox.has(name)) {
        for (const stale of socketsByMailbox.get(name)) {
          stale.data.mailbox = null; // keep release() from tearing down the set we reuse
          stale.disconnect(true);
        }
        socketsByMailbox.delete(name);
      }
      owners.delete(name); // takeover resets reclaim rights to the incoming connection
      claim(socket, name, [token, typeof clientToken === 'string' ? clientToken : null]);
      socket.emit('shortid', name);
      socket.emit('recovery', { token, expiresAt: rec.expireAt });
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
        if (owner && typeof token === 'string' && owner.has(token)) {
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
      claim(socket, requested, [typeof token === 'string' ? token : null]);
      socket.emit('shortid', socket.data.mailbox);
      const rt = issueRecovery(requested);
      socket.emit('recovery', { token: rt, expiresAt: recByToken.get(rt).expireAt });
    });

    socket.on('disconnect', () => release(socket)); // fixed: old version leaked every dead socket

    // manual delete: the client asks to remove one mail from its own mailbox's
    // replay buffer. Scoped to socket.data.mailbox, so a socket can never touch
    // another mailbox's mail. On success everyone listening on the mailbox gets
    // 'mail deleted' so every open tab stays in sync.
    socket.on('delete mail', (mailId, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const name = socket.data.mailbox;
      if (!name || !Number.isInteger(mailId)) { done({ ok: false }); return; }
      const ok = store.removeMail(name, mailId);
      if (ok) broadcast(name, 'mail deleted', { id: mailId });
      done({ ok });
    });
  });

  mailGateway.on('mail', (mail) => {
    const mailboxes = extractMailboxes(mail.recipients ?? mail.headers.to);
    for (const mailbox of mailboxes) {
      // store first (sync, in-memory), broadcast second — the replay buffer
      // can never delay or break live delivery
      store.put(mailbox, mail);
      broadcast(mailbox, 'mail', mail);
    }
  });

  // a mail was rejected mid-DATA for exceeding the size limit; the envelope
  // recipients are the best available address (parsed To/Cc never materialised)
  mailGateway.on('oversize', ({ from, size, recipients }) => {
    const mailboxes = extractMailboxes(recipients);
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
