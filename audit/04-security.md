# 04 Security — tempmail-v2

方法：先枚举 sink 实例，再反向追踪。本服务无数据库、无文件写、无 URL fetch、无 eval/child_process（生产路径），主要 sink 类别：HTML 渲染（前端）、跨用户数据可达性（信箱）、资源耗尽。

## S1. 信箱无鉴权：知道名字即可接管/旁听任意信箱 — HIGH / CONFIRMED (E3)

- Data Flow（端到端静态可证）：
  1. src/realtime/inbox.js:48-60 —— 任意客户端 emit `set shortid` 即可 claim **任意**未被保留名单挡住的信箱名，无 token/无拥有者校验。
  2. 同文件 19-24 —— 多 socket 可共享同一信箱；65-87 —— 该信箱收到的每封邮件广播给**所有** claim 的 socket。
  3. 邮件是外网任意发件人投递的，内容对信箱"持有者"与旁听者完全等价。
- 可达性：服务公网开放（Docker -p 25:25 -p 3000:3000，deploy.sh:16-17）。攻击者只需知道/猜中目标信箱名即可实时旁听全部来信。
- 随机 8 位名（src/lib/id.js，31 字母表，~8.5e11 空间）暴破不可行 → 默认信箱安全。但：
  a) 用户自选名（前端 $edit 允许）多为低熵词（姓名、公司名），可被直接猜中；
  b) localStorage 恢复机制（public/js/app.js:188-194）鼓励用户长期复用同一地址，放大旁听价值。
- 前提：攻击者与信箱使用者在同一部署实例上；名字非随机。
- 缓解现状：保留名单只挡 18 个管理名（src/config.js:26-30），不解决猜名。

## S2. SMTP 层资源耗尽（无连接数/超时限制） — MEDIUM / POTENTIAL (E2)

- 证据：src/smtp/gateway.js:17-105 —— SMTPServer 未设置 `maxConnections`、`connectionTimeout`、`socketTimeout`、`dataTimeout`（smtp-server 默认 0 = 不限制）。
- 追踪：外部任意 TCP 连 :25 → 每连接 onData 缓冲最多 5MB（config.smtp.maxMailBytes）→ N 个并发慢连接 = N×5MB 内存 + fd 占用；且可只连不发（无超时踢出）。8GB 内存的宿主机上几百个并发 5MB 流即可 OOM。
- 反例检查：`size` 选项只限**单封**邮件大小；Docker 无内存限制（deploy.sh:16-19 无 --memory）。
- 前提：直接暴露 25 端口（当前架构如此）。HTTP 侧（express）默认无 body 解析中间件，静态服务不受影响。

## S3. 邮件 HTML 的前端渲染 — VERIFIED OK（防到位）

- 证据链：public/js/app.js:142-145 —— iframe `sandbox="allow-popups"`（刻意无 allow-scripts/allow-forms/allow-top-navigation）+ srcdoc；srcdoc iframe 继承父页 CSP（app.js:20-23，script-src 'self' + gtm），双重阻断。headers 走 escapeHtml（47-51，五字符全转义）后 innerHTML，raw 视图用 textContent（169）。
- 残余：`allow-popups` 下邮件内链接可在无脚本 sandbox 中打开新窗（opaque origin），点击劫持钓鱼面存在但对临时邮箱属预期行为 — INFORMATIONAL。

## S4. 响应头/CORS — VERIFIED OK

- nosniff / DENY / no-referrer / CSP（src/web/app.js:15-26）；socket.io `cors:{origin:false}`；x-powered-by 已禁。
- 残余：无 HSTS（假定 Cloudflare 层补齐，前提见报告）。

## S5. public/ 目录内混入本地备份数据 — LOW / CONFIRMED 存在，POTENTIAL 泄露 (E1)

- 证据：`public/.workbuddy/backup/pre-cleanup-20261013.tar.gz`、`public/.workbuddy/memory/2026-10-13.md` 位于 web 根目录内。
- 当前暴露面：express.static 默认 `dotfiles:'ignore'` → 以点开头路径返回 404，**当前不泄露**。但：(a) Dockerfile `COPY public ./public` 会把备份打进镜像分发给任何拉镜像的人；(b) 若前面再加一层 nginx/CDN 回源静态目录（不识别 dotfiles 规则），tar.gz 直接可下载。
- 依赖配置前提已明确。

## S6. 容器以 root 运行 — LOW / CONFIRMED (E3)

- 证据：Dockerfile 无 USER 指令；注释自认"port 25 仍需 root 或 CAP_NET_BIND_SERVICE"。可用非 root + `--cap-add NET_BIND_SERVICE` 改善。无其他降权需求（只读静态目录、无写路径）。

## S7. XSS / 注入 sink 反向追踪清单（生产路径） — 全部 VERIFIED OK

- `innerHTML` ×1（app.js:245）→ 三段均 escapeHtml 后拼接 ✔
- `srcdoc` ×1 → sandbox 无 allow-scripts ✔
- `textContent` ×4 ✔；`new Notification(from)`（223/227）为平台 API 非 HTML sink ✔
- 服务端无 eval/vm/exec；child_process 仅 scripts/e2e.mjs（开发用，输入无外部可控成分）✔
