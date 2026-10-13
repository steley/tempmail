#!/bin/sh
# tempmail 更新脚本 — 放服务器 /root/deploy.sh，chmod +x 后运行：./deploy.sh
set -e

cd /root/tempmail   # 仓库目录，不在 /root/tempmail 就改这行

echo "==> git pull"
git pull --ff-only

echo "==> docker build"
docker build -t tempmail .

echo "==> recreate container"
docker stop tempmail 2>/dev/null || true
docker rm tempmail 2>/dev/null || true
docker run -d --name tempmail \
  -p 25:25 -p 3000:3000 \
  --restart unless-stopped \
  tempmail

echo "==> waiting for healthz"
i=0
until curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 15 ]; then
    echo "FAILED: healthz 未就绪，查看日志：docker logs tempmail"
    exit 1
  fi
  sleep 1
done
echo "OK: 服务已就绪 (容器 ID: $(docker ps -qf name=tempmail))"
echo "提醒：本次改了前端 JS，记得清 Cloudflare 缓存或强刷。"
