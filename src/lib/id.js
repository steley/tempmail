import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i/l/o/0/1 — fewer transcription errors
const BASE = ALPHABET.length; // 31 — prime-adjacent, so plain modulo is biased (256 % 31 = 8)
const REJECT_ABOVE = Math.floor(256 / BASE) * BASE; // 248: bytes >= 248 are discarded

/**
 * Short, lowercase, unambiguous mailbox name, e.g. "h7k2mq9x".
 * Uses rejection sampling: a naive `byte % 31` makes the first 8 letters of
 * the alphabet measurably more likely, shaving real entropy off the name.
 */
export function newMailboxName(length = 8) {
  for (;;) {
    let id = '';
    for (const byte of randomBytes(length + 8)) { // +8 slack keeps the retry loop rare
      if (byte >= REJECT_ABOVE) continue;
      id += ALPHABET[byte % BASE];
      if (id.length === length) return id;
    }
  }
}

/** Allowlist: 1-32 chars of a-z0-9 . _ - , no leading/trailing dot or dash */
export function isValidMailboxName(name) {
  return typeof name === 'string'
    && /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(name);
}
