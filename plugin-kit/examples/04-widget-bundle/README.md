# 示例 04 · 界面插件最小闭环（v4 bundle，仅首方）

**教会你**：一个能跑起来的界面插件长什么样；`window.__heming_widget` 的最小用法；打包与签名顺序。

> ⚠ 第三方**不能**发布界面插件（装插件 = 在本机运行代码，只对首方签名开放）。
> 第三方请用声明式包（技能 / MCP / 命令 / 工具束）；确有可执行界面需求时另立沙箱规格。

```bash
node scripts/plugin-lint.mjs plugin-kit/examples/04-widget-bundle
```

本示例是**打包前**状态：没有 `packageSha256`、没有签名，所以 lint 显示「安装口径，打包前模式」。

## 结构

```
04-widget-bundle/
├── plugin.json          # v4 + distribution: "bundle"
└── files/               # 包根只能有 plugin.json + files/**（pack 会拒其它根文件）
    ├── index.html       # entry
    └── app.js           # 外置脚本（CSP script-src 只放 'self'）
```

## 发布顺序（实测口径）

```bash
# 1) 打包前校验（允许缺 packageSha256）
node scripts/plugin-lint.mjs plugin-kit/examples/04-widget-bundle

# 2) 签名：会把 packageSha256 写入清单（覆盖 files/** 代码字节）
node scripts/sign-plugin.mjs sign <包根>/plugin.json <私钥> --id heming --write

# 3) 打包：确定性 tgz，并按安装口径回读（readPackage ✓ 才算可发布）
node scripts/pack-plugin.mjs <包根>

# 4) 发版前确认公钥不是 dev
node scripts/check-release-keys.mjs
```

## API 用法（本示例覆盖）

| 方法 | 用途 |
|---|---|
| `info()` | `{ pluginId, pluginName, appVersion, theme }` |
| `settings()` / `setSetting()` | 偏好（主进程持有；只认清单声明的字段） |
| `dataGet()` / `dataSet()` | 插件业务数据（JSON、≤1MB、卸载即删、按插件隔离） |
| `onSettings()` / `onLifecycle()` | 设置变化 / 生命周期事件（需 `permissions.events` 含 `lifecycle`） |
| `log()` | 写宿主日志（不要打印密钥） |

完整 27 个方法与边界见 [STANDARD.md §6](../STANDARD.md) 与 `packages/shared/src/plugin/widget.ts`。

## 不要做

- 不要用 localStorage（独立 origin 下不可靠）。
- 不要自己算拖拽坐标（只发 `dragStart/Move/End` 信号，位移由主进程算）。
- 不要把密钥写进 `data/` 或 settings 默认值。
- 不要嵌外部页面（CSP `frame-src 'none'`）。
