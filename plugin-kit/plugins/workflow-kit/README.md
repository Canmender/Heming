# 工作流引擎（独立插件）

一个**独立运行**的本机节点式自动化服务：自带 Web 编辑器、执行引擎、29 个节点与 MCP 工具。
和鸣通过 `plugin/plugin.json` 把它声明成「本机 MCP 服务 + 技能 + 命令」来使用；
服务本身不依赖和鸣，也不读写和鸣的任何数据。

> **下载与安装（普通用户）**：<http://47.92.39.184/updates/plugins/heming.workflow-kit/index.html>
> 下载服务包 zip → 解压 → Windows 双击 `start.cmd`（或 `node dist/server/main.js`）→
> 在和鸣插件区导入页面上的 `plugin.json` → 接口区连接「工作流引擎」并授权工具。
> 服务包已包含构建产物，运行期零依赖，不需要 `pnpm install`。

> 定位：独立插件，**不参与和鸣主分支开发**。源码随和鸣 `plugin-kit/plugins/workflow-kit/` 统一存放，
> 但仍按独立服务构建与发布：不进入和鸣安装包，也不被和鸣运行时直接引用。
> 设计语义参考 n8n 的公开文档，**未使用其源代码**（n8n 为 Sustainable Use License 1.0，非 OSI 开源，禁止复制与商业分发）。

## 它是什么

```
浏览器 ──HTTP──┐
               ├──> 本机服务 127.0.0.1:8777 ──> 引擎（items 数据流 + 执行栈）
和鸣智能体 ─MCP─┘                                ├── 28 个节点（触发/流程/数据/HTTP/代码/LLM/…）
                                                 ├── 执行记录（本机 JSON）
                                                 ├── 调度器（定时触发，15s 轮询）
                                                 └── 凭据（AES-256-GCM 加密文件）
```

- **Web 编辑器**：`http://127.0.0.1:8777/`——画布搭流程、拖线、参数表单、逐节点执行数据；
- **AI 生成**：`POST /api/ai/workflow` / MCP `workflow_generate`，用自然语言生成工作流草稿（需本机配置模型连接；默认只生成不保存）；
- **Webhook 触发**：`webhookTrigger` 节点 + `POST /webhook/<路径>`（工作流需启用；路径不可猜，可选访问令牌）；
- **MCP 工具（26 个）**：`workflow_*` CRUD/校验/运行/执行记录，加上智能体自主设计闭环：`credential_list`（凭据发现，不含密钥）、`node_type_detail`（节点完整参数 schema）、`workflow_test`（pinData 试跑，不产生副作用）、`workflow_set_active`（等价发布/取消发布）、`mcp_list_tools`（发现外部 MCP 服务工具），以及 P1 的 `workflow_search`（搜索/标签）、`workflow_execution_detail`（逐节点数据，默认脱敏）、`workflow_versions`/`workflow_version_get`/`workflow_restore`（版本历史与回滚）、`workflow_sdk_reference`（规范参考）；
- **数据只在本机**：工作流、执行记录、凭据都在 `data/`；服务只监听回环地址，不开公网端口。

## 快速开始

需要 Node.js ≥ 24（运行期不需要安装任何第三方依赖）。

