# Tempmail

[English](README.md) | 简体中文

基于 WebSocket 实时收件的临时邮箱服务。对 forsaken-mail（2015 年代的
Node.js 项目）的全面重写，采用现代化、依赖干净的技术栈。

<p align="center">
  <img src="docs/screenshot.png" alt="TempMail.cc — 实时收件的临时邮箱" width="800">
</p>

## 在线演示

生产实例部署在 **[tempmail.cc](https://tempmail.cc/)** —— 打开即得一个一次性
邮箱，无需注册。

## 架构

```
src/
├── server.js            入口：http + express + socket.io + smtp
├── config.js            基于环境变量的配置
├── lib/id.js            邮箱名生成与校验（白名单）
├── smtp/gateway.js      入站 SMTP（smtp-server + mailparser）
├── realtime/inbox.js    socket.io 层，邮箱 -> socket 注册表
└── web/app.js           express 静态托管 + healthz
public/                  前端（原生 JS，协议保持不变）
scripts/e2e.mjs          端到端投递测试
```

## 运行

```bash
npm install
npm start                     # web 端口 3000，smtp 端口 25
PORT=8080 SMTP_PORT=2525 npm start   # 适合本地开发的端口
```

## 环境变量

| 变量                | 默认值  | 说明                              |
|---------------------|---------|-----------------------------------|
| `PORT`              | 3000    | web 端口                          |
| `HOST`              | 0.0.0.0 | web 绑定地址                      |
| `SMTP_PORT`         | 25      | 入站 SMTP 端口                    |
| `SMTP_HOST`         | 0.0.0.0 | SMTP 绑定地址                     |
| `SMTP_MAX_MAIL_BYTES` | 5242880 | 单封邮件最大字节数              |
| `SMTP_RATE_PER_MIN` | 20      | 每邮箱实时广播频率限制             |
| `ANALYTICS_DISABLED` | (未设置) | 设为 `1` 时从 CSP 中移除 Google Analytics 来源 |
| `ANALYTICS_CSP_EXTRA` | (未设置) | 以空格分隔的来源列表，为自选分析服务加白（script-src + connect-src） |

## 测试

```bash
PORT=3100 SMTP_PORT=2525 npm start &   # 终端一
node scripts/e2e.mjs                   # 终端二
```

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
- 固有的设计注意点（与原版一致）：任何人都可以 `set shortid` 到任意合法名称
  并实时收到该邮箱的邮件。这就是产品本身。
- 滥用防护：每邮箱广播频率限制（`SMTP_RATE_PER_MIN`）、web 端安全响应头
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
docker rm -f tempmail
docker build -t tempmail .
docker run -d --name tempmail -p 3000:3000 -p 25:25 --restart unless-stopped tempmail
```

### 故障排查

| 现象 | 排查方向 |
|------|----------|
| `docker run` 报 `port 25 already allocated` | 旧容器仍占用端口：`docker ps -a \| grep 25`，然后 `docker rm -f <名称>` |
| 全链路访问站点都 404 | 直接验证源站：`curl -sI http://127.0.0.1:3000/` —— 若源站也是 404，用最新代码重新构建镜像 |
| 页面能打开但收件箱一直"连接中…" | WS 握手：`curl -s "https://your.domain/socket.io/?EIO=4&transport=polling"` 应返回 `0{"sid":...}`；若正常，强制刷新——浏览器/CF 缓存了旧版前端 JS |
| 日志显示已收信但页面不显示 | 收件人 local part 必须与所声称的邮箱名一致；检查 `docker logs` 中的 `[smtp] accepted mail` 行 |
| `nginx recv() failed (104)` 频发 | 容器在重启——`docker ps` 查看是否重启循环，再 `docker logs tempmail` |
