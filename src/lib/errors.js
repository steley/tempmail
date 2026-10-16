/**
 * Central error-code catalog.
 *
 * Every user-visible failure carries a machine-readable `code` (E_*) plus a
 * human `message`. HTTP responses include the code via the `X-Error-Code`
 * header and (for JSON clients) the body; Socket.IO events carry both `code`
 * and `message`, so the frontend holds no copy of the wording. Unknown codes
 * fall back to E_INTERNAL on the client, so new codes can ship server-side
 * without a frontend deploy.
 *
 * Note: SMTP-layer failures used to be excluded here because the recipient
 * was only reliably known after DATA parsing. Oversize rejections now use the
 * SMTP envelope recipients (RCPT TO), which arrive before DATA — so the
 * recipient IS known and the user gets an E_MAIL_TOO_BIG notification.
 * Parse/stream errors still stay server-side logs (envelope may be garbage).
 */

export const ERROR_CODES = {
  // HTTP layer (these two are also used as status codes by web/app.js)
  E_NOT_FOUND: {
    status: 404,
    message: 'The page you are looking for does not exist or has moved.',
  },
  E_INTERNAL: {
    status: 500,
    message: 'Something went wrong on our side. Please try again.',
  },

  // notification-only codes: delivered to the browser over Socket.IO, never
  // as an HTTP status, so they carry a message but no `status`
  E_RATE_LIMITED: {
    message: 'Too many messages — some deliveries to this inbox were dropped for a minute.',
  },
  E_MAIL_TOO_BIG: {
    message: 'A mail was rejected because it exceeded the size limit (including attachments).',
  },
  E_SHORTID_INVALID: {
    message: 'Invalid name — use 1-32 letters, digits, . _ -',
  },
  E_SHORTID_RESERVED: {
    message: 'That name is reserved — pick another',
  },
  E_SHORTID_TAKEN: {
    message: 'That address is being used by someone else — pick another',
  },
};

export function errorInfo(code) {
  return ERROR_CODES[code] || ERROR_CODES.E_INTERNAL;
}
