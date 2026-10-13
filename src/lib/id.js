import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i/l/o/0/1 — fewer transcription errors

/** Short, lowercase, unambiguous mailbox name, e.g. "h7k2mq9x" */
export function newMailboxName(length = 8) {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
  return id;
}

/** Allowlist: 1-32 chars of a-z0-9 . _ - , no leading/trailing dot or dash */
export function isValidMailboxName(name) {
  return typeof name === 'string'
    && /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(name);
}
