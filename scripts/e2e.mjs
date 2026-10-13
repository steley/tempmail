import { io } from 'socket.io-client';
import { execSync } from 'node:child_process';

const socket = io('http://localhost:3100');
const timeout = setTimeout(() => {
  console.error('TIMEOUT: no mail received');
  process.exit(1);
}, 15000);

socket.on('connect', () => socket.emit('set shortid', 'tester123'));

socket.on('shortid', (id) => {
  console.log('registered mailbox:', id);
  execSync(`/usr/bin/python3 - <<'PYEOF'
import smtplib
from email.mime.text import MIMEText
msg = MIMEText('<h1>Hello v2</h1><p>it works</p>', 'html')
msg['Subject'] = 'Smoke test'
msg['From'] = 'sender@example.com'
msg['To'] = 'tester123@localhost'
s = smtplib.SMTP('127.0.0.1', 2525, timeout=10)
s.sendmail('sender@example.com', ['tester123@localhost'], msg.as_string())
s.quit()
print('SMTP sent OK')
PYEOF`, { stdio: 'inherit' });
});

socket.on('mail', (mail) => {
  clearTimeout(timeout);
  console.log('MAIL RECEIVED:', JSON.stringify({
    from: mail.headers.from,
    subject: mail.headers.subject,
    html: (mail.html || '').slice(0, 60),
    text: mail.text.slice(0, 40),
  }));
  process.exit(0);
});
