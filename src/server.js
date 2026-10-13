import { createServer } from 'node:http';
import { createWebApp } from './web/app.js';
import { startSmtpGateway } from './smtp/gateway.js';
import { attachRealtime } from './realtime/inbox.js';
import config from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('server');

process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err.stack ?? err.message);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});

const webApp = createWebApp();
const httpServer = createServer(webApp);
const mailGateway = startSmtpGateway();
attachRealtime(httpServer, mailGateway);

httpServer.listen(config.web.port, config.web.host, () => {
  log.info(`http listening on ${config.web.host}:${config.web.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    mailGateway.close(2000); // reject new SMTP sessions, give live ones 2s to finish
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
