# 内层安装包的内嵌槽位

`scripts/build-setup.mjs --embed-inner` 会把 electron-builder 生成的
`和鸣 Setup <5 段版本>.exe` 复制成这个目录下的 `inner-setup.exe`，
并写进 `config/generated.json` 的 sha512；打包时由 extraResources 映射到
`resources/payload/inner-setup.exe`。

这个文件是给「在线版」占位的：目录必须存在，但默认不内嵌任何安装包
（在线版在运行时从更新服务器取 latest.yml 并下载）。`inner-setup.exe`
与 `config/generated.json` 都不入库，见 packages/setup/.gitignore。
