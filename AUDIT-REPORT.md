# AUDIT REPORT — tempmail-v2

- 日期：2026-10-13 · 模式：完整审计（Phase 1→10）· 档位：small（9 文件 / ~646 LOC，证据上限 E3）
- 方法：全入口点枚举 + sink 反向追踪；Phase 9 由独立子代理复核，全部 verdict 基于重新定位的源码证据
- 结果：**1 HIGH / 2 MEDIUM / 6 LOW / 1 INFO**，0 FALSE_POSITIVE。完整过程产物见 `audit/01..09-*.md`

---

## HIGH

### F1 · 信箱无鉴权：知道/猜中名字即可实时旁听任意信箱 — CONFIRMED (E3)
`src/realtime/inbox.js:19-24,48-60,65-87`
任意客户端 `emit('set shortid', name)` 即可 claim 任意非保留信箱名，无 token/无拥有者校验；该信箱随后收到的每封邮件广播给所有 claim 者。服务公网开放（deploy.sh `-p 25:25 -p 3000:3000`）。随机 8 位默认名（~8.5e11 空间）暴破不可行，安全；但用户自选名（前端允许）多为低熵词，且 localStorage 恢复机制鼓励长期复用同一地址——攻击者猜中一个名字就能实时收对方的验证码邮件。
修复方向：claim 已有活跃监听者时拒绝或要求凭据（首次认领签发 token）；至少对自选名做"先到先得 + 冲突拒绝"而非静默共享。

## MEDIUM

### F2 · SMTP 无并发/总量限制，慢连接可内存耗尽 — POTENTIAL (E2)
`src/smtp/gateway.js:17-105` + `deploy.sh:16-19`
单封 5MB 上限有了，但无 `maxConnections`、无总量控制，容器无 `--memory`。大量并发慢速流式连接各自缓冲至 5MB 即可耗尽内存。前提：25 端口直接公网暴露（当前架构）。注：验证者复核发现 smtp-server 3.19.x 默认有 60s idle 超时，完全空闲的 slowloris 不可行，但慢速持续流可绕过——故维持 POTENTIAL 而非 CONFIRMED。
修复方向：`maxConnections` + docker `--memory` + 降权（见 F5）。

### F3 · public/ 里的本地备份数据当前即可从公网下载 — CONFIRMED (E3)
`public/.workbuddy/backup/pre-cleanup-20261013.tar.gz`
验证者读 send 0.19.2 源码（express.static 底层）确认其 dotfiles legacy 行为：路径**末段**非点文件即放行——`.workbuddy` 是目录不是末段，因此 `GET /.workbuddy/backup/pre-cleanup-20261013.tar.gz` 现在就能 200 返回。我把原判"被 dotfiles:ignore 挡住"推翻为 CONFIRMED，LOW→MEDIUM。`Dockerfile:9` 的 `COPY public ./public` 还会把备份打进镜像。同目录还有 memory 笔记文件。
修复方向：立刻把 `public/.workbuddy/` 移出 web 根（或至少加入 `.gitignore` 并从镜像 COPY 中排除），并检查它是否已被搜索引擎/CDN 缓存。

## LOW

### F4 · 灌满限速窗口可压制目标信箱的邮件广播 — CONFIRMED (E3)
`src/realtime/inbox.js:73-85` 限速对恶意与合法邮件一视同仁：攻击者向目标信箱灌 20 封/分钟即让后续真实邮件的推送全部丢弃（邮件本身仍被 250 接收，仅前端看不到）。缓解：限速时按发件人区分或保底推送。

### F5 · 容器以 root 运行 — CONFIRMED (E3)
`Dockerfile` 无 USER 指令。25 端口可改用非 root + `--cap-add NET_BIND_SERVICE`（cap_net_bind_service=10），配合 F2 的 --memory 一起改。

### F6 · 多收件人/Cc 邮件路由不全 — CONFIRMED (E3)
`src/realtime/inbox.js:66-68` 只取 `parsed.to.text` 的第一个正则匹配；验证者补充：Cc（gateway.js:64-66 只读 parsed.to）完全不路由。收到的邮件（已 250）静默丢失。

### F7 · config 数字 env 非法值 → 限速/尺寸上限静默失效 — POTENTIAL (E1)
`src/config.js:22,24` `SMTP_MAX_MAIL_BYTES`/`SMTP_RATE_PER_MIN` 传非数字得 NaN：`seen.length >= NaN` 恒 false，限速静默关闭。端口类 env 是启动崩溃（fail-fast），无问题。修复：`Number.isFinite` 校验。

### F8 · uncaughtException 仅记日志不退出 — CONFIRMED (E3)
`src/server.js:10-12` 进程带伤运行。建议记录后 `process.exit(1)`，交给 `--restart unless-stopped` 拉起。

### N1 · socket.io 无每 IP 连接数限制（Phase 9B 对账新增）— POTENTIAL (E1)
`src/realtime/inbox.js:15` 未设 `io.path` 限流或连接数上限；WS 握手成本低于 SMTP，可大量空连接占 fd。影响低于 F2，列存档。

## INFO

- **I1**：邮件 HTML 内外域图片（含追踪像素）可追踪查看者 IP——临时邮箱产品层面的常见取舍。
- SMTP 明文（STARTTLS 显式禁用，gateway.js:20）为设计取舍，链路上邮件可读。

## 附录（封顶压缩项，细节见 audit/03/07）

- 前端 mails[] 索引在"查看最旧邮件时收到第 51 封"序列下 active 高亮可能错位（仅视觉）。
- 无 CI 可跑的自动化测试；日志无脱敏/截断。

## 覆盖声明

- 入口点 100% 枚举（HTTP/SMTP/WS/信号/脚本）；XSS、注入、URL fetch、child_process 类 sink 全部反向追踪完毕（audit/04 §S7 清单）。
- 依赖仅做版本面核对，未跑 CVE 扫描。
- 结论依赖的部署前提：25/3000 直接公网暴露、前置 Cloudflare（HSTS 等未验证，不入 Finding）。
- Phase 9 已由独立子代理执行（未与发现阶段共享上下文）；F2/F3/F6/F7 在复核中被修正——验证有效。
