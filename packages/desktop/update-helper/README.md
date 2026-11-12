# 更新助手暂存目录

这个目录会被 electron-builder 原样复制到安装目录的 `resources/updater/`，
应用内更新时主进程从那里启动 `setup.exe`（自绘安装器）来接管更新。

`setup.exe` 由 `scripts/build-desktop.mjs` 在打包前从
`packages/setup/release/和鸣安装程序 *.exe` 里复制进来（取最新的一个）。
它是构建产物，不入库，所以这里只留 `.gitignore` 和这份说明。
