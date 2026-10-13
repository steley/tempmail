# 01 Discovery — tempmail-v2

- 路径：/Users/sun/Sites/tempmail（git-tracked，32 个跟踪文件）
- 类型：临时邮箱服务（Node.js 单进程）：入站 SMTP 网关 + Express 静态站 + Socket.IO 实时推送
- 技术栈：Node ≥20 (ESM)、express ^4.21.2、smtp-server ^3.13.6、mailparser ^3.7.2、socket.io ^4.8.1
- 部署：Docker (node:22-alpine)，端口 25 (SMTP) / 3000 (HTTP)，deploy.sh 在服务器上 build+run，前置 Cloudflare（推断）

## 规模分级

排除 vendor/build 后的真实源码（git-tracked 代码文件）：

| 文件 | LOC |
|---|---|
| src/server.js | 33 |
| src/config.js | 32 |
| src/web/app.js | 52 |
| src/realtime/inbox.js | 91 |
| src/smtp/gateway.js | 117 |
| src/lib/logger.js | 14 |
| src/lib/id.js | 17 |
| public/js/app.js | 253 |
| scripts/e2e.mjs | 37 |

共 9 个代码文件，~646 LOC → **small 档**（单会话，证据上限 E3）。

## 排除名单

- node_modules/（1821 文件，依赖）
- public/css/prism.css、public/js/prism.js（第三方库 prism）
- public/*.png|svg、css/modern.css、*.html（静态资产/页面壳）
- public/.workbuddy/（本地工作数据，含 2026-10-13.md 与 backup/pre-cleanup-20261013.tar.gz —— 见 Finding F3）

## 入口点枚举（100%）

1. HTTP：Express app（src/web/app.js）—— static 服务、/healthz、404/500 handler、全局安全头中间件
2. SMTP：SMTPServer（src/smtp/gateway.js）—— onRcptTo / onData / onError
3. WebSocket：socket.io connection（src/realtime/inbox.js）—— 'request shortid' / 'set shortid' / disconnect；服务端 'mail' 广播
4. 进程信号：SIGINT/SIGTERM（src/server.js）；uncaughtException / unhandledRejection
5. 运维脚本：deploy.sh（服务器 root 执行）、scripts/e2e.mjs（本地开发）
