# Tempmail

[English](README.md) | 中文

基于 WebSocket 实时收件的临时邮箱服务。对 forsaken-mail（2015 年代的
Node.js 项目）的全面重写，采用现代化、依赖干净的技术栈。

<p align="center">
  <img src="docs/screenshot.png" alt="TempMail.cc — 实时收件的临时邮箱" width="800">
</p>

## 在线演示

生产实例部署在 **[tempmail.cc](https://tempmail.cc/)** —— 打开即得一个一次性
邮箱，无需注册。

## 工作原理

两条彼此独立的链路，在同一个内存邮箱库交汇：邮件走 SMTP 进来，在工作线程里
做 MIME 解析；浏览器走 WebSocket 监听。邮件同时在内存里保留
`MAIL_TTL_MINUTES`，所以浏览器重连、或者晚几秒才认领名字，依然能通过
`mail history` 回放收到。

**没有数据库，没有消息队列，没有外部服务。** 状态就在进程里。这是单个二进制
就能撑起整个服务的原因，也是它无法水平扩展的原因（见
[docs/operations.md](docs/operations.md)）。

```
   发件方 MTA                          浏览器
        │                                 │
        │ SMTP :25                        │ HTTPS + WebSocket
        ▼                                 ▼
┌──────────────────┐              ┌──────────────────┐
│ smtp/gateway.js  │              │ realtime/inbox   │
│  每 IP 限流      │              │  认领 / 释放     │
│  体积上限        │              │  全局广播引信    │
└────────┬─────────┘              └────────▲─────────┘
         │ 原始字节                        │ 'mail' 事件
         ▼                                 │
┌──────────────────┐                      │
│ parser-worker.js │  工作线程            │
│  MIME → {headers,│  （不阻塞事件循环）  │
│   html, text}    │                      │
└────────┬─────────┘                      │
         │ 解析后的邮件                   │
         └──────────►┌────────────────┐───┘
                     │ mailbox-store  │  内存回放缓冲
                     │  TTL + 双重上限│  断开连接后仍保留
                     └────────────────┘
```

```
src/
├── server.js            入口：http + express + socket.io + smtp
├── config.js            基于环境变量的配置
├── lib/id.js            邮箱名生成与校验（白名单）
├── lib/errors.js        错误码目录（用户可见文案只在服务端）
├── lib/logger.js        带模块前缀的结构化日志
├── smtp/gateway.js      入站 SMTP（smtp-server）+ 每 IP 滥用防护
├── smtp/parser-worker.js MIME 解析跑在工作线程（永不阻塞事件循环）
├── store/mailbox-store.js 内存回放缓冲（30 分钟 TTL），供断线重连使用
├── realtime/inbox.js    socket.io 层，邮箱 -> socket 注册表
└── web/app.js           express 静态托管 + healthz
public/                  前端（原生 JS，协议保持不变）
scripts/                 e2e / 冒烟测试，静态资源指纹
```

## 运行

```bash
npm install
npm start                     # web 端口 3000，smtp 端口 25
PORT=8080 SMTP_PORT=2525 npm start   # 适合本地开发的端口
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | web 端口 |
| `HOST` | 0.0.0.0 | web 绑定地址 |
| `SMTP_PORT` | 25 | 入站 SMTP 端口 |
| `SMTP_HOST` | 0.0.0.0 | SMTP 绑定地址 |
| `SMTP_BANNER` | `tempmail ready` | 连接时的问候行 |
| `SMTP_MAX_MAIL_BYTES` | 5242880 | 单封邮件最大字节数；超限邮件在 DATA 中途被切断并通知监听者 |
| `SMTP_MAX_CONNECTIONS` | 30 | 全局 SMTP 并发会话数（每个会话最多可缓冲 `SMTP_MAX_MAIL_BYTES`） |
| `SMTP_DATA_TIMEOUT_MS` | 30000 | 在 DATA 阶段卡住的会话多久被踢掉 |
| `SMTP_RATE_PER_MIN` | 20 | 每邮箱的**通知类**事件额度（超限/错误提示）。真实邮件永不在此丢弃 |
| `SMTP_MAX_CONN_PER_IP` | 6 | 单 IP 并发 SMTP 连接数 |
| `SMTP_MAX_MAILS_PER_IP_MIN` | 12 | 单 IP 每分钟可投递的邮件数 |
| `MAIL_TTL_MINUTES` | 30 | 邮件在回放缓冲中的保留时长（同时决定恢复令牌寿命） |
| `MAIL_STORE_MAX_PER_MAILBOX` | 20 | 每个邮箱在缓冲中保留的邮件数 |
| `MAIL_STORE_MAX_BYTES` | 67108864 | 全局回放缓冲字节预算 |
| `REALTIME_MAX_BROADCASTS_SEC` | 200 | 全局 socket 广播总量熔断（每秒） |
| `ANALYTICS_DISABLED` | (未设置) | 设为 `1` 时从 CSP 中移除 Google Analytics 来源 |
| `ANALYTICS_CSP_EXTRA` | (未设置) | 以空格分隔的来源列表，为自选分析服务加白（script-src + connect-src） |

## 测试

```bash
PORT=3100 SMTP_PORT=2525 npm start &   # 终端一
node scripts/e2e.mjs                   # 端到端投递
SMOKE_URL=http://127.0.0.1:3100 node scripts/smoke-socket.mjs   # 实时层冒烟测试
```

两个脚本失败都返回非零，且可以安全地对线上实例运行（用的是随手生成的一次性
邮箱名）。没有 lint，也没有单元测试框架——测试就是这两个脚本，外加对前端包
跑 `node --check`。

## 部署要点

- 端口 25 必须可直接可达（MX 记录 → 本机）。邮件链路不能走 CDN/代理；web
  可以放在 Cloudflare/nginx 后面。
- **只跑一个实例。** 状态都在进程内，多副本会分裂邮件并丢失回放历史。选容器
  规格前先看 [docs/operations.md](docs/operations.md)。
- 固有的设计注意点（与原版一致）：任何人都可以 `set shortid` 到任意合法名称
  并实时收到该邮箱的邮件。这就是产品本身——见 [docs/security.md](docs/security.md)。

## Docker 部署（从 git clone 到跑起来）

前置条件：一台装好 Docker 的服务器（以 Ubuntu 为例，安装命令
`curl -fsSL https://get.docker.com | sh`）；DNS：邮件域名的 A 记录 → 服务器
IP，MX 记录 → 该域名。

```bash
# 1. 克隆并构建
git clone <repo-url> /var/www/tempmail
cd /var/www/tempmail
docker build -t tempmail .

# 2. 运行（开机/崩溃自动重启）
docker run -d --name tempmail \
  -p 3000:3000 \
  -p 25:25 \
  --restart unless-stopped \
  tempmail

# 3. 验证
curl localhost:3000/healthz      # {"ok":true}
docker logs -f tempmail          # 结构化日志；SMTP 应输出 "listening on 0.0.0.0:25"
```

Dockerfile 在构建阶段已经跑过 `node scripts/hash-assets.mjs`，所以镜像里的
`?v=` 指纹总是对的。

### 用 nginx 反代 web 界面（可选，邮件保持直连）

只有 web 流量经过 nginx；SMTP :25 必须直达主机。

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name your.domain;

    ssl_certificate     /etc/letsencrypt/live/your.domain/fullchain.pem;   # certbot
    ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket —— 实时收件必需
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/your.domain /etc/nginx/sites-enabled/your.domain
nginx -t && systemctl reload nginx
```

走 Cloudflare 时：web 的 A 记录保持橙云代理；必须开启 WebSocket（网络设置
里）。如果邮件界面部署在别处，把该记录改为仅 DNS（灰云）——MX 记录本身
永远不能指向代理。

### 更新

```bash
git pull
node scripts/hash-assets.mjs   # 给改动过的静态资源重新打 ?v= 指纹
docker rm -f tempmail
docker build -t tempmail .
docker run -d --name tempmail -p 3000:3000 -p 25:25 --restart unless-stopped tempmail
```

静态资源带 `max-age=2592000, immutable`，改完前端不打指纹的话，回访用户会继续
跑最多 30 天的旧代码。HTML 走的是 `max-age=0, s-maxage=3600`，部署后记得清一次
CDN 缓存。

### 故障排查

| 现象 | 排查方向 |
|------|----------|
| `docker run` 报 `port 25 already allocated` | 旧容器仍占用端口：`docker ps -a \| grep 25`，然后 `docker rm -f <名称>` |
| 全链路访问站点都 404 | 直接验证源站：`curl -sI http://127.0.0.1:3000/` —— 若源站也是 404，用最新代码重新构建镜像 |
| 页面能打开但收件箱一直"连接中…" | WS 握手：`curl -s "https://your.domain/socket.io/?EIO=4&transport=polling"` 应返回 `0{"sid":...}`；若正常，强制刷新——浏览器/CF 缓存了旧版前端 JS |
| 日志显示已收信但页面不显示 | 收件人 local part 必须与所声称的邮箱名一致；检查 `docker logs` 中的 `[smtp] accepted mail` 行 |
| 容器被 OOM kill | 按 [docs/operations.md](docs/operations.md) 核算：会话数 × 单封上限 + 回放缓冲，别超过容器上限 |
| `nginx recv() failed (104)` 频发 | 容器在重启——`docker ps` 查看是否重启循环，再 `docker logs tempmail` |

## 更多文档

- [docs/protocol.md](docs/protocol.md) — Socket.IO 通信协议与错误码
- [docs/operations.md](docs/operations.md) — 内存容量核算、扩展性、恢复链接
- [docs/security.md](docs/security.md) — 安全模型与设计取舍的原因

站点统计：所有页面统计代码集中在 `public/js/ga.js`（GA4，IP 已匿名化）。
自部署用户可直接替换或清空该文件，无需改动 HTML。换其他统计服务走
`ANALYTICS_CSP_EXTRA`（如 `https://plausible.io`）。
