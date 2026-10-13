import express from 'express';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('web');

export function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

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
