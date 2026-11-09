# 许可与来源

本仓库（工作流引擎独立插件）的代码为独立实现，版权归本仓库作者所有。

## 与 n8n 的关系

- 设计语义参考了 n8n 项目的**公开文档**（执行模型、items 数据流、错误处理、表达式等）；
- **未使用 n8n 的源代码**，**未引入其 npm 包**（`n8n-workflow` / `n8n-core` / `n8n-nodes-base` 等）；
- n8n 自 2022-03-17 起采用 Sustainable Use License 1.0（fair-code，非 OSI 开源许可），
  不允许复制其代码或把其代码打包进商业发行物；本实现不包含其代码，因此不受该许可约束。
- 参考版本与页面清单见 `docs/DESIGN.md` §2。

## 第三方组件

运行期不依赖任何第三方 npm 包（只用 Node.js 内置模块与全局 `fetch`/`crypto`）；
开发期依赖 `typescript`、`vitest`、`@types/node`、`jsdom`，各自遵循其原始许可。
