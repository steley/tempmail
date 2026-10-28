#!/bin/sh
# tempmail update script — put at /root/deploy.sh on the server, chmod +x, run: ./deploy.sh
set -e

cd /var/www/tempmail   # repo directory; adjust if different

echo "==> git pull"
git pull --ff-only

echo "==> docker build"
# timestamped tag as well as :latest — once the old container is removed, this
# is the only way back to the image that was working
STAMP=$(date -u +%Y%m%d-%H%M%S)
docker build -t tempmail -t "tempmail:$STAMP" .

echo "==> recreate container"
PREV=$(docker inspect --format '{{.Image}}' tempmail 2>/dev/null || true)
docker stop tempmail 2>/dev/null || true
docker rm tempmail 2>/dev/null || true
start() {
  docker run -d --name tempmail \
    -p 25:25 -p 127.0.0.1:3000:3000 \
    -e SMTP_MAX_MAIL_BYTES=5242880 \
    -e SMTP_MAX_MAILS_PER_IP_MIN=24 \
    --memory 768m --pids-limit 100 \
    --restart unless-stopped \
    "$1"
}
start "tempmail:$STAMP"

echo "==> waiting for healthz"
i=0
until curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 15 ]; then
    echo "FAILED: healthz not ready — check logs: docker logs tempmail"
    if [ -n "$PREV" ]; then
      echo "==> rolling back to the image that was running before"
      docker rm -f tempmail 2>/dev/null || true
      start "$PREV"
    fi
    exit 1
  fi
  sleep 1
done
echo "OK: service is up (container: $(docker ps -qf name=tempmail))"
echo "Reminder: HTML is edge-cached (s-maxage=3600) and frontend JS is immutable-cached — purge Cloudflare cache after deploys that change pages/JS."
