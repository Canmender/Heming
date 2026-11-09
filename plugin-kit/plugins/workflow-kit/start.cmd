@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 24 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动工作流引擎（关闭此窗口即停止服务）...
node dist\server\main.js
echo.
echo 服务已退出。
pause
