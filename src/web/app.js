import express from 'express';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';
import { errorInfo, newRequestId } from '../lib/errors.js';

const log = createLogger('web');

// JSON clients (API/scripts) get a structured error body; browsers get pages.
const wantsJson = (req) => (req.headers.accept || '').includes('application/json');

function sendErrorPage(res, req, code) {
  const info = errorInfo(code);
  res.set('X-Error-Code', code);
  if (wantsJson(req)) {
    res.status(info.status).json({ ok: false, code, message: info.message });
    return;
  }
  const file = code === 'E_NOT_FOUND' ? '404.html' : null;
  if (!file) {
    // bare 500 previously showed the browser default page — keep it minimal
    // but at least labeled, so users can report the code
    res.status(info.status).type('html').send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${info.status} — TempMail.cc</title>` +
      `<body style="font:16px/1.6 system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px">` +
      `<h1>${info.status}</h1><p>${info.message}</p>` +
      `<p style="color:#888">Error code: <code>${code}</code> &middot; Request ID: <code>${res.locals.requestId}</code></p>` +
      `<p><a href="/">Back to your inbox</a></p></body></html>`);
    return;
  }
  res.status(info.status).sendFile(path.join(config.web.staticDir, file), (err) => {
    if (err) res.status(info.status).type('html').send(`<h1>${info.status}</h1><p>Error code: ${code}</p>`);
  });
}

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
        (gaAllowed ? ' https://*.google-analytics.com https://*.analytics.google.com' : '') + cspExtra + '; ' +
        "worker-src 'self'; manifest-src 'self';",
    });
    next();
  });

  // Long immutable cache for fingerprint-able assets. HTML revalidates in the
  // browser (max-age=0) but is cached at the CDN edge (s-maxage) so visitors
  // get edge hits instead of a round trip to the origin on every page view.
  // Deploys change HTML content -> remember to purge the CDN cache afterwards.
  app.use(express.static(config.web.staticDir, {
    setHeaders: (res, filePath) => {
      // The service worker script must revalidate on every load — a stale SW
      // would keep serving an old app long after a deploy.
      if (/sw\.js$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, must-revalidate');
      }
    },
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => sendErrorPage(res, req, 'E_NOT_FOUND'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const requestId = newRequestId();
    res.locals.requestId = requestId;
    log.error(`${req.method} ${req.url} -> 500 [${requestId}]:`, err.message);
    sendErrorPage(res, req, 'E_INTERNAL');
  });

  return app;
}
