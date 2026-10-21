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
over SMTP; browsers listen over WebSocket. Neither path waits on the other.

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

A browser claims a name (`request shortid` or `set shortid`), the server maps
`mailbox → sockets`, and every accepted mail for that name is pushed to the
socket immediately. Mail is also kept for `MAIL_TTL_MINUTES` so a browser that
reconnects, or claims the name a few seconds late, still receives it — the
replay is flushed as `mail history` right after the claim is acked.

**No database, no queue, no external service.** State lives in the process;
this is what makes a single binary able to serve it, and also the reason it
does not scale horizontally (see [Capacity and memory](#capacity-and-memory)).

## Architecture

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
scripts/e2e.mjs          end-to-end delivery test
scripts/smoke-socket.mjs realtime-layer smoke test
scripts/hash-assets.mjs  content-fingerprint ?v= stamps in HTML before deploy
```

## Wire protocol

The protocol is unchanged from the original forsaken-mail, with additive
events only — an old client ignores what it does not know. Transport is
Socket.IO over WebSocket (polling fallback is enabled by default).

### Client → server

| Event | Arguments | Effect |
|---|---|---|
| `request shortid` | `clientToken?: string` | Allocate a fresh random mailbox, claim it |
| `set shortid` | `name: string, clientToken?: string` | Claim a specific name; rejected unless valid, unreserved, and either free or held by the same token |
| `recover` | `token: string, clientToken?: string` | Reclaim the mailbox behind a recovery token, **kicking current listeners** |
| `delete mail` | `mailId: number, ack?: (res) => void` | Remove one mail from the caller's own mailbox; ack gets `{ ok: boolean }` |

### Server → client

| Event | Payload |
|---|---|
| `shortid` | `name: string` — the mailbox now bound to this socket |
| `shortid rejected` | `{ name, code, message }` |
| `boot` | `{ id: string }` — process boot id; if it changes, the in-memory store is gone and clients reset their list |
| `mail` | `{ _id, headers: { from, to, subject, date }, recipients: string[], html, text }` |
| `mail history` | `Mail[]` — replay buffer, emitted once right after a claim |
| `mail deleted` | `{ id: number }` — broadcast to every socket on that mailbox |
| `recovery` | `{ token, expiresAt }` |
| `recovery rejected` | `{ message }` |
| `server error` | `{ code, message }` — notification only, the socket stays open |

### Error codes

| Code | Where | Meaning |
|---|---|---|
| `E_SHORTID_INVALID` | claim | Name failed the allowlist (1–32 chars of `a-z0-9._-`, no leading/trailing `.` or `-`) |
| `E_SHORTID_RESERVED` | claim | Name is in the reserved list (`admin`, `postmaster`, …) |
| `E_SHORTID_TAKEN` | claim | Another live socket holds it and the presented token is not an owner token |
| `E_RATE_LIMITED` | notification | Per-mailbox notification budget exhausted for this minute |
| `E_MAIL_TOO_BIG` | notification | A mail was cut mid-DATA for exceeding `SMTP_MAX_MAIL_BYTES` |
| `E_NOT_FOUND` / `E_INTERNAL` | HTTP | Also returned as `X-Error-Code`; JSON clients get `{ ok, code, message }` |

User-facing wording lives server-side in `src/lib/errors.js` — the frontend
holds no copy of it, and a new code ships without a frontend deploy (unknown
codes degrade to `E_INTERNAL` client-side).

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
| `SMTP_RATE_PER_MIN` | 20      | per-mailbox **notification** budget (oversize/error events). Real mail is never dropped here — see [Design notes](#design-notes) |
| `SMTP_MAX_CONN_PER_IP` | 6    | concurrent SMTP connections per client IP |
| `SMTP_MAX_MAILS_PER_IP_MIN` | 12 | accepted mails per client IP per minute |
| `MAIL_TTL_MINUTES` | 30       | how long mails stay in the replay buffer (also governs recovery-token lifetime) |
| `MAIL_STORE_MAX_PER_MAILBOX` | 20 | mails kept per mailbox in the replay buffer |
| `MAIL_STORE_MAX_BYTES` | 67108864 | global replay-buffer byte budget |
| `REALTIME_MAX_BROADCASTS_SEC` | 200 | global socket-broadcast fuse (per second) |
| `ANALYTICS_DISABLED` | (unset) | set to `1` to drop Google Analytics origins from the CSP |
| `ANALYTICS_CSP_EXTRA` | (unset) | space-separated origins to whitelist for your own analytics provider (script-src + connect-src) |

## Capacity and memory

Everything is in one process, so capacity is a memory question. The three
buckets that matter:

| Bucket | Bound by | Default |
|---|---|---|
| Node + express + socket.io | — | roughly 40–60 MB |
| Replay buffer | `MAIL_STORE_MAX_BYTES` | 64 MB (global, all mailboxes) |
| SMTP session buffers | `SMTP_MAX_CONNECTIONS × SMTP_MAX_MAIL_BYTES` | 30 × 5 MB = **150 MB worst case** |

**The defaults do not fit in a 256 MB container.** 64 + 150 + base overhead
exceeds it. Either raise the container limit or lower the mail caps — for a
256 MB box something like `SMTP_MAX_MAIL_BYTES=1048576` with
`SMTP_MAX_CONNECTIONS=16` (16 MB worst case, 64 MB store) leaves comfortable
headroom. Mail is dropped from the replay buffer, in this order, when limits
are hit: oldest mail in the box past `MAIL_STORE_MAX_PER_MAILBOX`, then the
soonest-to-expire mailbox when the global byte budget is exceeded. Live
delivery to connected sockets is not affected by either.

Mailbox names are 8 chars from a 31-symbol alphabet (`31⁸ ≈ 8.5 × 10¹¹`,
~39.6 bits), chosen with rejection sampling so the distribution is flat.
Collisions are not a practical concern at any realistic mailbox count; when
one does occur, the claim is refused with `E_SHORTID_TAKEN` rather than
silently sharing an inbox.

### Scaling

**This does not scale horizontally.** Sockets, the replay buffer, and recovery
tokens all live in the process that owns them. Running two replicas behind a
load balancer breaks in ways that are hard to diagnose:

- a sender's MX points at one host, so mail lands on whichever replica the
  connection reached — a browser on the other replica never sees it
- Socket.IO's Redis adapter would fan out *events*, but the replay buffer is
  still per-process, so a reconnect that lands elsewhere loses the history
- recovery tokens are in-memory only: a token issued by replica A is unknown
  to replica B

Vertical scaling (more memory, bigger `MAIL_STORE_MAX_BYTES`) is the
supported path. True horizontal scaling needs a shared mail store and a
cross-process pub/sub layer, and would change the eviction and delivery
guarantees described above — it is not a configuration change.

## Recovery links

After a mailbox is claimed, the server issues a high-entropy recovery token
(64 hex chars, in-memory only) and sends it via the `recovery` socket event.
The frontend surfaces it as a copyable `https://…/?r=TOKEN` link.

- Opening `/?r=TOKEN` reclaims that mailbox — with its replay-buffered mail —
  on any device, until the token expires.
- Tokens live exactly as long as the replay buffer (`MAIL_TTL_MINUTES`): when
  the mail is gone, the link is void. No persistence, no accounts.
- The token is authoritative: a device presenting a valid token takes over the
  mailbox and kicks current listeners. Whoever holds the link owns the inbox
  within its TTL — treat recovery links like a password.
- Invalid tokens are answered with `recovery rejected`; clients fall back to a
  fresh mailbox.

## Security model

Be clear about what this is: **a public inbox, not a private one.** The
mailbox name is the only credential for reading live mail. Anyone who knows
`h7k2mq9x@your.domain` can claim it and read what arrives. That is the
product, and it is unchanged from the original — do not send anything to a
disposable address that you would mind a stranger reading.

What *is* defended:

- **Mail HTML is rendered in a sandboxed iframe** with `allow-popups` only —
  no `allow-scripts`, no `allow-same-origin`. Scripts in a mail do not run and
  cannot reach the page's storage or cookies. Links open in a new tab.
- **Recovery tokens are 256-bit** (two UUIDv4s, hex) and stored in memory
  only. Whoever holds one owns that inbox until it expires, so treat a
  recovery link like a password.
- **Routing uses parsed addresses, never the raw `To:` header text.** Display
  names can contain `@` (`"x@y" <real@localhost>`); matching on header text
  would deliver a copy to a stranger's mailbox.
- **A socket can only delete mail in its own mailbox** — `delete mail` is
  scoped to `socket.data.mailbox`, never to a client-supplied name.
- **Per-IP guards** on concurrent SMTP sessions and accepted mail per minute,
  plus a global broadcast fuse, bound the damage one host can do.

Known limits, stated plainly:

- **Inbound SMTP is plaintext.** `AUTH` and `STARTTLS` are disabled because
  this only accepts MX traffic and nobody authenticates; the consequence is
  that a sending MTA cannot upgrade the connection to TLS. Mail is in the
  clear between the sender and this host.
- **Remote images in mail load by default** (`img-src … https:`), so a sender
  can tell when their mail was opened via a tracking pixel. Blocking them
  would break most real-world mail; accept or change it deliberately.
- **Any recipient is accepted at RCPT time** — routing happens after DATA.
  There is no per-mailbox existence check, by design (the mailbox does not
  exist until somebody claims it).

## Design notes

Short answers to the "why is it written like that" questions, because several
of these look like bugs until you know the failure they prevent.

**Rejection sampling for mailbox names.** `byte % 31` is biased — 8 of the
256 byte values map to the first 8 letters, so naive modulo makes those
letters measurably more likely and shaves real entropy off the name. Bytes
`>= 248` are discarded instead.

**MIME parsing in a worker thread.** A 5 MB mail with a base64 attachment is
hundreds of milliseconds of CPU-bound work. Parsed on the main thread, that
stalls WebSocket heartbeats and HTTP for every user. The worker also gets a
private `ArrayBuffer` copy of the message: `Buffer.concat` can return a view
into Node's shared buffer pool, and transferring `raw.buffer` would detach
that pool for every `Buffer` in the process.

**Rate limiting notifications, not mail.** When a mailbox is flooded, capping
deliveries would let an attacker's junk hide a user's verification code while
SMTP still answers `250`. A visible flood is better than an invisible loss,
so `mail` events bypass the per-mailbox budget entirely and only
machine-generated notices are throttled.

**A global broadcast fuse.** Per-mailbox limits do not help against mail
sprayed across thousands of different names — each mailbox looks quiet. The
fuse counts *all* emits in a rolling second (default 200) and trips only
under cross-mailbox floods. A single quiet mailbox never gets near it.

**Ownership tokens distinguish a reconnect from a stranger.** Without them,
a zombie socket (the server has not reaped the old connection yet — ping
timeout up to ~25 s) would make the same browser's reload look like an
intruder. With them, the same token takes over and kicks the zombie, while a
different token gets `E_SHORTID_TAKEN`.

**Reclaim rights outlive the socket, on purpose.** On disconnect, the socket
is removed from the mailbox but the owners and the recovery token are kept —
otherwise a saved recovery link would stop working the moment the tab closed.
Both are cleaned up by the TTL sweep, not by `disconnect`.

**Store before broadcast.** `store.put()` is a synchronous in-memory write
that runs first; the broadcast follows. Nothing about the replay buffer can
delay live delivery, and a mailbox always has its history entry by the time
sockets are notified.

**`keepAliveTimeout` above the CDN reuse window.** 90 s here, 95 s for
`headersTimeout`. Shorter than the edge's connection reuse window, every
request would pay a new TCP/TLS handshake to the origin.

## Test
```bash
PORT=3100 SMTP_PORT=2525 npm start &   # in one terminal
node scripts/e2e.mjs                   # in another
SMOKE_URL=http://127.0.0.1:3100 node scripts/smoke-socket.mjs   # realtime-layer smoke test
```

Both scripts exit non-zero on failure and are safe to run against a live
instance (they use throwaway mailbox names). What they cover:

| Script | Assertion |
|---|---|
| `e2e.mjs` | A: a mail sent to one mailbox reaches its live WebSocket listener with intact headers |
| `e2e.mjs` | B: `To: "x@y" <real@localhost>` delivers **only** to `real@localhost` — a mailbox named after the display name receives nothing (regression test for text-regex routing) |
| `smoke-socket.mjs` | `request shortid` returns a fresh, valid name |
| `smoke-socket.mjs` | the same token reconnecting reclaims the mailbox and kicks the old socket |
| `smoke-socket.mjs` | a different token is rejected with `E_SHORTID_TAKEN` |

Not covered by automated tests: per-IP rate guards, oversize rejection, the
broadcast fuse, and TTL eviction. Those need a load generator or a clock
you can move, and are currently verified by hand.

There is no lint and no unit-test runner — the suite is these two scripts
plus `node --check` on the client bundle.

## Analytics

All page tracking lives in a single file: `public/js/ga.js` (Google Analytics 4,
IP anonymized). Self-hosting? Replace it with your own tracking code or blank it
out — no HTML edits needed.

The server CSP only whitelists Google's analytics origins by default. To use a
different provider:

1. Replace `public/js/ga.js` with your provider's snippet.
2. Whitelist its origins via `ANALYTICS_CSP_EXTRA`, e.g.:
   - **Plausible**: `ANALYTICS_CSP_EXTRA=https://plausible.io`
   - **Umami** (self-hosted): `ANALYTICS_CSP_EXTRA=https://umami.example.com`
   - **Matomo** (self-hosted): `ANALYTICS_CSP_EXTRA=https://matomo.example.com`
   - **Cloudflare Web Analytics**: `ANALYTICS_CSP_EXTRA=https://static.cloudflareinsights.com https://cloudflareinsights.com`
3. Using none at all? Set `ANALYTICS_DISABLED=1` to strip the Google origins
   from the CSP too.

## Deployment notes

- Port 25 must be reachable directly (MX record → this host). No CDN/proxy for mail; web may sit behind Cloudflare/nginx.
- **Run exactly one instance.** State is in-process; replicas split mail and
  lose replay history. See [Scaling](#scaling) and
  [Capacity and memory](#capacity-and-memory) before choosing a container size.
- Design caveat, unchanged from the original: anyone may `set shortid` to any
  valid name and read that mailbox's live mail. That is the product — see
  [Security model](#security-model).
- Abuse guards: per-IP SMTP connection and mail-rate caps, a per-mailbox
  **notification** budget (`SMTP_RATE_PER_MIN` — real mail is never throttled),
  a global broadcast fuse, security headers (CSP, X-Frame-Options) on the web
  app, and graceful SMTP shutdown on restart.

## Docker deployment (from git clone to running)

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
