# tempmail-v2

Temporary email service with live inbox over WebSocket. Full rewrite of
forsaken-mail (2015-era Node.js) with a modern, dependency-clean stack.

## Architecture

```
src/
├── server.js            entry point: http + express + socket.io + smtp
├── config.js            env-driven configuration
├── lib/id.js            mailbox name generation & validation (allowlist)
├── smtp/gateway.js      inbound SMTP (smtp-server + mailparser)
├── realtime/inbox.js    socket.io layer, mailbox -> sockets registry
└── web/app.js           express static hosting + healthz
public/                  frontend (vanilla JS, unchanged wire protocol)
scripts/e2e.mjs          end-to-end delivery test
```

## Key changes vs the old codebase

- **`mailin` (abandoned since 2017) replaced** with `smtp-server` + `mailparser`.
- **Memory leak fixed**: dead sockets are removed from the registry on disconnect.
- **Mailbox names validated by allowlist** (`/^[a-z0-9](...)$/`), reserved names
  (admin, root, ...) can never be claimed. Old code only had a keyword blacklist.
- **ES modules**, Node >= 20, no body-parser/shortid/old socket.io 1.x.
- **Message size cap** (default 5 MB, `SMTP_MAX_MAIL_BYTES`), oversize rejected with 552.
- Socket.io 4 — frontend loads the matching client from `/socket.io/socket.io.js`.

Wire protocol (unchanged from the original, so the refreshed frontend works as-is):

```
client -> server: 'request shortid' | 'set shortid'
server -> client: 'shortid' (name) | 'mail' ({ headers, html, text })
```

## Run

```bash
npm install
npm start                     # web on :3000, smtp on :25
PORT=8080 SMTP_PORT=2525 npm start   # dev-friendly ports
```

## Environment variables

| Variable            | Default | Description                     |
|---------------------|---------|---------------------------------|
| `PORT`              | 3000    | web port                        |
| `HOST`              | 0.0.0.0 | web bind address                |
| `SMTP_PORT`         | 25      | inbound SMTP port               |
| `SMTP_HOST`         | 0.0.0.0 | SMTP bind address               |
| `SMTP_MAX_MAIL_BYTES` | 5242880 | max accepted message size    |

## Test

```bash
PORT=3100 SMTP_PORT=2525 npm start &   # in one terminal
node scripts/e2e.mjs                   # in another
```

## Deployment notes

- Port 25 must be reachable directly (MX record → this host). No CDN/proxy in front.
- Docker: `docker build -t tempmail-v2 . && docker run -p 25:25 -p 3000:3000 tempmail-v2`
- Inherent design caveat (unchanged from the original): anyone may `set shortid`
  to any valid name and receive that mailbox's live mail. That is the product.
