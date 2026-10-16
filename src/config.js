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
    // reserved names that must never be claimed by visitors
    reservedNames: [
      'admin', 'administrator', 'postmaster', 'webmaster', 'hostmaster',
      'abuse', 'system', 'service', 'server', 'root', 'support', 'info',
      'security', 'noreply', 'no-reply', 'mail', 'mailer-daemon',
    ],
  },
};
