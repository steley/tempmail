import express from 'express';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('web');

export function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // defense-in-depth headers; 'unsafe-inline' styles are for the page shell,
  // mail content itself is sandboxed in a script-less iframe
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
        "frame-src 'self'; script-src 'self'; connect-src 'self' ws: wss:;",
    });
    next();
  });

  app.use(express.static(config.web.staticDir, { maxAge: config.web.staticMaxAgeMs }));

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
