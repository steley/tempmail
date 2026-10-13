import express from 'express';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('web');

export function createWebApp() {
  const app = express();

  // extra analytics origins for self-hosted/custom providers (space-separated)
  const rawExtra = String(process.env.ANALYTICS_CSP_EXTRA ?? '').trim();
  const cspExtra = rawExtra ? ' ' + rawExtra.split(/\s+/).join(' ') : '';
  const gaAllowed = process.env.ANALYTICS_DISABLED !== '1';

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // defense-in-depth headers; 'unsafe-inline' styles are for the page shell,
  // mail content itself is sandboxed in a script-less iframe
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // Analytics CSP: GA origins whitelisted by default.
      // Self-hosters: set ANALYTICS_DISABLED=1 to drop them, and/or
      // ANALYTICS_CSP_EXTRA="https://a.example.com https://b.example.com"
      // to whitelist another provider's origins (script-src + connect-src).
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
        "frame-src 'self'; " +
        "script-src 'self'" + (gaAllowed ? ' https://www.googletagmanager.com' : '') + cspExtra + '; ' +
        "connect-src 'self' ws: wss:" +
        (gaAllowed ? ' https://*.google-analytics.com https://*.analytics.google.com' : '') + cspExtra + ';',
    });
    next();
  });

  // Long immutable cache for fingerprint-able assets, revalidate-always for HTML.
  app.use(express.static(config.web.staticDir, {
    setHeaders: (res, filePath) => {
      if (/\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
    },
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).sendFile(path.join(config.web.staticDir, '404.html'), (err) => {
    if (err) res.status(404).end();
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`${req.method} ${req.url} -> 500:`, err.message);
    res.status(500).end();
  });

  return app;
}
