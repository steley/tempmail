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
 *  - Mail is written here AFTER the realtime broadcast, so the store can
 *    never delay or block live delivery. Losing the store only loses the
 *    replay buffer, never live mail.
 *  - Boxes survive socket disconnect (that is the point) and are swept by
 *    a timer at ttl/4 granularity.
 */
export function createMailboxStore({ ttlMs, maxMailsPerMailbox, maxTotalBytes }) {
  // mailbox name -> { mails: [], bytes, expireAt }
  const boxes = new Map();
  let totalBytes = 0;

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
    sweep,
    stats: () => ({ mailboxes: boxes.size, bytes: totalBytes }),
    close: () => clearInterval(timer),
  };
}
