# 08 Findings（归一化）

来源：03/04/06/07。同根因已合并（S1=A1；S2+A2部分合并为 S2；A2 限速压制单列为 F4）。

| ID | Severity | Verdict | Evidence | Title | 位置 |
|---|---|---|---|---|---|
| F1 | HIGH | CONFIRMED | E3 | 信箱无鉴权：知道/猜中名字即可实时旁听任意信箱 | src/realtime/inbox.js:19-24,48-60,65-87 |
| F2 | MEDIUM | POTENTIAL | E2 | SMTP 无连接数/超时限制，并发 5MB 慢连接可内存耗尽 | src/smtp/gateway.js:17-105；deploy.sh 无 --memory |
| F3 | LOW | POTENTIAL | E1 | public/.workbuddy 本地备份混入 web 根与 Docker 镜像（当前 express dotfiles:ignore 挡住，换静态层即泄露） | public/.workbuddy/backup/*.tar.gz；Dockerfile:9 |
| F4 | LOW | CONFIRMED | E3 | 灌满目标信箱限速窗口可压制其全部邮件广播（广播层 DoS） | src/realtime/inbox.js:73-85 |
| F5 | LOW | CONFIRMED | E3 | 容器以 root 运行（可用 NET_BIND_SERVICE 降权） | Dockerfile |
| F6 | LOW | CONFIRMED | E3 | 多收件人/Cc 邮件只路由给第一个匹配收件人 | src/realtime/inbox.js:66-68 |
| F7 | LOW | POTENTIAL | E1 | config 数字 env 传非法值产生 NaN，限速/尺寸上限静默失效 | src/config.js:11,19,22,24 |
| F8 | LOW | CONFIRMED | E3 | uncaughtException 仅记日志不退出，进程带伤运行 | src/server.js:10-12 |

前置声明：F1/F4/F5 依赖"25/3000 直接公网暴露"这一当前部署事实；F2 依赖同前提交 + smtp-server 默认无超时；F3 依赖"若未来在 express 前再加静态层"这一假设。无 HSTS 依赖 Cloudflare 层配置（未验证，不入 Finding）。

共 8 条：HIGH 1 / MEDIUM 1 / LOW 6。无 CRITICAL。LOW 封顶 5——F5/F6/F7/F8 中超出封顶的按重要性保留 F5（部署安全），F6/F7/F8 在报告中压缩为附录级。
