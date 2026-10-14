# VPS 系统层网络调优（DigitalOcean 新加坡节点）

前提：流量几乎全部来自 Cloudflare 回源（HTTP）+ SMTP 直连。调优目标是让回源 TCP 连接建得快、复用得久、拥塞窗口涨得快。

## 1. 内核网络参数（最大收益）

```sh
cat >> /etc/sysctl.d/99-tempmail.conf <<'EOF'
# --- BBR 拥塞控制：跨境长肥管道收益最明显 ---
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# keep-alive 连接空闲后不重置拥塞窗口（CF 复用连接时吞吐不归零）
net.ipv4.tcp_slowstart_after_idle = 0

# TCP Fast Open：回源握手省一个 RTT
net.ipv4.tcp_fastopen = 3

# 连接队列：防突发回源排队丢包
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096

# TIME_WAIT 快速回收复用（大量短连接 SMTP 场景有用）
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# MTU 探测：避免隧道场景的分片黑洞
net.ipv4.tcp_mtu_probing = 1

# 文件描述符上限
fs.file-max = 2097152
EOF

sysctl --system
```

验证 BBR 生效：

```sh
sysctl net.ipv4.tcp_congestion_control   # 应输出 bbr
```

> 注：Docker 容器共享宿主机内核，以上参数容器内直接受益，无需改容器。

## 2. Docker / 容器

- 容器 `--memory 256m`：Node 峰值接近上限时会触发 GC 抖动甚至 OOM kill。用 `docker stats` 观察一周，若经常 >200m，提到 384m。
- `--pids-limit 100` 偏紧，socket.io 连接多时线程数上涨可能触顶，必要时提到 200。

## 3. systemd（如容器外跑 node 才需要；当前是 Docker，可跳过）

```ini
# /etc/systemd/system/tempmail.service.d/limits.conf
[Service]
LimitNOFILE=65535
```

## 4. SMTP 侧

- 端口 25 是明文 SMTP，回程线路质量不受你控制，无需额外调优；上面的 BBR/tw_reuse 对入站会话同样生效。

## 5. 一次性自检命令

```sh
# 当前生效值
sysctl net.ipv4.tcp_congestion_control net.core.somaxconn net.ipv4.tcp_fastopen

# TIME_WAIT 积压（若常态 >1 万，说明 tw_reuse 没生效）
ss -s

# 容器资源水位
docker stats --no-stream tempmail
```
