/**
 * End-to-end tests: drive the SMTP gateway with a hand-rolled conversation
 * and assert mail reaches (or stays away from) live WebSocket mailboxes.
 *
 * Run against a server already listening (see README "Test"):
 *   PORT=3100 SMTP_PORT=2525 npm start &
 *   node scripts/e2e.mjs
 *
 * Scenarios:
 *   A. normal delivery: one recipient, mail arrives
 *   B. display-name isolation: `To: "x@y" <real@localhost>` routes only to
 *      real@localhost — the mailbox named after the display name must NOT
 *      receive a copy (regression: text-regex routing leaked mail)
 */
import { io } from 'socket.io-client';
import { connect } from 'node:net';

const WEB = process.env.E2E_WEB_URL || 'http://localhost:3100';
const SMTP = { host: '127.0.0.1', port: Number(process.env.E2E_SMTP_PORT || 2525) };
const TAG = Date.now().toString(36);

const bail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

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

/** Claim a mailbox; resolves the socket once the server acks the name. */
function claim(mailbox) {
  return new Promise((resolve, reject) => {
    const socket = io(WEB, { transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error(`claim timeout for ${mailbox}`)), 10000);
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('shortid rejected', (d) => { clearTimeout(timer); reject(new Error(JSON.stringify(d))); });
    socket.on('shortid', (id) => {
      if (id === mailbox) { clearTimeout(timer); resolve(socket); }
    });
    socket.on('connect', () => socket.emit('set shortid', mailbox));
  });
}

/** Resolve if `mailbox` receives a mail within `ms`; reject otherwise. */
function nextMail(socket, mailbox, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no mail received on ${mailbox} within ${ms}ms`)), ms);
    socket.once('mail', (mail) => { clearTimeout(timer); resolve(mail); });
  });
}

async function scenarioNormal() {
  const box = 'e2ea' + TAG;
  const socket = await claim(box);
  const got = nextMail(socket, box);
  await sendMail('sender@example.com', `${box}@localhost`,
    'Subject: Scenario A\r\nFrom: sender@example.com\r\n' +
    `To: ${box}@localhost\r\nContent-Type: text/html\r\n\r\n` +
    '<h1>Hello v2</h1><p>it works</p>');
  const mail = await got;
  if (mail.headers.subject !== 'Scenario A') bail(`A: wrong subject "${mail.headers.subject}"`);
  console.log(`PASS A: mail delivered to ${box}`);
  socket.close();
}

async function scenarioDisplayNameIsolation() {
  const real = 'e2eb' + TAG;        // actual addressee
  const decoy = 'decoy' + TAG;      // mailbox named after the display-name local part
  const realSock = await claim(real);
  const decoySock = await claim(decoy);

  const gotReal = nextMail(realSock, real);
  // if any mail lands here, routing still leaks through header text
  let leaked = false;
  decoySock.once('mail', () => { leaked = true; });

  await sendMail('sender@example.com', `${real}@localhost`,
    'Subject: Scenario B\r\nFrom: sender@example.com\r\n' +
    `To: "leak@${decoy}.example" <${real}@localhost>\r\n` +
    'Content-Type: text/plain\r\n\r\nsecret body');
  await gotReal;

  // give a (would-be) leak a moment to show up before declaring victory
  await new Promise((r) => setTimeout(r, 1500));
  if (leaked) bail(`B: display-name "leak@..." routed a copy to mailbox ${decoy}`);
  console.log(`PASS B: display-name "${'leak@' + decoy + '.example'}" did not leak to mailbox ${decoy}`);
  realSock.close();
  decoySock.close();
}

try {
  await scenarioNormal();
  await scenarioDisplayNameIsolation();
  console.log('ALL PASS');
  process.exit(0);
} catch (e) {
  bail(e.message);
}
