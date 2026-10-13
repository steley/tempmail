# 09 Verification（独立验证）

验证者独立性：本阶段由独立子代理执行，仅依据 `audit/08-findings.md` 与重新读到的源码/依赖源码，未参考 03–07 产物或发现过程推理。本轮未做运行时实验（small 档默认禁止）。

依赖实际版本（package-lock / node_modules 核实）：express 4.22.3、serve-static 1.16.3、send 0.19.2、smtp-server 3.19.21、socket.io 4.8.4。

---

## F1 — 信箱无鉴权，知道名字即可旁听（原 HIGH / CONFIRMED / E3）

- 重定位：src/realtime/inbox.js:19-24（claim）、48-60（`set shortid`）、65-87（`mail` 广播）。代码存在，行号准确。
- 重建数据流：攻击者连 socket.io → `set shortid` 发任意合法名 → `isValidMailboxName`（src/lib/id.js:14-17，allowlist 通过）→ `claim()` 把 socket 加入 `socketsByMailbox[name]` → 该信箱后续邮件广播给所有 socket，含攻击者。全程无 token/鉴权/所有权校验。
- 反例尝试：① reserved 名单（config.js:26-30）只挡常用管理名，不挡用户自定义名；② socket.io `cors: { origin: false }`（inbox.js:15）只影响 polling 的 CORS 头，浏览器 WebSocket 握手不受 CORS 约束，且任意非浏览器客户端根本不受限——无法推翻；③ 随机 8 字符信箱（31^8 ≈ 8.5e11）难猜，但 claim 原文是"知道/猜中名字"，自定义短名（如 john）完全可预测——claim 与代码一致。
- **Verdict：CONFIRMED（E3）**。维持。静态即证：外部输入（socket.io 事件）直达广播 sink，无中间校验。

## F2 — SMTP 无连接数限制 / 内存耗尽（原 MEDIUM / POTENTIAL / E2）

- 重定位：src/smtp/gateway.js:28-50（onData 全量缓存 chunks）、103-105（listen 无连接数控制）、deploy.sh:16-19（docker run 无 `--memory`）。
- 反例尝试（有成果）：**"smtp-server 默认无超时"声明错误**。读 node_modules/smtp-server/lib/smtp-connection.js:14（`SOCKET_TIMEOUT = 60 * 1000`）、613（每个连接 `socket.setTimeout(socketTimeout(...))`）：默认存在 60s idle 超时。完全静止的连接会被清理。但 idle 超时在每次收到数据时重置——"慢速持续发送"攻击不受影响；且 `maxClients` 仅覆盖 PROXY/TLS pending socket（smtp-server.js:429-441），本项目未启用 proxy/TLS，`connect()`（smtp-server.js:173-178）对普通连接无上限。数据面：单连接 DATA 阶段按 `maxMailBytes`（默认 5MB）缓存于内存，并发 N 连接 ≈ N×5MB，项目侧无并发限制。
- **Verdict：POTENTIAL（E2）维持**，前提修正：不是"无超时"，而是"60s idle 超时对慢速持续流无效 + 无总连接数上限 + docker 无内存上限"。实际内存增速依赖并发规模，静态无法完全证实，不到 LIKELY。另注：`simpleParser` 在主事件循环同步解析，CPU 放大同根因。

## F3 — public/.workbuddy 备份混入 web 根与镜像（原 LOW / POTENTIAL / E1）

