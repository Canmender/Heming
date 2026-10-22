#!/usr/bin/env bash
# 和鸣裸机部署 · 一次性装机（Ubuntu 24.04，2C2G 轻量服务器）
#
# 为什么不用 Docker（实测代价）：这台机 1613MB 物理内存、2 vCPU。
# 镜像内跑 tsc+vite 峰值 1.0–1.4G，加上 dockerd + containerd + buildkit 常驻，
# 部署 d.25 时连撞两次整机失联（TCP 握手成功但 60 秒不回一个字节，异网 522），
# 只能控制台重置。裸机跑「node + nginx」把这两层常驻开销整个去掉。
#
# 幂等：重复执行只做增量，不会把已装好的 Node 再下一遍。
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.18.0}"
NODE_MIRROR="${NODE_MIRROR:-https://registry.npmmirror.com/-/binary/node}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
APP_USER="${APP_USER:-heming}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"   # 与 pnpm-lock.yaml 的 lockfileVersion 同代

export DEBIAN_FRONTEND=noninteractive

echo "== 1/6 系统包 =="
apt-get update -y -qq
# 不需要 build-essential：服务端依赖树里没有需编译的原生模块
# （SQLite 用 Node 24 内置的 node:sqlite，express/ws/zod 都是纯 JS），
# 装它只是白白多几百 MB 与两分钟 apt。将来引入原生依赖时再加回来。
apt-get install -y -qq curl ca-certificates xz-utils nginx

echo "== 2/6 swap =="
# pnpm install 与 tsc 峰值会顶到 1.6G，无 swap 时直接触发整机 OOM（本轮两次事故）。
# 这里**写进 fstab**：裸机部署里 swap 属于配置的一部分，不再是临时兜底。
if ! swapon --show=NAME --noheadings | grep -q .; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || { dd if=/dev/zero of=/swapfile bs=1M count=2048; }
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=15 >/dev/null
free -m | head -3

echo "== 3/6 Node $NODE_VERSION =="
# 不用 apt 的 nodejs：Ubuntu 24.04 给的是 18.x，而根 package.json 要求 engines.node >= 24。
# 走 npmmirror 的二进制包（阿里系镜像，境内出口快）。
if [ ! -x /usr/local/bin/node ] || [ "$(/usr/local/bin/node -v)" != "$NODE_VERSION" ]; then
  curl -fL "$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz
  mkdir -p /usr/local/lib/nodejs
  tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
  base="/usr/local/lib/nodejs/node-$NODE_VERSION-linux-x64"
  for b in node npm npx corepack; do ln -sf "$base/bin/$b" "/usr/local/bin/$b"; done
  rm -f /tmp/node.tar.xz
fi
node -v
# npm 全局前缀与 pnpm 都必须装在 /usr/local 下：软链指向 /usr/local/lib/nodejs/... 时
# `npm i -g` 的默认 prefix 就是那个解包目录，容易装成找不到命令。
npm config set prefix /usr/local --global
# registry 写给 /root/.npmrc 而不是全局 npmrc：pnpm 与 npm 都会读 userconfig，
# 而 npm 的 globalconfig 路径随 prefix 变化（实测容易只对上其中一个）。
npm config set registry "$NPM_REGISTRY"
command -v pnpm >/dev/null 2>&1 && [ "$(pnpm -v)" = "$PNPM_VERSION" ] || npm install -g "pnpm@$PNPM_VERSION"
# 不要再手动 ln -sf 一个 pnpm 到 /usr/local/bin：Node 官方 tarball 的 bin/ 里根本没有
# pnpm（只有 node/npm/npx/corepack），ln -sf 会把 npm 装好的真链接覆盖成悬空链接，
# 表现是 `pnpm: command not found`（本轮踩过）。prefix=/usr/local 时 npm 自己放对位置。
pnpm -v

echo "== 4/6 运行账号与目录 =="
# 不建家目录：进程只写 /var/lib/heming，ProtectHome=true 下有家目录也进不去；
# 建了反而给 --system 账号留个没人维护的 /home/heming。
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin "$APP_USER"
mkdir -p /opt/heming/app /opt/heming/updates /opt/heming/keep /var/lib/heming /etc/heming
chown -R "$APP_USER:$APP_USER" /var/lib/heming /opt/heming/updates
# keep/ 存每一版部署包：裸机没有镜像 tag，回滚就是拿旧包重放 install-app.sh
chmod 755 /opt/heming /opt/heming/keep

echo "== 5/6 环境变量文件 =="
# 已存在就不覆盖——里面可能改过预设账号、TURN 等；要改直接编辑该文件。
if [ ! -f /etc/heming/api.env ]; then
  cat > /etc/heming/api.env <<'ENV'
NODE_ENV=production
# 只绑回环：对外一律经 nginx:80，进程本身不对公网开放
HOST=127.0.0.1
PORT=8787
HEMING_DB_PATH=/var/lib/heming/heming.db
HEMING_SEED_USERS=admin:admin
HEMING_FILE_QUOTA_MB=200
ENV
  chmod 640 /etc/heming/api.env
fi

echo "== 6/6 nginx 站点 =="
REPO="${REPO:-/opt/heming/app}"
# 首次装机时源码还没解包（install-app.sh 才解），这里容错跳过——
# 站点配置由 install-app.sh 负责落地与 reload。
if [ -f "$REPO/deploy/nginx-heming.conf" ]; then
  install -m 644 "$REPO/deploy/nginx-heming.conf" /etc/nginx/sites-available/heming
  ln -sf /etc/nginx/sites-available/heming /etc/nginx/sites-enabled/heming
  rm -f /etc/nginx/sites-enabled/default    # 默认站点占着 80 的 default_server
  nginx -t
  systemctl reload nginx
else
  echo "  （源码尚未解包，站点配置留给 install-app.sh）"
fi
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl is-active nginx
echo "PROVISION DONE"
