# 真实插件源码（plugin-kit/plugins）

这里放**要发布/安装的真实插件**；[`../examples/`](../examples/README.md) 只是教学示例，
[`../templates/`](../templates/) 是脚手架。

| 目录 | 插件 id | 形态 | 说明 | 构建 / 测试 |
|---|---|---|---|---|
| [`infohub-collector/`](infohub-collector/) | `heming.infohub-collector` | v5 声明式 | 本机 InfoHub 采集桥（技能 + MCP + 命令 + 工具束） | `node scripts/plugin-lint.mjs plugin-kit/plugins/infohub-collector/plugin.json` |
| [`pet-widget/`](pet-widget/) | `heming.pet` | v4 bundle（仅首方） | 桌宠界面插件；pnpm workspace 包 | `pnpm --filter @heming/pet-widget build` / `test`；发布前签名后 `run pack` |
| [`workflow-kit/`](workflow-kit/) | `heming.workflow-kit` | v5 声明式 + 独立服务 | 节点式工作流引擎；清单在 `plugin/plugin.json` | `cd plugin-kit/plugins/workflow-kit && pnpm install && pnpm build && pnpm test` |

## 约定

- **目录名 = 插件 id 最后一段**（`workflow-kit` 保留其独立项目的 `plugin/` 布局，清单不在目录根）。
- 新增插件用 `pnpm plugin:new <id>`，默认生成到本目录；生成后立刻 lint。
- 声明式插件现行 `schemaVersion: 5`（旧 v3 包按 [COOKBOOK §7](../COOKBOOK.md) 升级）；界面插件仍是 v4 bundle，只对首方开放。
- 想让插件在左侧导航多一个入口：加 `contributions.page`（声明式写 `blocks`；仅首方 bundle 写 `entry`），见 [COOKBOOK §4](../COOKBOOK.md)。
- 发布：`node scripts/publish-plugin.mjs <包目录或 plugin.json> --dest <插件目录>`。
  工作流引擎是独立服务，使用它自己的 `scripts/build-release.mjs` 出包、`scripts/publish-cloud.mjs` 上传。
- 这些包**不随和鸣安装包分发**（`packages/desktop/packaging.plugins.test.js` 守着这条边界）。
