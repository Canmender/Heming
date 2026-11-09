#!/usr/bin/env bash
# 和鸣裸机部署 · 发版（每次上线跑一遍）
#
#   deploy/install-app.sh <部署包.tar.gz> <版本号>
#   deploy/install-app.sh /root/heming-d.25.1.6.0.tar.gz d.25.1.6.0
#
# 顺序：存档 → 解包 → 装生产依赖 → 落地 nginx/systemd → 起服务 → 自检。
#
# **云端不编译、不跑 vite**：包里直接带 `packages/{shared,server}/dist` 与
# `packages/web/dist`，也就是本地门禁 `pnpm -r build` 的产物原样上线。
# 这台机只有 1613MB 物理内存，tsc+vite 峰值 1.0–1.4G，历史上连撞两次整机失联；
# 而且「本机构建什么就发什么」还消掉了云端构建与本地验证不一致的可能。
# 见 docs/deploy.md §12。
#
# 回滚：/opt/heming/keep 里留着每一版的包，`install-app.sh <旧包> <旧版本>` 即回放。
set -euo pipefail

TAR="${1:?用法: install-app.sh <tar.gz> <版本号>}"
VERSION="${2:?用法: install-app.sh <tar.gz> <版本号>}"

APP=/opt/heming/app
KEEP=/opt/heming/keep
APP_USER="${APP_USER:-heming}"
UNIT=heming-api.service

[ -f "$TAR" ] || { echo "找不到部署包：$TAR" >&2; exit 1; }
mkdir -p "$KEEP"

echo "== 1/5 存档 $VERSION =="
# 先存原始包再解：解包会覆盖同名文件，事后就没法拿回这一版的完整输入了。
cp -f "$TAR" "$KEEP/heming-$VERSION.tar.gz"

echo "== 2/5 解包与产物校验 =="
# 解包是**覆盖式**（`tar -x` 到已有目录），所以上一版存在、这一版已删除/改名的目录会残留下来。
# 残留目录仍在 `packages/*` / workspace 里时，`pnpm install --frozen-lockfile` 会把它当成多出来的
# workspace 项目（清单与 lock 对不上）而失败——d.122 把 pet-widget 迁到 `plugin-kit/plugins/` 时就撞上了。
# 已知的迁移清扫放在这里（幂等）：
rm -rf "$APP/packages/pet-widget"   # d.122：迁至 plugin-kit/plugins/pet-widget
tar -xzf "$KEEP/heming-$VERSION.tar.gz" -C "$APP"
# 空站点/缺编译产物都不会在启动时报错，只会白屏或 502——比缺文件更难查，当场拦住。
[ -f "$APP/packages/web/dist/index.html" ] || { echo "包里缺 packages/web/dist/index.html" >&2; exit 1; }
[ -f "$APP/packages/server/dist/index.js" ] || { echo "包里缺 packages/server/dist/index.js（本地没跑 pnpm -r build？）" >&2; exit 1; }
[ -f "$APP/packages/shared/dist/index.js" ] || { echo "包里缺 packages/shared/dist/index.js" >&2; exit 1; }
got="$(node -p "require('$APP/package.json').hemingVersion")"
[ "$got" = "$VERSION" ] || { echo "版本不符：包内 $got，参数 $VERSION" >&2; exit 1; }
echo "  包内版本 $got，web/api 产物就位"

echo "== 3/5 安装生产依赖 =="
cd "$APP"
pnpm install --frozen-lockfile --prod --filter @heming/server...

echo "== 4/5 属主、nginx 站点与 systemd =="
chown -R "$APP_USER:$APP_USER" "$APP"
chmod -R a+rX "$APP/packages/web/dist"   # nginx worker（www-data）要能遍历并读取

install -m 644 "$APP/deploy/nginx-heming.conf" /etc/nginx/sites-available/heming
mv -f /etc/nginx/sites-enabled/default /root/nginx-default-site.bak 2>/dev/null || true
ln -sf /etc/nginx/sites-available/heming /etc/nginx/sites-enabled/heming
if ! nginx -t; then
  mv -f /root/nginx-default-site.bak /etc/nginx/sites-enabled/default
  nginx -t || true
  echo "nginx 配置校验失败，已恢复默认站点" >&2
  exit 1
fi
systemctl reload nginx

install -m 644 "$APP/deploy/$UNIT" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null 2>&1 || true
systemctl restart "$UNIT"

echo "== 5/5 自检 =="
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:8787/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:8787/api/health" || {
  echo "API 未就绪，最后 40 行日志：" >&2
  journalctl -u "$UNIT" -n 40 --no-pager >&2
  exit 1
}
echo
systemctl is-active nginx "$UNIT"
echo "INSTALL DONE: $VERSION"
