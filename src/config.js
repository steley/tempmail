import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (key, fallback) => process.env[key] ?? fallback;
// numeric env guard: invalid or negative values fall back instead of becoming
// NaN or a silently wrong limit (NaN would disable the rate limit / size cap
// downstream; -1 would reject or allow everything). An empty string would
// otherwise become 0 via Number('') === 0 — e.g. SMTP_PORT= would listen on a
// random port instead of the documented default.
const envNum = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// src/ -> project root/public (one level up, works both locally and in Docker /app)
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export default {
  web: {
    port: Number(env('PORT', 3000)),
    host: env('HOST', '0.0.0.0'),
    staticDir: publicDir,
  },
  smtp: {
    port: envNum('SMTP_PORT', 25),
    host: env('SMTP_HOST', '0.0.0.0'),
    banner: env('SMTP_BANNER', 'tempmail ready'),
    maxMailBytes: envNum('SMTP_MAX_MAIL_BYTES', 5 * 1024 * 1024),
    // concurrent SMTP sessions; each may buffer up to maxMailBytes
    maxConnections: envNum('SMTP_MAX_CONNECTIONS', 30),
    // max seconds of inactivity while receiving DATA (smtp-server default idle timeout is 60s)
    dataTimeoutMs: envNum('SMTP_DATA_TIMEOUT_MS', 30_000),
    // per-mailbox broadcast rate limit: mails forwarded to sockets per minute
    ratePerMinute: envNum('SMTP_RATE_PER_MIN', 20),
    // per-IP abuse guards: concurrent SMTP sessions and accepted mails per minute.
    // The 30-connection global pool is shared by everyone; without per-IP caps a
    // single host can occupy the whole pool (Phase 3 of the 2026-10 refactor).
    maxConnPerIp: envNum('SMTP_MAX_CONN_PER_IP', 6),
    maxMailsPerIpPerMin: envNum('SMTP_MAX_MAILS_PER_IP_MIN', 12),
    // reserved names that must never be claimed by visitors
    reservedNames: [
      'admin', 'administrator', 'postmaster', 'webmaster', 'hostmaster',
      'abuse', 'system', 'service', 'server', 'root', 'support', 'info',
      'security', 'noreply', 'no-reply', 'mail', 'mailer-daemon',
    ],
  },
  // offline replay buffer: mails are kept in memory so a browser that
  // reconnects (or claims a mailbox that just received mail) still sees them
  store: {
    ttlMs: envNum('MAIL_TTL_MINUTES', 30) * 60_000,
    maxMailsPerMailbox: envNum('MAIL_STORE_MAX_PER_MAILBOX', 20),
    // global byte budget across all mailboxes; soonest-to-expire box is
    // evicted first when exceeded (Phase 1 of the 2026-10 refactor)
    maxTotalBytes: envNum('MAIL_STORE_MAX_BYTES', 64 * 1024 * 1024),
  },
  realtime: {
    // global broadcast fuse: mail deliveries to sockets per second across all
    // mailboxes. Protects the event loop when someone sprays mail at thousands
    // of mailbox names at once (Phase 3 of the 2026-10 refactor).
    maxBroadcastsPerSec: envNum('REALTIME_MAX_BROADCASTS_SEC', 200),
  },
};
