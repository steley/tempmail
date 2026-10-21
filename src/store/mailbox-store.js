import { createLogger } from '../lib/logger.js';

const log = createLogger('store');

/**
 * In-memory mailbox store with TTL — closes the "disconnect = lost mail" gap
 * without any external dependency.
 *
 * Design constraints:
 *  - Per-mailbox cap (mail count) AND a global byte budget. A 5 MB mail is
 *    welcome live, but 20 of them cached per mailbox across hundreds of
 *    mailboxes would blow the heap — so the global budget evicts the
 *    soonest-to-expire mailbox when exceeded.
 *  - put() is a synchronous in-memory write that runs BEFORE the realtime
 *    broadcast (see the 'mail' handler in realtime/inbox.js). Being
 *    synchronous and allocation-only, it cannot delay or block live
 *    delivery; running first means a mailbox with no live socket still has
 *    its replay entry before any listener is notified. Losing the store
 *    only loses the replay buffer, never live mail.
 *  - Boxes survive socket disconnect (that is the point) and are swept by
 *    a timer at ttl/4 granularity.
 */
export function createMailboxStore({ ttlMs, maxMailsPerMailbox, maxTotalBytes }) {
  // mailbox name -> { mails: [], bytes, expireAt }
  const boxes = new Map();
  let totalBytes = 0;
  let nextMailId = 1; // process-wide unique id for manual delete round-trips

  const byteSize = (mail) =>
    (mail.text?.length ?? 0) + (mail.html?.length ?? 0) +
    JSON.stringify(mail.headers ?? {}).length;

  const dropOldestMail = (box) => {
    const mail = box.mails.shift();
    if (!mail) return;
    box.bytes -= byteSize(mail);
    totalBytes -= byteSize(mail);
  };

  const evictSoonestExpiry = () => {
    let oldestName = null;
    let oldestAt = Infinity;
    for (const [name, box] of boxes) {
      if (box.expireAt < oldestAt) { oldestAt = box.expireAt; oldestName = name; }
    }
    if (oldestName) remove(oldestName);
  };

  function remove(name) {
    const box = boxes.get(name);
    if (!box) return;
    totalBytes -= box.bytes;
    boxes.delete(name);
  }

  const put = (name, mail) => {
    let box = boxes.get(name);
    if (!box) boxes.set(name, (box = { mails: [], bytes: 0, expireAt: 0 }));
    // id is assigned here (store is the single source of truth) so live
    // broadcasts and history replays carry the same id
    mail._id = nextMailId++;
    const size = byteSize(mail);

    while (box.mails.length >= maxMailsPerMailbox) dropOldestMail(box);
    // a single mail larger than the whole budget would thrash the store
    if (size > maxTotalBytes) return;
    box.mails.push(mail);
    box.bytes += size;
    totalBytes += size;
    box.expireAt = Date.now() + ttlMs;

    while (totalBytes > maxTotalBytes) {
      evictSoonestExpiry();
      if (boxes.size === 0) break; // safety against accounting drift
    }
  };

  const take = (name) => {
    const box = boxes.get(name);
    return box ? box.mails.slice() : [];
  };

  // manual delete: remove one mail by its store-assigned id.
  // Returns true if it was found and removed. The box keeps its original
  // TTL — deleting the last mail does not extend the mailbox's lifetime.
  const removeMail = (name, mailId) => {
    const box = boxes.get(name);
    if (!box || !Number.isInteger(mailId)) return false;
    const i = box.mails.findIndex((m) => m._id === mailId);
    if (i === -1) return false;
    const size = byteSize(box.mails[i]);
    box.mails.splice(i, 1);
    box.bytes -= size;
    totalBytes -= size;
    return true;
  };

  const sweep = () => {
    const now = Date.now();
    for (const [name, box] of boxes) {
      if (box.expireAt <= now) remove(name);
    }
  };
  const timer = setInterval(sweep, Math.max(5_000, ttlMs / 4));
  timer.unref();

  return {
    put,
    take,
    removeMail,
    sweep,
    stats: () => ({ mailboxes: boxes.size, bytes: totalBytes }),
    close: () => clearInterval(timer),
  };
}