**用发布包（推荐给用户）**：从 [落地页](http://47.92.39.184/updates/plugins/heming.workflow-kit/index.html)
下载 `heming-workflow-kit-<版本>.zip`，解压后：

```bash
# Windows：双击 start.cmd
# macOS / Linux：
./start.sh
# 或者直接：
node dist/server/main.js
```

**从源码（开发者）**：

```bash
pnpm install
pnpm build
node dist/server/main.js
# 或： pnpm start
```

打开 <http://127.0.0.1:8777/>，选一个模板或新建空工作流，点「运行」。
服务启动日志会打印编辑器地址、MCP 地址与数据目录。

### 接入和鸣（可选）

1. 先启动上面的服务；
2. 和鸣 → 插件区 → 安装 → 选择本仓库的 `plugin/plugin.json`；
3. 接口区找到「工作流引擎」服务 → 连接（首次会列出工具，默认全部关闭）；
4. 按需打开 `workflow_*` / `node_types` 等工具（写类工具会走和鸣的人工确认）；
5. 和鸣的智能体就能通过技能「工作流设计 / 运行工作流 / 从 n8n 迁移工作流」来用它。

> 插件包只声明「服务地址 + 技能 + 命令」，不携带代码、密钥；服务由用户自己启动。

## 配置

环境变量（优先级最高）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `WF_PORT` | 服务端口 | `8777` |
| `WF_DATA_DIR` | 数据目录 | `<项目>/data` |
| `WF_LLM_BASE_URL` | OpenAI 兼容地址（不含 `/chat/completions`） | — |
| `WF_LLM_API_KEY` | 对应 Key | — |
| `WF_LLM_MODEL` | 模型名 | — |
| `WF_MAX_EXECUTION_MS` | 单次执行上限 | `600000` |

也可以写 `data/config.json`（首启自动创建目录）：

```json
{ "port": 8777, "llm": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-…", "model": "deepseek-chat" } }
```

Key 也可以只在启动环境变量里给，不落盘。

## 能力

- **执行引擎**：items 数据流、执行栈（非递归）、分支、多输入合并、回环（Loop 用法，500 次/10 分钟兜底）、
  节点级重试（2–5 次）、错误三态（停止 / 透传 / 错误输出口）、`executeOnce`、`pinData`、部分执行、
  子流程（深度 8）、错误工作流、进度事件、取消；
- **28 个节点**：手动/定时(Cron)/错误/子流程触发；If/Switch/Merge/分批循环/Wait/NoOp/StopAndError；
  Set/SplitOut/Filter/Sort/Limit/去重/汇总/列表；HTTP/代码沙箱/执行子流程/日期/加密/XML；
  大模型（OpenAI 兼容）/MCP 工具调用/通知；
- **表达式**：`{{ }}` + `$json/$items/$node/$now/$today/$vars/$parameter` 与常用 helper；
- **代码节点**：`node:vm` 隔离（无 require/process/fetch/fs，10 秒超时；只支持同步代码）；
- **调度**：定时触发 15 秒轮询、串行、启动错过不补跑；
- **执行记录**：逐节点输入/输出/耗时/错误，60 条 / 1MB 双淘汰；
- **凭据**：四种 HTTP 鉴权，值用 AES-256-GCM 加密落盘（密钥 `data/secret.key`，0600）；
- **导入导出**：导出为类 n8n 形状；导入支持 n8n 导出文件（前缀剥离、别名映射、未知节点 warning）。

## 项目结构

```
src/
  types.ts model.ts registry.ts     领域模型与节点注册表
  engine/                           执行引擎（执行栈/重试/错误分流/子流程/调度计算）
  expressions/                      表达式求值与代码沙箱（node:vm）
  nodes/core/                       核心节点（触发/数据/流程/HTTP/代码）
  nodes/integrations/               集成节点（日期/加密/XML/LLM/MCP 工具/通知）
  nodes/templates.ts                起手模板
  server/                           本机服务（配置/存储/运行时/调度/HTTP/MCP/凭据）
public/                             原生 JS Web 编辑器（无构建）
plugin/plugin.json                  和鸣插件包（声明 MCP 服务 + 技能 + 命令）
scripts/                            发布脚本（build-release / publish-cloud / smoke）
start.cmd / start.sh                发布包的一键启动脚本
docs/                               CONTRACT（团队契约）/ DESIGN（设计）
```

## 数据与安全边界

- 只监听 `127.0.0.1`，无鉴权（本机回环即边界）；不要把端口转发到公网；
- **CORS 来源白名单**：只接受和鸣客户端（`app://heming`）、本机 `localhost`/`127.0.0.1` 页面与无 Origin 的
  命令行/MCP 调用；其它网页来源一律 403——防止你浏览的任意网站读写本机工作流；
  （因此**云端网页版和鸣**不能驱动本机插件，桌面端可用；这是有意的安全边界）
- **执行数据有上限**：单条 item 的 json 超过 64KB 会截断为「标记 + 预览」，单条执行记录超过 1MB 会
  从最早节点开始丢数据、并标记 `dataTruncated`（状态/耗时/错误仍保留）；
- 工作流、执行记录、凭据、通知都只在本机 `data/` 下；不联网上报；
- 出网只发生在：HTTP 节点、LLM 节点、`mcpTool` 节点（用户自己配的地址）；
- 代码节点跑在 `node:vm` 沙箱里，没有网络/文件/进程入口；
- 凭据加密密钥与数据在同一目录：能读整个 `data/` 的人仍可解密，文档如实说明。

## 发布到云端

云端分发走和鸣现有的静态更新源（`/opt/heming/updates/`，nginx 直接可访问），不新增服务：

```bash
node scripts/build-release.mjs     # 打 release/：服务 zip、plugin.json、落地页、latest.json、SHA256SUMS
node scripts/publish-cloud.mjs     # SFTP 上传 + 本地/远端/公网 sha256 三重校验
```

- 静态资源：`/opt/heming/updates/plugins/heming.workflow-kit/`（落地页 + 下载 + 校验文件）；
- 插件目录：同时按 `/opt/heming/plugins/heming.workflow-kit/<版本>/plugin.json` 布局预上传，
  等服务器版本带「云端插件目录」接口（`GET /api/plugins`）后，和鸣「插件区 → 在线目录」会自动列出；
- 凭据：优先 `HEMING_SSH_PWD`，否则读本机 `D:/Heming/.superpowers/deploy-*.py`（不落盘、不打印）。

## 测试

```bash
pnpm typecheck            # 全项目 tsc
pnpm test                 # vitest：引擎/表达式/节点/服务端/调度/UI
node scripts/smoke.mjs    # 起真实服务跑 REST + MCP 端到端（14 项）
node scripts/audit-probe.mjs  # 网络边界自检：CORS/穿越/体积上限/沙箱/并发/新工具（29 项）
```

## 许可与来源

本仓库代码为独立实现。设计语义参考 n8n 官方文档（执行模型、items 数据流、错误处理、表达式等），
**未复制其源码、未引入其 npm 包**；原因见 [docs/DESIGN.md](docs/DESIGN.md) 的「来源与许可」一节。
