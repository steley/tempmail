/**
 * End-to-end delivery test: drive the SMTP gateway with a hand-rolled
 * conversation and assert the mail reaches a live WebSocket mailbox.
 *
 * Run against a server already listening (see README "Test"):
 *   PORT=3100 SMTP_PORT=2525 npm start &
 *   node scripts/e2e.mjs
 */
import { io } from 'socket.io-client';
import { connect } from 'node:net';

const WEB = process.env.E2E_WEB_URL || 'http://localhost:3100';
const SMTP = { host: '127.0.0.1', port: Number(process.env.E2E_SMTP_PORT || 2525) };
const MBOX = 'tester' + Date.now().toString(36);

const bail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const deadline = setTimeout(() => bail('no mail received within 15s'), 15000);

/** Minimal SMTP client: one message, then QUIT. */
function sendMail(from, to, data) {
  return new Promise((resolve, reject) => {
    const sock = connect(SMTP.port, SMTP.host);
    let buf = '';
    let step = 0;
    // dot-stuff per RFC 5321: any line starting with '.' gets another '.'
    const stuffed = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const fail = (e) => { sock.destroy(); reject(e); };

    sock.setTimeout(10000, () => fail(new Error('SMTP timeout')));
    sock.on('error', fail);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3}[ -]/.test(last)) return; // reply not complete yet
      buf = '';
      const code = Number(last.slice(0, 3));
      if (code >= 400) return fail(new Error(`SMTP ${code}: ${last}`));

      if (step === 0) { step = 1; sock.write('EHLO e2e\r\n'); return; }   // greeting 220
      if (step === 1) { step = 2; sock.write('HELO e2e\r\n'); return; }   // EHLO 250
      if (step === 2) { step = 3; sock.write(`MAIL FROM:<${from}>\r\n`); return; } // HELO 250
      if (step === 3) { step = 4; sock.write(`RCPT TO:<${to}>\r\n`); return; }
      if (step === 4) { step = 5; sock.write('DATA\r\n'); return; }
      if (step === 5) { step = 6; sock.write(stuffed + '\r\n.\r\n'); return; } // DATA 354
      if (step === 6) { sock.write('QUIT\r\n'); sock.end(); resolve(); }  // message accepted
    });
  });
}

const socket = io(WEB, { transports: ['websocket'] });

socket.on('connect_error', (e) => bail('socket connect failed: ' + e.message));
socket.on('shortid', async (id) => {
  console.log('registered mailbox:', id);
  try {
    await sendMail('sender@example.com', `${MBOX}@localhost`,
      'Subject: Smoke test\r\nFrom: sender@example.com\r\n' +
      `To: ${MBOX}@localhost\r\nContent-Type: text/html\r\n\r\n` +
      '<h1>Hello v2</h1><p>it works</p>');
    console.log('SMTP sent OK');
  } catch (e) {
    bail(e.message);
  }
});

socket.on('shortid rejected', (d) => bail('mailbox rejected: ' + JSON.stringify(d)));
socket.on('mail', (mail) => {
  clearTimeout(deadline);
  console.log('MAIL RECEIVED:', JSON.stringify({
    from: mail.headers.from,
    subject: mail.headers.subject,
    html: (mail.html || '').slice(0, 60),
    text: mail.text.slice(0, 40),
  }));
  socket.close();
  process.exit(0);
});

socket.on('connect', () => socket.emit('set shortid', MBOX));
