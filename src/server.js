import { createServer } from 'node:http';
import { createWebApp } from './web/app.js';
import { startSmtpGateway } from './smtp/gateway.js';
import { attachRealtime } from './realtime/inbox.js';
import config from './config.js';

const webApp = createWebApp();
const httpServer = createServer(webApp);
const mailGateway = startSmtpGateway();
attachRealtime(httpServer, mailGateway);

httpServer.listen(config.web.port, config.web.host, () => {
  console.log(`[web] listening on ${config.web.host}:${config.web.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
