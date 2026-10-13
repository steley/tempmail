# 07 Quality / Reliability — tempmail-v2

## Q1. 吞掉 uncaughtException 后继续运行 — LOW / CONFIRMED (E3)
- src/server.js:10-12 —— 捕获后仅打日志，进程留在可能已不一致的状态（Node 官方建议记录后退出重建）。Docker --restart unless-stopped 会在退出时拉起，比硬扛更安全。

## Q2. 无任何测试（仅一个冒烟 e2e.mjs） — INFORMATIONAL
- scripts/e2e.mjs 依赖本机 python3 + 2525 端口手工启动，非 CI 可跑测试。~650 LOC 项目可接受，但 inbox 路由/限速逻辑值得单测。

## Q3. 日志含完整外部输入 — INFORMATIONAL
- logger 用 console 直接输出，SMTP from、请求 URL 进日志（gateway.js:73、app.js:47）。无脱敏/截断，超长 header 可刷爆日志体积（受限于 smtp-server 对命令行的长度限制，影响低）。

## Q4. 依赖健康 — VERIFIED OK（版本面）
- express ^4.21.2（4.x 修复线）、socket.io ^4.8.1、mailparser ^3.7.2、smtp-server ^3.13.6；npm ci --omit=dev 锁定安装。未做 CVE 扫描（超出本轮范围，small 档）。

## Q5. 前端兼容性小问题 — INFORMATIONAL
- public/js/app.js:238 `list[list.length-1].remove()` 假设 li 数量与 mails 同步（closed mail 不删 li），对齐逻辑在极端序列下（查看第 50 封最旧邮件时收到第 51 封）currentMail 递减后 active 高亮可能错位——仅视觉错位，无功能损坏（低置信 POTENTIAL，不单独立 Finding）。

## Q6. Dockerfile 无镜像内健康检查、无 --memory 限制 — INFORMATIONAL
- healthz 已有端点，deploy.sh 轮询兜底；建议补 --memory 配合 S2。
