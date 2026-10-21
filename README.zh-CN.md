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

两条彼此独立的链路，在同一个内存邮箱库交汇：邮件走 SMTP 进来，浏览器走
WebSocket 监听。任何一方都不等另一方。

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

浏览器先认领一个名字（`request shortid` 或 `set shortid`），服务端建立
`邮箱 → socket` 的映射，此后该名字收到的每封邮件都立即推给 socket。邮件同时
在内存里保留 `MAIL_TTL_MINUTES`，所以浏览器重连、或者晚几秒才认领名字，依然
能收到——认领成功后，缓冲内容会以 `mail history` 事件一次性补齐。

**没有数据库，没有消息队列，没有外部服务。** 状态就在进程里。这是单个二进制
就能撑起整个服务的原因，也是它无法水平扩展的原因（见
[容量与内存](#容量与内存)）。

## 架构

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
scripts/e2e.mjs          端到端投递测试
scripts/smoke-socket.mjs 实时层冒烟测试
scripts/hash-assets.mjs  部署前给 HTML 里的 ?v= 打内容指纹
```

## 通信协议

协议与原版 forsaken-mail 一致，只做增量扩展——老客户端会自动忽略不认识的
事件。传输层是 Socket.IO over WebSocket（默认保留 polling 降级）。

### 客户端 → 服务端

| 事件 | 参数 | 作用 |
|---|---|---|
| `request shortid` | `clientToken?: string` | 分配并认领一个全新随机邮箱 |
| `set shortid` | `name: string, clientToken?: string` | 认领指定名字；非法、保留、或已被他人持有时拒绝 |
| `recover` | `token: string, clientToken?: string` | 用恢复令牌接管邮箱，**并踢掉当前监听者** |
| `delete mail` | `mailId: number, ack?: (res) => void` | 删除自己邮箱里的一封邮件，ack 收到 `{ ok: boolean }` |

### 服务端 → 客户端

| 事件 | 载荷 |
|---|---|
| `shortid` | `name: string` —— 当前 socket 绑定的邮箱名 |
| `shortid rejected` | `{ name, code, message }` |
| `boot` | `{ id: string }` —— 进程启动标识；一旦变化说明内存库已清空，客户端应重置列表 |
| `mail` | `{ _id, headers: { from, to, subject, date }, recipients: string[], html, text }` |
| `mail history` | `Mail[]` —— 回放缓冲，认领成功后立即下发一次 |
| `mail deleted` | `{ id: number }` —— 广播给该邮箱的所有 socket |
| `recovery` | `{ token, expiresAt }` |
| `recovery rejected` | `{ message }` |
| `server error` | `{ code, message }` —— 仅通知，连接不断开 |

### 错误码

| 错误码 | 出现位置 | 含义 |
|---|---|---|
| `E_SHORTID_INVALID` | 认领 | 名称不合法（1–32 位 `a-z0-9._-`，首尾不能是 `.` 或 `-`） |
| `E_SHORTID_RESERVED` | 认领 | 名称在保留列表内（`admin`、`postmaster` 等） |
| `E_SHORTID_TAKEN` | 认领 | 有其他活跃 socket 占着，且出示的令牌不是所有者令牌 |
| `E_RATE_LIMITED` | 通知 | 该邮箱本分钟的通知类事件额度已用尽 |
| `E_MAIL_TOO_BIG` | 通知 | 邮件超过 `SMTP_MAX_MAIL_BYTES`，在 DATA 中途被切断 |
| `E_NOT_FOUND` / `E_INTERNAL` | HTTP | 同时通过 `X-Error-Code` 响应头返回；JSON 客户端收到 `{ ok, code, message }` |

用户可见的文案只存在于服务端 `src/lib/errors.js`，前端不保存副本——新增错误码
无需同时发版前端（前端遇到未知码会降级为 `E_INTERNAL`）。

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
| `SMTP_RATE_PER_MIN` | 20 | 每邮箱的**通知类**事件额度（超限/错误提示）。真实邮件永不在此丢弃——见[设计说明](#设计说明) |
| `SMTP_MAX_CONN_PER_IP` | 6 | 单 IP 并发 SMTP 连接数 |
| `SMTP_MAX_MAILS_PER_IP_MIN` | 12 | 单 IP 每分钟可投递的邮件数 |
| `MAIL_TTL_MINUTES` | 30 | 邮件在回放缓冲中的保留时长（同时决定恢复令牌寿命） |
| `MAIL_STORE_MAX_PER_MAILBOX` | 20 | 每个邮箱在缓冲中保留的邮件数 |
| `MAIL_STORE_MAX_BYTES` | 67108864 | 全局回放缓冲字节预算 |
| `REALTIME_MAX_BROADCASTS_SEC` | 200 | 全局 socket 广播总量熔断（每秒） |
| `ANALYTICS_DISABLED` | (未设置) | 设为 `1` 时从 CSP 中移除 Google Analytics 来源 |
| `ANALYTICS_CSP_EXTRA` | (未设置) | 以空格分隔的来源列表，为自选分析服务加白（script-src + connect-src） |

## 容量与内存

所有状态都在一个进程里，所以容量问题就是内存问题。三个需要盯的桶：

| 内存桶 | 受限于 | 默认值 |
|---|---|---|
| Node + express + socket.io | — | 约 40–60 MB |
| 回放缓冲 | `MAIL_STORE_MAX_BYTES` | 64 MB（全局，所有邮箱共享） |
| SMTP 会话缓冲 | `SMTP_MAX_CONNECTIONS × SMTP_MAX_MAIL_BYTES` | 30 × 5 MB = **最坏 150 MB** |

**默认配置放不进 256 MB 的容器。** 64 + 150 加上进程本身就会超。要么调高容器
上限，要么调低邮件相关上限——256 MB 的机器上，`SMTP_MAX_MAIL_BYTES=1048576`
配 `SMTP_MAX_CONNECTIONS=16`（最坏 16 MB）+ 64 MB 缓冲，还剩足够余量。

达到上限时的淘汰顺序：先按 `MAIL_STORE_MAX_PER_MAILBOX` 丢该邮箱最旧的邮件；
全局字节预算超了，丢**最快过期**的那个邮箱。两者都不影响已连接 socket 的实时
投递。

邮箱名是 8 位、31 个字符组成的字母表（`31⁸ ≈ 8.5 × 10¹¹`，约 39.6 bit 熵），
生成时用拒绝采样保证分布均匀。任何现实规模下都不必担心碰撞；真撞上了，认领会
被拒绝（`E_SHORTID_TAKEN`），而不是让两个人静默共用一个收件箱。

### 扩展性

**它不能水平扩展。** socket、回放缓冲、恢复令牌都由各自进程独占。在负载均衡
后面跑两个副本，会出现很难排查的故障：

- 发件方 MX 只指向一台，邮件落到它命中的那个副本——连在另一个副本上的浏览器
  永远看不到
- Socket.IO 的 Redis adapter 能广播*事件*，但回放缓冲仍是进程内的，重连落到
  另一台就丢掉历史
- 恢复令牌只存内存：副本 A 签发的令牌，副本 B 不认识

受支持的扩展方式是垂直扩展（加内存、调大 `MAIL_STORE_MAX_BYTES`）。真正的水平
扩展需要共享邮件存储加跨进程发布订阅，而且会改变上面描述的淘汰与投递语义——
那不是改配置能解决的。

## 恢复链接

邮箱被认领后，服务端会签发一个高熵恢复令牌（64 位十六进制，仅存内存），通过
`recovery` socket 事件下发；前端将其展示为可复制的 `https://…/?r=TOKEN` 链接。

- 打开 `/?r=TOKEN` 即可在任意设备找回该邮箱（含缓冲期内收到的邮件），直到令牌过期。
- 令牌生命周期与回放缓冲一致（`MAIL_TTL_MINUTES`）：邮件没了，链接也就失效。无持久化、无账户。
- 令牌即所有权：持有效令牌的设备会接管邮箱并踢掉当前监听者。请像保管密码一样保管恢复链接。
- 无效令牌会收到 `recovery rejected` 事件，前端自动回退到新邮箱。

## 安全模型

先说清楚这是什么：**公开收件箱，不是私人邮箱。** 邮箱名是读信的唯一凭证。
任何知道 `h7k2mq9x@你的域名` 的人都能认领它并读到后续邮件。这就是产品本身，
与原版一致——不要往一次性地址里发送任何你介意被陌生人看到的内容。

真正有防护的部分：

- **邮件 HTML 在沙盒 iframe 中渲染**，只给 `allow-popups`，不含
  `allow-scripts`、不含 `allow-same-origin`。邮件里的脚本不会执行，也碰不到
  页面存储和 Cookie。链接在新标签页打开。
- **恢复令牌为 256 bit**（两个 UUIDv4 的十六进制），仅存内存。持有者在过期前
  拥有该收件箱，所以恢复链接要当密码对待。
- **路由只看解析后的地址，绝不匹配原始 `To:` 头文本。** 显示名里可以含 `@`
  （`"x@y" <real@localhost>`），按头文本匹配会把副本投进陌生人的邮箱。
- **socket 只能删自己邮箱里的邮件**——`delete mail` 的作用域是
  `socket.data.mailbox`，不接受客户端传邮箱名。
- **每 IP 的并发会话与投递速率限制**，加上全局广播熔断，约束单台主机能造成的
  破坏上限。

已知且明确的限制：

- **入站 SMTP 是明文。** `AUTH` 和 `STARTTLS` 都是禁用的，因为这里只接收 MX
  流量、没人会认证；代价是发件方 MTA 无法把连接升级到 TLS，邮件在发送方到本机
  之间是明文的。
- **邮件里的远程图片默认会加载**（`img-src … https:`），发件方因此可以通过
  追踪像素知道邮件何时被打开。全拦掉会让大部分真实邮件显示不全，这是个需要
  主动接受的取舍。
- **RCPT 阶段接受任何收件人**，路由发生在 DATA 之后。没有邮箱存在性校验，
  这是设计使然（邮箱在被认领之前根本不存在）。

## 设计说明

几条"为什么代码要这么写"的短答——其中好几处不看失败场景就像 bug。

**邮箱名用拒绝采样。** `byte % 31` 是有偏的：256 不是 31 的倍数，余 8，于是
前 8 个字符比其他字符多一个映射值，明显更容易出现，实打实地削掉熵。改为丢弃
`>= 248` 的字节。

**MIME 解析放在工作线程。** 一封带 base64 附件的 5 MB 邮件是几百毫秒的 CPU
密集运算。放在主线程，所有用户的 WebSocket 心跳和 HTTP 响应都会被卡住。工作
线程还拿到一份私有的 `ArrayBuffer` 副本：`Buffer.concat` 可能返回 Node 共享
缓冲区池的视图，transfer 它的 `raw.buffer` 会让进程里**所有** `Buffer` 失效。

**限流通知，不限流邮件。** 当某邮箱被灌爆时，如果连投递一起限流，攻击者的垃圾
邮件就能把用户的验证码掩盖掉，而 SMTP 那边照样回 `250`。**看得见的洪水好过
看不见的丢失**，所以 `mail` 事件完全绕过每邮箱额度，只有机器生成的通知被限流。

**全局广播熔断。** 每邮箱限制挡不住对着成千上万个**不同**名字撒邮件——每个
邮箱看起来都很安静。熔断统计滚动一秒内的**所有** emit（默认 200），只在跨邮箱
洪水时才触发；单个正常邮箱远远够不到。

**所有权令牌用来区分"重连"和"陌生人"。** 没有它，一个僵尸 socket（服务端还
没回收旧连接，ping 超时最长约 25 秒）会让同一浏览器的刷新看起来像入侵者。有了
它，同一令牌直接接管并踢掉僵尸，不同令牌则得到 `E_SHORTID_TAKEN`。

**认领权比 socket 活得久，这是故意的。** 断开连接时只把 socket 从邮箱移除，
所有者和恢复令牌都保留——否则标签页一关，保存的恢复链接立刻失效。它们由 TTL
清扫负责回收，而不是 `disconnect`。

**先写缓冲，再广播。** `store.put()` 是同步的内存写入，排在广播之前。回放缓冲
的任何逻辑都不可能拖慢或打断实时投递，而 socket 被通知时，历史记录一定已经
就位。

**`keepAliveTimeout` 要比 CDN 复用窗口长。** 这里是 90 秒，`headersTimeout`
95 秒。短于边缘节点的连接复用窗口的话，每个请求都要为源站重新做一次 TCP/TLS
握手。

## 测试

```bash
PORT=3100 SMTP_PORT=2525 npm start &   # 终端一
node scripts/e2e.mjs                   # 终端二
SMOKE_URL=http://127.0.0.1:3100 node scripts/smoke-socket.mjs   # 终端二：实时层冒烟测试
```

两个脚本失败都返回非零，且可以安全地对线上实例运行（用的是随手生成的一次性
邮箱名）。覆盖范围：

| 脚本 | 断言 |
|---|---|
| `e2e.mjs` | A：发给某个邮箱的邮件能到达其实时 WebSocket 监听者，且头部完整 |
| `e2e.mjs` | B：`To: "x@y" <real@localhost>` **只**投给 `real@localhost`；以显示名命名的邮箱收不到任何东西（文本正则路由的回归测试） |
| `smoke-socket.mjs` | `request shortid` 返回一个合法的新名字 |
| `smoke-socket.mjs` | 同令牌重连能接管邮箱并踢掉旧 socket |
| `smoke-socket.mjs` | 不同令牌被拒绝，错误码为 `E_SHORTID_TAKEN` |

自动化测试**未覆盖**：每 IP 限流、超限拒收、全局广播熔断、TTL 淘汰。这些需要
压测工具或可控时钟，目前靠手工验证。

没有 lint，也没有单元测试框架——测试就是这两个脚本，外加对前端包跑
`node --check`。

## 站点统计

所有页面统计代码集中在一个文件：`public/js/ga.js`（Google Analytics 4，
IP 已匿名化）。自部署用户可直接替换成自己的统计代码或清空该文件——
无需改动任何 HTML。

服务端 CSP 默认只放行 Google 的统计来源。如需换用其他统计服务：

1. 将 `public/js/ga.js` 替换为目标服务的代码片段。
2. 通过 `ANALYTICS_CSP_EXTRA` 加白其来源，例如：
   - **Plausible**：`ANALYTICS_CSP_EXTRA=https://plausible.io`
   - **Umami**（自托管）：`ANALYTICS_CSP_EXTRA=https://umami.example.com`
   - **Matomo**（自托管）：`ANALYTICS_CSP_EXTRA=https://matomo.example.com`
   - **Cloudflare Web Analytics**：`ANALYTICS_CSP_EXTRA=https://static.cloudflareinsights.com https://cloudflareinsights.com`
3. 完全不用统计？设置 `ANALYTICS_DISABLED=1`，同时从 CSP 中移除 Google 来源。

## 部署要点

- 端口 25 必须可直接可达（MX 记录 → 本机）。邮件链路不能走 CDN/代理；web
  可以放在 Cloudflare/nginx 后面。
- **只跑一个实例。** 状态都在进程内，多副本会分裂邮件并丢失回放历史。选容器
  规格前先看[扩展性](#扩展性)和[容量与内存](#容量与内存)。
- 固有的设计注意点（与原版一致）：任何人都可以 `set shortid` 到任意合法名称
  并实时收到该邮箱的邮件。这就是产品本身——见[安全模型](#安全模型)。
- 滥用防护：每 IP 的 SMTP 并发与投递速率上限、每邮箱的**通知类**额度
  （`SMTP_RATE_PER_MIN`，真实邮件不受限）、全局广播熔断、web 端安全响应头
  （CSP、X-Frame-Options）、重启时 SMTP 优雅下线。

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
| 容器被 OOM kill | 按[容量与内存](#容量与内存)核算：会话数 × 单封上限 + 回放缓冲，别超过容器上限 |
| `nginx recv() failed (104)` 频发 | 容器在重启——`docker ps` 查看是否重启循环，再 `docker logs tempmail` |
