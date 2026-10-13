const env = (key, fallback) => process.env[key] ?? fallback;

export default {
  web: {
    port: Number(env('PORT', 3000)),
    host: env('HOST', '0.0.0.0'),
    staticDir: new URL('../../public/', import.meta.url).pathname,
    staticMaxAgeMs: 60 * 60 * 1000,
  },
  smtp: {
    port: Number(env('SMTP_PORT', 25)),
    host: env('SMTP_HOST', '0.0.0.0'),
    banner: env('SMTP_BANNER', 'tempmail ready'),
    maxMailBytes: Number(env('SMTP_MAX_MAIL_BYTES', 5 * 1024 * 1024)),
    // reserved names that must never be claimed by visitors
    reservedNames: [
      'admin', 'administrator', 'postmaster', 'webmaster', 'hostmaster',
      'abuse', 'system', 'service', 'server', 'root', 'support', 'info',
      'security', 'noreply', 'no-reply', 'mail', 'mailer-daemon',
    ],
  },
};
