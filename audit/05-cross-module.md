# 05 Cross-Module — tempmail-v2

模块对：config ↔ gateway/inbox/web；gateway ↔ inbox（EventEmitter 契约）；server ↔ web ↔ inbox；前端 ↔ 协议 ↔ 服务端。

## X1. 协议契约前后端一致 — VERIFIED OK

- emit/on 事件名逐一对齐：'request shortid'/'set shortid'/'shortid'/'shortid rejected'/'mail'（inbox.js vs public/js/app.js）。e2e.mjs 同协议验证通过路径。

## X2. 信箱名归一化跨层一致 — VERIFIED OK

- 服务端 lowercase + trim（inbox.js:49）；路由侧 `to.toLowerCase()`（inbox.js:66）；前端取 @ 前部分（app.js:113）。isValidMailboxName 只收小写。一致。

## X3. 限速 Map 生命周期跨模块正确 — VERIFIED OK

- rateWindow 仅在有监听者时创建（inbox.js:74-75），最后一个 socket 离开时随信箱一起删除（34）。`seen.warned` 挂在数组对象上，随 Map 删除重置，无误报累积。注意：超限邮件**仅丢弃广播**，邮件本身已被 SMTP 250 接收并计入限速——行为一致（防的是 socket 洪水不是存储）。

## X4. config 数字 env 无 NaN 防护 — LOW / POTENTIAL (E1)

- src/config.js:11/19/22/24 —— `Number(env(...))` 若运维传非法值（如 SMTP_RATE_PER_MIN="abc"）得 NaN：NaN 传播后 `seen.length >= NaN` 恒 false → 限速静默失效；`maxMailBytes=NaN` 使 smtp-server size 选项无效。仅人为配置错误才触发，无外部可达路径。

## X5. gateway→inbox 事件对象形状：前端 `mail.text` 依赖服务端 `text` 字段存在 — VERIFIED OK

- gateway.js:71 恒有 `text: parsed.text ?? ''`；app.js:140 fallback 正常。
