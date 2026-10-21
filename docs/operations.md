# Operations: capacity, scaling, recovery links

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

## Scaling

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
