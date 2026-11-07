# 安装器品牌化（d.75.2.39.0）

日期：2026-11-07
范围：`packages/desktop/build/`、`packages/desktop/package.json`（仅 `build.win.icon` 与 `build.nsis.*`）

## 1. 为什么做

r63 安装包仍是 electron-builder 默认外观：无欢迎页、NSIS 自带 metro 侧栏图、exe 用 Electron 默认图标。
安装是用户第一次看到产品，默认外观与产品气质（墨黑单色、中文、本机优先）不匹配。

## 2. 素材

全部由 `scripts/make-installer-assets.py` 生成（Pillow；4× 超采样后缩小）：

| 文件 | 尺寸/格式 | 内容 |
| --- | --- | --- |
| `icon.ico` | 16–256 多尺寸 RGBA | 墨黑圆角方块 + 白「和」 |
| `installerSidebar.bmp` | 164×314 / 24bpp | 墨黑底，白「和鸣」+ HEMING，底部「本机 AI 工作站 / 数据留在设备上」 |
| `uninstallerSidebar.bmp` | 164×314 / 24bpp | 同上，底部换「卸载后，你的本机数据与设置仍会保留」 |
| `installerHeader.bmp` | 150×57 / 24bpp | 白底，右上黑「和鸣 / HEMING」 |

配色只用 `#17181a` / 白 / `#9a9b9f` / `#3a3b40`，与产品单色语言一致；没有渐变与高光。

## 3. 配置

`packages/desktop/package.json`：

```jsonc
"win": { "icon": "icon.ico" },
"nsis": {
  "include": "installer.nsh",
  "installerIcon": "icon.ico",
  "uninstallerIcon": "icon.ico",
  "installerHeader": "installerHeader.bmp",
  "installerSidebar": "installerSidebar.bmp",
  "uninstallerSidebar": "uninstallerSidebar.bmp"
}
```

路径相对 `buildResources`（`packages/desktop/build`）解析。

## 4. 文案与页面

`build/installer.nsh` 在 electron-builder 模板公共头部展开，因此 `MUI_*` 定义先于
`MUI_PAGE_WELCOME` / `MUI_PAGE_FINISH` 生效：

- 新增欢迎页（assisted 安装器默认没有）：标题「安装 和鸣」，正文说明本机优先与卸载保留数据；
- 目录页顶部说明「数据与设置始终保存在本机」；
- 完成页「安装完成 / 运行 和鸣」；
- 卸载欢迎页「卸载 和鸣 / 卸载只会移除程序，本机数据与设置会保留」。

安装行为不变：`oneClick:false`、`allowToChangeInstallationDirectory:true`、中文语言 2052。

## 5. 验证与已知

- r64 真机启动安装器截图确认：欢迎页侧栏、页头、图标、完成页文案与新图标；
- 未做：自定义 NSIS 页面配色/字体（MUI 用系统控件，深色主题不可控）、安装器高 DPI 逐档截图、
  签名（无证书，仍是「未知发布者」提示）。

## 6. 打包修正（d.75.2.40.0）

- `build-desktop.mjs` 打包前强制重建 `packages/desktop/web-dist`：r64 曾因直接跑它而把上一版 UI 打进新版本号；
- `build.win.executableName = "Heming"`：避免 electron-builder 用包名 `@heming/desktop` 兜底，
  把安装目录变成 `@hemingdesktop`；显示名仍是「和鸣」。

## 7. 已知环境坑：不要把应用装进开发工作区

在 `D:\Heming`（低完整性级别目录）安装后，双击 exe 秒退且无日志；同样文件复制到普通目录可正常启动。
诊断路径：比较安装目录 ACL（`icacls` 显示 `Mandatory Label\Low Mandatory Level`）→ 复制到普通目录可运行。
结论：安装位置必须在普通用户目录（默认 `%LOCALAPPDATA%\Programs\...`），不要装进开发目录。

