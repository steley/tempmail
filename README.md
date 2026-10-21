# Tempmail

English | [中文](README.zh-CN.md)

Temporary email service with live inbox over WebSocket. Full rewrite of
forsaken-mail (2015-era Node.js) with a modern, dependency-clean stack.

<p align="center">
  <img src="docs/screenshot.png" alt="TempMail.cc — temporary email inbox with real-time delivery" width="800">
</p>

## Demo

The production instance is live at **[tempmail.cc](https://tempmail.cc/)** —
open it and a disposable inbox is ready instantly, no sign-up.

## How it works

Two independent paths that meet in one in-memory mailbox store. Mail arrives
over SMTP and is parsed in a worker thread; browsers listen over WebSocket.
Mail is also kept in memory for `MAIL_TTL_MINUTES`, so a browser that
reconnects — or claims the name a few seconds late — still receives it as a
`mail history` replay.

**No database, no queue, no external service.** State lives in the process;
this is what makes a single binary able to serve it, and also the reason it
does not scale horizontally. See [docs/operations.md](docs/operations.md).

```
   sender's MTA                        browser
        │                                 │
        │ SMTP :25                        │ HTTPS + WebSocket
        ▼                                 ▼
┌──────────────────┐              ┌──────────────────┐
│ smtp/gateway.js  │              │ realtime/inbox   │
│  per-IP guards   │              │  claim / release │
│  size cap        │              │  broadcast fuse  │
└────────┬─────────┘              └────────▲─────────┘
         │ raw bytes                       │ 'mail' event
         ▼                                 │
┌──────────────────┐                      │
│ parser-worker.js │  worker thread       │
│  MIME → {headers,│  (never blocks       │
│   html, text}    │   the event loop)    │
└────────┬─────────┘                      │
         │ parsed mail                    │
         └──────────►┌────────────────┐───┘
                     │ mailbox-store  │  in-memory replay buffer
                     │  TTL + caps    │  survives socket disconnects
                     └────────────────┘
```

```
src/
├── server.js            entry point: http + express + socket.io + smtp
├── config.js            env-driven configuration
├── lib/id.js            mailbox name generation & validation (allowlist)
├── smtp/gateway.js      inbound SMTP (smtp-server) + per-IP abuse guards
├── smtp/parser-worker.js MIME parsing in a worker thread (never blocks the event loop)
├── store/mailbox-store.js in-memory replay buffer (30-min TTL) for reconnecting browsers
├── realtime/inbox.js    socket.io layer, mailbox -> sockets registry
└── web/app.js           express static hosting + healthz
public/                  frontend (vanilla JS, unchanged wire protocol)
scripts/                 e2e + smoke tests, asset fingerprinting
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
| `SMTP_BANNER`       | `tempmail ready` | greeting line sent on connect |
| `SMTP_MAX_MAIL_BYTES` | 5242880 | max accepted message size; larger mail is cut mid-DATA and the watcher is notified |
| `SMTP_MAX_CONNECTIONS` | 30 | concurrent SMTP sessions (global pool; each may buffer up to `SMTP_MAX_MAIL_BYTES`) |
| `SMTP_DATA_TIMEOUT_MS` | 30000 | kick sessions that stall mid-DATA |
| `SMTP_RATE_PER_MIN` | 20      | per-mailbox **notification** budget (oversize/error events). Real mail is never dropped here |
| `SMTP_MAX_CONN_PER_IP` | 6    | concurrent SMTP connections per client IP |
| `SMTP_MAX_MAILS_PER_IP_MIN` | 12 | accepted mails per client IP per minute |
| `MAIL_TTL_MINUTES` | 30       | how long mails stay in the replay buffer (also governs recovery-token lifetime) |
| `MAIL_STORE_MAX_PER_MAILBOX` | 20 | mails kept per mailbox in the replay buffer |
| `MAIL_STORE_MAX_BYTES` | 67108864 | global replay-buffer byte budget |
| `REALTIME_MAX_BROADCASTS_SEC` | 200 | global socket-broadcast fuse (per second) |
| `ANALYTICS_DISABLED` | (unset) | set to `1` to drop Google Analytics origins from the CSP |
| `ANALYTICS_CSP_EXTRA` | (unset) | space-separated origins to whitelist for your own analytics provider (script-src + connect-src) |

## Test

```bash
PORT=3100 SMTP_PORT=2525 npm start &   # in one terminal
node scripts/e2e.mjs                   # end-to-end delivery
SMOKE_URL=http://127.0.0.1:3100 node scripts/smoke-socket.mjs   # realtime layer
```

Both scripts exit non-zero on failure and are safe to run against a live
instance (they use throwaway mailbox names). There is no lint and no
unit-test runner — the suite is these two scripts plus `node --check`.

## Deployment notes

- Port 25 must be reachable directly (MX record → this host). No CDN/proxy for mail; web may sit behind Cloudflare/nginx.
- **Run exactly one instance.** State is in-process; replicas split mail and lose replay history. See [docs/operations.md](docs/operations.md).
- Design caveat, unchanged from the original: anyone may `set shortid` to any valid name and read that mailbox's live mail. That is the product — see [docs/security.md](docs/security.md).

### Docker deployment (from git clone to running)

Requires: a server (Ubuntu shown) with Docker installed (`curl -fsSL https://get.docker.com | sh`),
DNS: A record of your mail domain → server IP, MX record → that domain.

```bash
# 1. clone & build
git clone <repo-url> /var/www/tempmail
cd /var/www/tempmail
docker build -t tempmail .

# 2. run (restarts on reboot/crash)
docker run -d --name tempmail \
  -p 3000:3000 \
  -p 25:25 \
  --restart unless-stopped \
  tempmail

# 3. verify
curl localhost:3000/healthz      # {"ok":true}
docker logs -f tempmail          # structured logs; SMTP should log "listening on 0.0.0.0:25"
```

### Fronting the web UI with nginx (optional, mail stays direct)

Only web traffic goes through nginx; SMTP :25 must point straight at the host.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name your.domain;

    ssl_certificate     /etc/letsencrypt/live/your.domain/fullchain.pem;   # certbot
    ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket — required for the live inbox
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/your.domain /etc/nginx/sites-enabled/your.domain
nginx -t && systemctl reload nginx
```

Behind Cloudflare: leave proxying on for web (A record orange-cloud); WebSocket
must be enabled (Network settings). DNS-only (grey cloud) the record if you serve
mail UI elsewhere — MX record itself must never point at a proxy.

### Updating

```bash
git pull
node scripts/hash-assets.mjs   # re-stamp ?v= fingerprints on changed assets
docker rm -f tempmail
docker build -t tempmail .
docker run -d --name tempmail -p 3000:3000 -p 25:25 --restart unless-stopped tempmail
```

### Troubleshooting

| Symptom | Check |
|---------|-------|
| `port 25 already allocated` on `docker run` | old container still bound: `docker ps -a \| grep 25`, then `docker rm -f <name>` |
| Site 404 through the whole stack | verify origin directly: `curl -sI http://127.0.0.1:3000/` — if 404 there, rebuild the image from latest code |
| Page loads but inbox stuck "Connecting…" | WS handshake: `curl -s "https://your.domain/socket.io/?EIO=4&transport=polling"` must return `0{"sid":...}`; if it does, hard-refresh — browser/CF is serving stale frontend JS |
| Mail accepted in logs but never shown | recipient local part must match the claimed mailbox name; check `[smtp] accepted mail` lines in `docker logs` |
| `nginx recv() failed (104)` spikes | container restarting — `docker ps` for restart loop, then `docker logs tempmail` |

## Further documentation

- [docs/protocol.md](docs/protocol.md) — Socket.IO wire protocol and error codes
- [docs/operations.md](docs/operations.md) — memory sizing, scaling limits, recovery links
- [docs/security.md](docs/security.md) — security model and the reasoning behind the design

Analytics: all page tracking lives in `public/js/ga.js` (GA4, IP anonymized).
Self-hosting? Replace or blank that file — no HTML edits needed. Other
providers go through `ANALYTICS_CSP_EXTRA` (e.g. `https://plausible.io`).
