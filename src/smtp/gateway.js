import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { EventEmitter } from 'node:events';
import config from '../config.js';

const log = (msg, ...rest) => console.log(`[smtp] ${msg}`, ...rest);

/**
 * Inbound SMTP gateway. Replaces the abandoned `mailin` package.
 * Emits: 'mail' (parsedMail) for every accepted message.
 */
export function startSmtpGateway() {
  const gateway = new EventEmitter();

  const server = new SMTPServer({
    banner: config.smtp.banner,
    authOptional: true,
    disabledCommands: ['AUTH'], // inbound MX traffic only; nobody authenticates
    size: config.smtp.maxMailBytes,

    onRcptTo(address, session, cb) {
      // routing happens after DATA (see onData); accept any syntactically valid recipient
      cb();
    },

    onData(stream, session, cb) {
      const chunks = [];
      let size = 0;
      let tooBig = false;

      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.smtp.maxMailBytes) {
          tooBig = true;
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', async () => {
        if (tooBig) {
          const err = new Error('Message too big');
          err.responseCode = 552;
          return cb(err);
        }
        try {
          const raw = Buffer.concat(chunks);
          const parsed = await simpleParser(raw);
          gateway.emit('mail', {
            headers: {
              from: parsed.from?.text ?? 'unknown',
              to: parsed.to?.text ?? '',
              subject: parsed.subject ?? '',
              date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            },
            html: parsed.html ?? null,
            text: parsed.text ?? '',
          });
          log(`accepted mail (${size} bytes) from ${session.envelope.mailFrom?.address ?? '?'}`);
          cb();
        } catch (err) {
          log('parse error:', err.message);
          const perr = new Error('Unable to process message');
          perr.responseCode = 451;
          cb(perr);
        }
      });

      stream.on('error', (err) => {
        log('stream error:', err.message);
        cb(err);
      });
    },

    onError(err) {
      console.error('[smtp] server error:', err.message);
    },
  });

  server.listen(config.smtp.port, config.smtp.host, () => {
    log(`listening on ${config.smtp.host}:${config.smtp.port}`);
  });

  return gateway;
}
