import { parentPort } from 'node:worker_threads';
import { simpleParser } from 'mailparser';

/**
 * Parser worker thread. mailparser's simpleParser is CPU-bound MIME parsing;
 * running it here keeps multi-megabyte messages off the main event loop so
 * WebSocket heartbeats, HTTP and SMTP I/O never stall behind a parse.
 *
 * Protocol (parent -> worker):  { id, raw: ArrayBuffer }
 *           (worker -> parent): { id, mail } | { id, error }
 * Messages are processed serially in this thread, which gives natural
 * backpressure: the parent's postMessage queue is the parse queue.
 */
parentPort.on('message', async ({ id, raw }) => {
  try {
    const parsed = await simpleParser(Buffer.from(raw));
    parentPort.postMessage({
      id,
      mail: {
        headers: {
          from: parsed.from?.text ?? 'unknown',
          to: parsed.to?.text ?? '',
          subject: parsed.subject ?? '',
          date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
        },
        // structured addresses from the parser — never regex the header
        // text: display names containing "@" (e.g. `"x@y" <real@z>`)
        // would otherwise route mail to a stranger's mailbox (audit fix)
        recipients: [parsed.to, parsed.cc]
          .flatMap((f) => (f?.value ?? []).map((a) => a.address))
          .filter(Boolean),
        html: parsed.html ?? null,
        text: parsed.text ?? '',
      },
    });
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message ?? 'parse failed' });
  }
});
