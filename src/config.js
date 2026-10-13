import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (key, fallback) => process.env[key] ?? fallback;

// src/ -> project root/public (one level up, works both locally and in Docker /app)
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export default {
  web: {
    port: Number(env('PORT', 3000)),
    host: env('HOST', '0.0.0.0'),
    staticDir: publicDir,
    staticMaxAgeMs: 60 * 60 * 1000,
  },
  smtp: {
    port: Number(env('SMTP_PORT', 25)),
    host: env('SMTP_HOST', '0.0.0.0'),
    banner: env('SMTP_BANNER', 'tempmail ready'),
    maxMailBytes: Number(env('SMTP_MAX_MAIL_BYTES', 5 * 1024 * 1024)),
    // per-mailbox broadcast rate limit: mails forwarded to sockets per minute
    ratePerMinute: Number(env('SMTP_RATE_PER_MIN', 20)),
    // reserved names that must never be claimed by visitors
    reservedNames: [
      'admin', 'administrator', 'postmaster', 'webmaster', 'hostmaster',
      'abuse', 'system', 'service', 'server', 'root', 'support', 'info',
      'security', 'noreply', 'no-reply', 'mail', 'mailer-daemon',
    ],
  },
};