- 重定位：文件确认存在：public/.workbuddy/backup/pre-cleanup-20261013.tar.gz（1,348,366 字节）、public/.workbuddy/memory/2026-10-13.md。未 git 跟踪（public/.gitignore 忽略），但 Dockerfile:9 `COPY public ./public` 会复制 dotfile 目录进镜像（无 .dockerignore，确认）。
- **反例尝试（决定性成果）：原 claim 的防护声明"当前 express dotfiles:ignore 挡住"是错误的。** 链路重建：src/web/app.js:29-37 调 `express.static` 只传 `setHeaders`，serve-static 1.16.3（index.js:48,96）原样把 opts 传给 send，不注入 dotfiles；send 0.19.2（index.js:117-134）dotfiles undefined → 走 legacy 路径（index.js:559-582 + 924-928 `containsDotFile`）：请求路径含 dotfile 段时，若**末段不是 dotfile**则 `access = 'allow'`。因此 `GET /.workbuddy/backup/pre-cleanup-20261013.tar.gz`（末段为普通文件名）会被直接发送。请求 `/.workbuddy/`（末段是 dotfile 目录）才返回 404。404 fallback（app.js:41-43）只用固定 404.html，不构成额外拦截。
- **Verdict：CONFIRMED（E3）——较原 verdict 上调。** 规则说明：按 §2/Phase 9 约束本应只维持或下调，上调需新 E4/E5 证据；此处例外理由是原 verdict 所依赖的"当前被挡住"这一防护前提被**静态源码证据（E3，读依赖源码重建完整可达路径）**直接推翻，触发条件从"未来换静态层"变为"当前部署即可"，且 E3 满足 CONFIRMED 绑定规则。Phase 10 建议将 severity 从 LOW 上调至 MEDIUM（泄露内容为整站 pre-cleanup 备份与工作笔记，敏感性取决于 tar.gz 内容，未展开检查）。

## F4 — 灌满限速窗口压制广播（原 LOW / CONFIRMED / E3）

- 重定位：src/realtime/inbox.js:72-85。`ratePerMinute` 默认 20（config.js:24），滑动窗口 60s，超限直接 return（不广播）。
- 重建路径：SMTP onRcptTo（gateway.js:23-26）接受任意收件人 → 攻击者向受害者信箱发 20 封邮件填满窗口 → 受害者此后 60 秒内真实邮件广播被丢弃。受害者保持连接时窗口不清除（release 仅在 set.size===0 时删 rateWindow，inbox.js:32-35）。
- 反例尝试：① 无每 IP/每来源限速，攻击成本仅 20 次 SMTP 会话；② 无法区分"发件人内容"与"真实邮件"——窗口按收件信箱计数，无法排除攻击者邮件。均无法推翻。
- **Verdict：CONFIRMED（E3）**。维持。

## F5 — 容器以 root 运行（原 LOW / CONFIRMED / E3）

- 重定位：Dockerfile 全文 1-14 行，无 `USER` 指令，node:22-alpine 默认 root；deploy.sh:16-19 无 `--user`/`--cap-drop`。SMTP 绑 25 确需 CAP_NET_BIND_SERVICE，可用 `cap_add: NET_BIND_SERVICE` + 非 root 用户实现降权，注释（Dockerfile:12）也承认此路径。
- 反例尝试：无。docker 默认 root 运行是确定行为。
- **Verdict：CONFIRMED（E3）**。维持。

## F6 — 多收件人/Cc 只路由第一个匹配（原 LOW / CONFIRMED / E3）

- 重定位：src/realtime/inbox.js:66-68：`to.match(/([\w._-]+)@[\w._-]+/)` 取第一个匹配；gateway.js:64-66 仅取 `parsed.to?.text`。
- 重建路径：`To: a@x, b@x` 的 `parsed.to.text` 为逗号分隔全串，正则仅命中 a → b 的信箱无广播。
- 反例尝试（发现 claim 低估）：**Cc 完全不路由**——`parsed.cc` 从未被读取（gateway.js:64-66 只取 to），Cc 收件人一行代码都不会匹配。范围比原 claim 更大。
- **Verdict：CONFIRMED（E3）**。维持，影响范围修正为"多收件人只路由第一个 + Cc 全部丢弃"。

## F7 — config 数字 env 传非法值产生 NaN（原 LOW / POTENTIAL / E1）

