# Wire protocol

The protocol is unchanged from the original forsaken-mail, with additive
events only — an old client ignores what it does not know. Transport is
Socket.IO over WebSocket (polling fallback is enabled by default).

## Client → server

| Event | Arguments | Effect |
|---|---|---|
| `request shortid` | `clientToken?: string` | Allocate a fresh random mailbox, claim it |
| `set shortid` | `name: string, clientToken?: string` | Claim a specific name; rejected unless valid, unreserved, and either free or held by the same token |
| `recover` | `token: string, clientToken?: string` | Reclaim the mailbox behind a recovery token, **kicking current listeners** |
| `delete mail` | `mailId: number, ack?: (res) => void` | Remove one mail from the caller's own mailbox; ack gets `{ ok: boolean }` |

## Server → client

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

## Error codes

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
