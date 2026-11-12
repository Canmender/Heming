# 真实插件源码（plugin-kit/plugins）

这里放**要发布/安装的真实插件**（含 d.138 起由内置模块改写成的两个沙箱 bundle 插件）；
[`../examples/`](../examples/README.md) 只是教学示例，
[`../templates/`](../templates/) 是脚手架。

| 目录 | 插件 id | 形态 | 说明 | 构建 / 测试 |
|---|---|---|---|---|
| [`automations/`](automations/) | `heming.automations` | 沙箱 bundle 插件（页面 + 后台页） | 自动化：自动化页面 + 后台循环 + 首页卡 | 无构建（原生 HTML/JS）；发布用 `node scripts/publish-plugin.mjs` |
| [`infohub/`](infohub/) | `heming.infohub` | 沙箱 bundle 插件（页面 + 命令） | 信息中枢：检索 / 会话 / 日程页面 + 命令 + 首页卡 | 无构建（原生 HTML/JS）；发布用 `node scripts/publish-plugin.mjs` |
| [`infohub-collector/`](infohub-collector/) | `heming.infohub-collector` | v5 声明式 | 本机 InfoHub 采集桥（技能 + MCP + 命令 + 工具束） | `node scripts/plugin-lint.mjs plugin-kit/plugins/infohub-collector/plugin.json` |
| [`pet-widget/`](pet-widget/) | `heming.pet` | v4 bundle（仅首方） | 桌宠界面插件；pnpm workspace 包 | `pnpm --filter @heming/pet-widget build` / `test`；发布前签名后 `run pack` |
| [`workflow-kit/`](workflow-kit/) | `heming.workflow-kit` | v5 声明式 + 独立服务 | 节点式工作流引擎；清单在 `plugin/plugin.json` | `cd plugin-kit/plugins/workflow-kit && pnpm install && pnpm build && pnpm test` |

聊天记录浏览已并入「信息中枢」插件页面，不再作为独立插件发布。

上表前两行（d.138 起）不再有单独的模块链路：`plugin.json` 用 `distribution: "bundle"`，页面与后台页是包内
原生 HTML（`widget://` 沙箱加载），发布同样走 `scripts/publish-plugin.mjs` → 仓库根 `plugins-catalog/` →
云端 `/opt/heming/plugins`。modules 体系（`module.json` / `module.tgz` / `module-catalog/` / `/api/modules`）
已整体下线，见 `docs/PLUGINS.md` §12。

## 约定

- **目录名 = 插件 id 最后一段**（`workflow-kit` 保留其独立项目的 `plugin/` 布局，清单不在目录根）。
- 新增插件用 `pnpm plugin:new <id>`，默认生成到本目录；生成后立刻 lint。
- 声明式插件现行 `schemaVersion: 5`（旧 v3 包按 [COOKBOOK §7](../COOKBOOK.md) 升级）；界面插件仍是 v4 bundle，只对首方开放。
- 想让插件在左侧导航多一个入口：加 `contributions.page`（声明式写 `blocks`；仅首方 bundle 写 `entry`），见 [COOKBOOK §4](../COOKBOOK.md)。
- 发布：源码 → 本地暂存 → 云端，只有一条链路（d.137）：`node scripts/publish-plugin.mjs <包目录或 plugin.json>`
  写到**仓库根 `plugins-catalog/`**（唯一暂存目录，`plugin-kit/` 下不再保留 `plugins-catalog`），再把这个目录
  同步到云端 `/opt/heming/plugins`（即 `HEMING_PLUGIN_DIR`）。详见 `docs/PLUGINS.md` §9。
  工作流引擎是独立服务，使用它自己的 `scripts/build-release.mjs` 出包、`scripts/publish-cloud.mjs` 上传（唯一例外）。
- 这些包**不随和鸣安装包分发**（`packages/desktop/packaging.plugins.test.js` 守着这条边界）。