- 重定位：src/config.js:11（PORT）、19（SMTP_PORT）、22（maxMailBytes）、24（ratePerMinute），均为 `Number(env(...))` 无校验。
- 反例尝试（部分修正）：PORT/SMTP_PORT=abc → NaN → `listen(NaN)` 在 Node 22 抛 `ERR_SOCKET_BAD_PORT`，**启动即崩（fail-fast），并非静默失效**——这部分危害比 claim 低；maxMailBytes=NaN → gateway.js:43 `size > NaN` 恒 false → 5MB 上限静默失效，`chunks` 无上限累积；ratePerMinute=NaN → inbox.js:77 `seen.length >= NaN` 恒 false → 限速静默失效——这两项静默失效成立。前提：仅部署者可控 env，非外部攻击面。
- **Verdict：POTENTIAL（E1）**。维持，表述修正：端口类非法值是启动崩溃而非静默；上限/限速类才是静默失效。

## F8 — uncaughtException 仅记日志不退出（原 LOW / CONFIRMED / E3）

- 重定位：src/server.js:10-12。handler 只 `log.error`，不 `process.exit`。Node 行为确定：注册 uncaughtException 后进程不退出。
- 反例尝试：无中间层。SIGINT/SIGTERM 路径（server.js:26-33）正常，与本问题无关。
- **Verdict：CONFIRMED（E3）**。维持（可靠性问题，非漏洞）。

---

## 9B — Missed Issue Search（漏报对账）

未以 Findings 为前提，重新枚举入口点与敏感 sink 对账：HTTP 静态层、/healthz、404 fallback、socket.io 事件、SMTP DATA/路由、前端邮件渲染。

- **N1（新增候选）** socket.io 层无每 IP 连接数/速率限制：单个客户端可并发开大量连接各自 claim 不同信箱，`socketsByMailbox` 条目随连接存活累积（inbox.js:19-24）；断开即释放（62 行已修复泄漏），需持续高并发维持。LOW / POTENTIAL / E1。与 F2 同为"资源限制缺失"主题但 sink 不同，Phase 10 可相邻表述。
- **INFO（新增）** HTML 邮件允许外域图片：CSP `img-src ... https:`（src/web/app.js:21）+ sandbox iframe 允许加载远程图片 → 收件人 IP 可被发件方追踪。临时邮箱场景影响极低，仅记录。
- 已查无异常：
  - 邮件渲染 XSS：iframe `sandbox="allow-popups"` 无 allow-scripts（public/js/app.js:142）、srcdoc 隔离 origin；列表项 innerHTML 均经 escapeHtml（47-51, 245-248）；subject/from 用 textContent（135-137）。
  - /healthz（app.js:39）仅 `{ok:true}`，无信息泄露。
  - 信箱名校验 allowlist（id.js:14-17）+ reserved 名单，无注入面；广播正则仅用于匹配，无 ReDoS（线性量词）。
  - gateway onData 的 done/dataEnded 双守卫（gateway.js:32-38, 52-94）覆盖 stream error/close 竞态，未发现回调重复执行路径。
  - socket.io `cors: { origin: false }`、`trust proxy 1`（app.js:11）——项目无基于 IP 的逻辑，无可利用面。

未覆盖项及原因：无——所有枚举入口点均已被 Findings 或上述对账项覆盖。

## 汇总

| ID | 原 verdict | 最终 verdict | E-level | 备注 |
|---|---|---|---|---|
| F1 | CONFIRMED/E3 | CONFIRMED | E3 | 维持 |
| F2 | POTENTIAL/E2 | POTENTIAL | E2 | 前提修正：有 60s idle 超时，慢速持续流仍可行 |
| F3 | POTENTIAL/E1 | **CONFIRMED** | E3 | **上调**：send 0.19.2 legacy dotfiles=allow，当前即可下载备份 |
| F4 | CONFIRMED/E3 | CONFIRMED | E3 | 维持 |
| F5 | CONFIRMED/E3 | CONFIRMED | E3 | 维持 |
| F6 | CONFIRMED/E3 | CONFIRMED | E3 | 维持，Cc 完全不路由（范围低估） |
| F7 | POTENTIAL/E1 | POTENTIAL | E1 | 维持，端口 NaN 实为启动崩溃（fail-fast） |
| F8 | CONFIRMED/E3 | CONFIRMED | E3 | 维持 |

新增：N1（LOW/POTENTIAL/E1）、INFO×1。无 FALSE_POSITIVE、无 DUPLICATE。
