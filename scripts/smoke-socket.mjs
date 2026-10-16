/**
 * Smoke test for the realtime layer. Run with the server already listening on
 * SMOKE_URL (env or default http://127.0.0.1:3457). Exits 0 on pass, 1 on fail.
 *
 * Verifies:
 *  1. 'request shortid' returns a fresh mailbox name
 *  2. same-token reconnect reclaims a claimed mailbox and kicks the old socket
 *  3. a stranger (no / wrong token) is rejected with code E_SHORTID_TAKEN
 */
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:3457';
const TOKEN = 'smoke-token-' + Date.now();
const NAME = 'smoke' + Date.now().toString(36);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);

const connect = (sock) =>
  withTimeout(new Promise((r) => sock.once('connect', r)), 5000, 'connect');

const once = (sock, ev, ms = 5000) =>
  withTimeout(new Promise((r) => sock.once(ev, r)), ms, ev);

try {
  // 1. fresh address generation
  const a = io(URL, { transports: ['websocket'] });
  await connect(a);
  a.emit('request shortid', TOKEN);
  const fresh = await once(a, 'shortid');
  check(typeof fresh === 'string' && fresh.length > 0, 'request shortid returns a mailbox name');

  // claim a fixed name
  a.emit('set shortid', NAME, TOKEN);
  check((await once(a, 'shortid')) === NAME, 'set shortid claims the requested name');

  // 2. same-token reconnect reclaims + kicks old socket
  const b = io(URL, { transports: ['websocket'] });
  await connect(b);
  b.emit('set shortid', NAME, TOKEN);
  const [ack, ownerDied] = await Promise.all([
    once(b, 'shortid'),
    new Promise((r) => a.on('disconnect', () => r(true))),
  ]);
  check(ack === NAME, 'same-token reconnect reclaims the mailbox');
  check(ownerDied === true, 'stale socket is kicked');

  // 3. stranger rejected
  const c = io(URL, { transports: ['websocket'] });
  await connect(c);
  c.emit('set shortid', NAME);
  check((await once(c, 'shortid rejected')).code === 'E_SHORTID_TAKEN', 'stranger without token rejected');
  c.emit('set shortid', NAME, 'wrong-token');
  check((await once(c, 'shortid rejected')).code === 'E_SHORTID_TAKEN', 'stranger with wrong token rejected');

  [a, b, c].forEach((s) => s.close());
} catch (err) {
  console.log('FAIL unexpected error:', err.message);
  failures++;
}

process.exit(failures ? 1 : 0);
