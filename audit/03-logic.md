# 03 Functional & Logic — tempmail-v2

覆盖：全部入口点行为、协议一致性、边界条件。

## L1. 多收件人邮件只路由给第一个匹配的收件人 — LOW / CONFIRMED (E3)

- 证据：src/realtime/inbox.js:66-68 —— `const match = to.match(/([\w._-]+)@[\w._-]+/)` 取 `parsed.to?.text` 的**第一个**正则匹配。
- 影响：发往 `a@x, b@x`（或 To + Cc——simpleParser 的 `.to.text` 不含 Cc）的邮件只有第一个本地部分被广播；Cc 收件人收不到。
- 说明：临时邮箱场景影响有限，但属于真实行为偏差（邮件确实被服务端 250 接收了）。

## L2. `set shortid` 竞态下无冲突处理（共享即设计） — INFORMATIONAL

- 证据：src/realtime/inbox.js:19-24 —— claim 不检查占用，后到者与先到者共享同一信箱收同一批邮件。无任何鉴权（见 S1）。对本服务是"特性"，不单独立 vuln。

## L3. 解析失败返回 451（临时失败）是合理选择 — INFORMATIONAL

- 证据：src/smtp/gateway.js:75-80。发件方会重试而非退信，可接受。

## L4. 前端 mails[] 索引与列表对齐在 shift 后正确维护 — VERIFIED OK

- 证据：public/js/app.js:235-241 —— shift 后同步删最旧 li、currentMail--。列表 newest-first（prepend），openMail 用 `items.length-1-i === idx` 反向映射，一致。

## L5. 优雅关停：httpServer.close 后仍可能因活跃 socket 挂起，5s 强退兜底 — VERIFIED OK

- 证据：src/server.js:26-33（setTimeout(5000).unref() 兜底）。

未发现其它逻辑错误。
