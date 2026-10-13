# 06 Adversarial — tempmail-v2

攻击者视角：三个身份——恶意浏览器客户端、恶意 SMTP 发件人、网络中间人。

## A1. 恶意客户端：抢注/旁听/骚扰 — 见 S1（HIGH，CONFIRMED）
最有价值路径：猜中受害者自选信箱名 → `set shortid` → 实时收对方验证码邮件。不需要 0day，纯协议能力。附带：`set shortid` 无频控，可枚举常见名列表批量挂机。

## A2. 恶意 SMTP 发件人：洪水与骚扰 — 见 S2（MEDIUM）
- onRcptTo 对任何地址 250（gateway.js:23-26），配合无连接上限 → 25 端口可被当免费写入管道耗内存。
- 向同一信箱灌邮件触发 20/min 限速后广播被丢 → 对**受害者**形成压制：攻击者可以故意灌满目标信箱的限速窗口，把真实验证码邮件的推送也一起丢掉（inbox.js:77-83 限速对合法与恶意邮件一视同仁）。这构成**广播拒绝服务**：LOW/CONFIRMED (E3)。
- 邮件体注入巨量 HTML：前端只保 50 封（app.js:235），iframe 沙箱阻断脚本，影响受控。

## A3. 网络中间人：SMTP 明文 — INFORMATIONAL
- STARTTLS 被显式禁用（gateway.js:20）。入站邮件路径全程明文，链路上可读。对临时邮箱属常见取舍，但验证码类邮件同样暴露。

## A4. 恶意页面（第三方网站）能否利用？ — VERIFIED 不成立
- socket.io `cors:{origin:false}`（inbox.js:15）→ 跨域浏览器连接被拒（服务器不回 CORS 头）。非浏览器客户端不受 CORS 约束但那回到 A1。
- 邮件 HTML 在沙箱 iframe：无 allow-scripts/allow-forms/allow-top-navigation，无法逃逸到父页或顶窗。

## A5. DoS 前端渲染 — VERIFIED OK
- 巨型 html body 直接进 srcdoc，受 maxMailBytes 5MB 上限 + iframe 沙箱约束；列表 50 封封顶。
