#!/usr/bin/env sh
# 启动工作流引擎（独立插件）。关闭终端或 Ctrl+C 即停止服务。
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 24 或更高版本：https://nodejs.org/"
  exit 1
fi
echo "正在启动工作流引擎（Ctrl+C 停止）..."
exec node dist/server/main.js
