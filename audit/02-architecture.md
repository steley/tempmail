# 02 Architecture & Data Flow — tempmail-v2

## 架构

单 Node 进程，三个子系统共享内存态（无持久化、无数据库）：

```
外网邮件 (MX→25)                 浏览器
      │                            │ HTTP:3000 (静态) / WSS
      ▼                            ▼
SMTPServer ── onData ── simpleParser ── gateway.emit('mail')
                                                │
                                          realtime/inbox.js
                                                │ 按收件人本地部分匹配 socketsByMailbox
                                                ▼
                                        socket.emit('mail') → 前端渲染
```

## 关键数据流

1. **邮件入站**：SMTP DATA stream 手动分块（上限 5MB，超限 destroy）→ Buffer.concat → simpleParser → 归一为 {headers{from,to,subject,date}, html, text} → EventEmitter 'mail'。
2. **信箱寻址**：'mail' 事件里用正则 `/([\w._-]+)@[\w._-]+/` 从 `mail.headers.to`（纯文本）提取本地部分 → 查 `socketsByMailbox` Map → 广播给该信箱全部 socket（滑动窗口 20/min 限速）。
3. **信箱认领**：客户端 emit 'set shortid' / 'request shortid' → 服务端校验（允许 1–32 位 [a-z0-9._-] + 保留名单）→ claim（一个信箱可多个 socket 共享，无任何鉴权）。
4. **前端渲染**：headers 走 escapeHtml 后 innerHTML；正文 html 塞入 `sandbox="allow-popups"`（无 allow-scripts）的 iframe srcdoc；纯文本 fallback 经 escapeHtml 包 <pre>；raw 视图用 textContent。
5. **状态**：内存 Map（socketsByMailbox / rateWindow），进程重启即丢；前端用 localStorage 恢复信箱名。

## 信任边界

- 任意公网 SMTP 客户端 → 服务（authOptional，禁 AUTH/STARTTLS，纯 MX 用途）
- 任意浏览器 → WebSocket 协议（CORS origin:false 仅限浏览器层面；非浏览器客户端可直接连 ws）
- 邮件内容 = 不可信输入，进入前端 iframe 渲染路径
- 部署：容器以 root 跑（需绑 25 端口），deploy.sh 以 root 执行
