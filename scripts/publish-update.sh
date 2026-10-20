#!/usr/bin/env bash
# 发布自动更新包到云服务器的 /opt/heming/updates。
#
# 为什么需要这个脚本：electron-updater 只认「同一目录下有 latest.yml + 安装包」
# 这一套约定。谁上传、按什么顺序、要不要清理旧包，手工做容易漏——而漏了的后果
# 是客户端检查更新时报「解析 update-info 失败」，且日志里看不出是缺哪个文件。
#
# 用法：
#   bash scripts/publish-update.sh            # 发布当前 release 目录里的包
#   bash scripts/publish-update.sh --dry-run  # 只打印要做什么，不真传
#
# 环境变量：
#   HEMING_SSH_PWD  服务器 root 密码（必填，不落盘）
#   HEMING_UPDATE_HOST  默认 47.92.39.184
#   HEMING_UPDATE_DIR   默认 /opt/heming/updates
set -euo pipefail

# Git Bash（MSYS）会把形如 /opt/x 的参数自动转成 Windows 路径（E:/.../opt/x），
# 于是 paramiko 收到的是本地路径，文件「上传成功」其实传到了本机磁盘——
# 日志完全看不出异常，只有云端目录里没文件才发现。
# 这里一关就够（后面的 Python 通过 argv 传路径，不经过 MSYS 转换）。
export MSYS_NO_PATHCONV=1

HOST="${HEMING_UPDATE_HOST:-47.92.39.184}"
REMOTE_DIR="${HEMING_UPDATE_DIR:-/opt/heming/updates}"
DRY_RUN="${1:-}"

# 远端目录必须是绝对 POSIX 路径。若被 MSYS 转成了盘符路径（`E:/...`），立刻停下——
# 继续执行只会把「上传成功」的假象留给下一次排查。
case "$REMOTE_DIR" in
  /*) : ;;
  *) echo "错误：远端目录不是绝对 POSIX 路径：$REMOTE_DIR" >&2
     echo "（MSYS 路径转换作祟时会出现 E:/... 形式）" >&2
     exit 1 ;;
esac

if [ -z "${HEMING_SSH_PWD:-}" ]; then
  echo "错误：未设置 HEMING_SSH_PWD" >&2
  exit 1
fi

# 产物目录与仓库内一致（由 scripts/release-dir.mjs 解析，见 docs/VERSION-MANAGEMENT.md）
RELEASE_DIR="${HEMING_RELEASE_DIR:-D:/Heming/packages/desktop/release}"
if [ ! -d "$RELEASE_DIR" ]; then
  echo "错误：找不到产物目录 $RELEASE_DIR" >&2
  exit 1
fi

VERSION="$(node scripts/version.mjs 2>/dev/null | awk '/应用版本/ {print $NF}')"
if [ -z "$VERSION" ]; then
  echo "错误：读不到当前版本号" >&2
  exit 1
fi

# electron-updater 的约定：latest.yml 与安装包必须同目录，且 latest.yml 里的
# path 要与实际文件名对得上。中文文件名 + 空格在 URL 里要编码，这里直接用文件
# 已在 latest.yml 中写好的名字，避免手工拼错。
YML="$(ls -t "$RELEASE_DIR"/latest*.yml 2>/dev/null | head -1 || true)"
if [ -z "$YML" ]; then
  echo "错误：未找到 latest.yml——打包时需带 --publish never 之外的发布配置才会生成。" >&2
  echo "请确认 build.publish 已配置，且本次构建产出了 latest.yml。" >&2
  exit 1
fi

SETUP="$(ls -t "$RELEASE_DIR"/*"${VERSION}".exe 2>/dev/null | head -1 || true)"
BLOCKMAP="$(ls -t "$RELEASE_DIR"/*"${VERSION}".exe.blockmap 2>/dev/null | head -1 || true)"

echo "版本    : $VERSION"
echo "清单    : $(basename "$YML")"
echo "安装包  : $(basename "${SETUP:-<未找到>}")"
echo "差分索引: $(basename "${BLOCKMAP:-<未找到>}")"
echo "目标    : root@${HOST}:${REMOTE_DIR}"

if [ -z "$SETUP" ]; then
  echo "错误：找不到版本 $VERSION 的安装包" >&2
  exit 1
fi

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "[dry-run] 未实际上传"
  exit 0
fi

# 先建目录再传，避免 nginx 挂载点不存在导致容器启动失败
PY="C:/Users/ADMIN/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
[ -x "$PY" ] || PY=python3

"$PY" - "$HOST" "$REMOTE_DIR" "$YML" "$SETUP" "$BLOCKMAP" <<'PYEOF'
import os, sys, paramiko

host, remote_dir, yml, setup = sys.argv[1:5]
blockmap = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
pwd = os.environ["HEMING_SSH_PWD"]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(host, username="root", password=pwd, timeout=20)

_, out, err = c.exec_command(f"mkdir -p {remote_dir}", timeout=60)
if err.channel.recv_exit_status() != 0:
    print("建目录失败:", err.read().decode("utf-8", "replace"))
    sys.exit(1)
print("目录已就绪:", remote_dir)

sftp = c.open_sftp()
for local in [p for p in (yml, setup, blockmap) if p]:
    target = f"{remote_dir}/{os.path.basename(local)}"
    size = os.path.getsize(local)
    print(f"上传 {os.path.basename(local)} ({size/1048576:.1f} MB) …")
    sftp.put(local, target)
    print(f"  → {target}")
sftp.close()

# 校验清单可读**且大小与本地一致**——这一步不能省，而且必须比大小：
# 上一版只 head 了内容，于是「文件其实传到本机磁盘」也能通过校验（远端旧文件恰好存在时）。
# 少了它，MSYS 路径转换这类问题会一路溜到「客户端检查更新没反应」才暴露。
#
# 用 stat 而不是 ls -la：安装包文件名含空格（「和鸣 Setup d.15.1.4.0.exe」），
# 按空白切分会把名字拆碎，拿到的最后一列只是 `d.15.1.4.0.exe`，精确匹配永远失败。
#
# 分隔符用竖线不用 \t：`stat -c '%s\t%n'` 里的 \t 在 shell 单引号中是**字面量**，
# 输出的是反斜杠加 t，Python 按真正的制表符切会永远切不开。
_, out, _ = c.exec_command(
    f"cd {remote_dir} && ls -la && echo '--- 清单前 6 行 ---' && head -6 latest.yml "
    f"&& echo '--- 大小 ---' && stat -c '%s|%n' * 2>/dev/null",
    timeout=60,
)
raw = out.read().decode("utf-8", "replace")
print(raw)

target_name = os.path.basename(setup)
remote_size = None
in_sizes = False
for line in raw.splitlines():
    if line.startswith("--- 大小"):
        in_sizes = True
        continue
    if not in_sizes:
        continue
    if "|" not in line:
        continue
    size_text, name = line.split("|", 1)
    if name == target_name:
        try:
            remote_size = int(size_text)
        except ValueError:
            remote_size = None
        break

if remote_size is None:
    print(f"错误：远端目录里找不到 {target_name}——上传没有真正落到服务器。")
    print("      若本机 Git Bash 报路径被转换，检查 MSYS_NO_PATHCONV 是否生效。")
    sys.exit(1)

if remote_size != os.path.getsize(setup):
    print(f"错误：远端安装包大小 {remote_size} != 本地 {os.path.getsize(setup)}，上传不完整。")
    sys.exit(1)

print(f"校验通过：远端安装包 {remote_size} 字节，与本地一致")
c.close()
print("发布完成")
PYEOF