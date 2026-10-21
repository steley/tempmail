# Security model and design notes

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
