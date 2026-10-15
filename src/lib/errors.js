/**
 * Central error-code catalog.
 *
 * Every user-visible failure carries a machine-readable `code` (E_*) plus a
 * human message. HTTP responses include the code via the `X-Error-Code`
 * header and (for JSON clients) the body; Socket.IO events carry `code`
 * alongside the legacy fields. Unknown codes fall back to E_INTERNAL on the
 * client, so new codes can ship server-side without a frontend deploy.
 *
 * Note: SMTP-layer failures used to be excluded here because the recipient
 * was only reliably known after DATA parsing. Oversize rejections now use the
 * SMTP envelope recipients (RCPT TO), which arrive before DATA — so the
 * recipient IS known and the user gets an E_MAIL_TOO_BIG notification.
 * Parse/stream errors still stay server-side logs (envelope may be garbage).
 */

import crypto from 'node:crypto';

export const ERROR_CODES = {
  // HTTP layer
  E_NOT_FOUND: {
    status: 404,
    message: 'The page you are looking for does not exist or has moved.',
  },
  E_INTERNAL: {
    status: 500,
    message: 'Something went wrong on our side. Please try again.',
  },
  E_RATE_LIMITED: {
    status: 429,
    message: 'Too many messages — some deliveries to this inbox were dropped for a minute.',
  },
  E_MAIL_TOO_BIG: {
    status: 413,
    message: 'A mail was rejected because it exceeded the size limit (including attachments).',
  },

  // shortid claim layer (Socket.IO)
  E_SHORTID_INVALID: {
    status: 400,
    message: 'Invalid name — use 1-32 letters, digits, . _ -',
  },
  E_SHORTID_RESERVED: {
    status: 409,
    message: 'That name is reserved — pick another',
  },
  E_SHORTID_TAKEN: {
    status: 409,
    message: 'That address is being used by someone else — pick another',
  },
};

export function errorInfo(code) {
  return ERROR_CODES[code] || ERROR_CODES.E_INTERNAL;
}

/** Short per-request id for correlating a user-visible 500 with server logs. */
export function newRequestId() {
  return crypto.randomUUID();
}

/** Legacy shortid reason -> new code, kept so old clients keep working. */
export const reasonToCode = {
  invalid: 'E_SHORTID_INVALID',
  reserved: 'E_SHORTID_RESERVED',
  taken: 'E_SHORTID_TAKEN',
};
