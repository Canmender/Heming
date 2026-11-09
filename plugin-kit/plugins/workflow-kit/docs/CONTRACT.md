# 独立插件「工作流引擎」· 团队契约

> 本文件是这一轮所有实现者的唯一约定。动手前读完；与本文冲突的直觉以本文为准。
> 契约变更只能由 Lead 改，实现者不要自行扩。

## 0. 身份与边界（重要）

- 我们是**独立插件作者**：不参与和鸣主分支开发，不改和鸣仓库任何文件，不把任何东西合进 main 或装进本机和鸣。
- 只在这个独立项目里工作：**`D:\n8n-workflow-plugin`**（独立 git 仓库，无远端）。
- 产出形态：一个可独立运行的本机服务（工作流引擎 + Web 编辑器 + MCP 工具）＋ 一个**声明式插件包** `plugin/plugin.json`（供将来从和鸣插件区安装，声明本机 MCP 服务、技能、命令）。本机不安装、不启动给和鸣用。
- 许可：n8n 采用 Sustainable Use License 1.0（非开源，禁止复制代码/打包分发）。因此这里**只按公开语义重写**，不复制 n8n 源码、不引入其依赖；声明见 `docs/DESIGN.md`。

## 1. 环境

| 项 | 值 |
|---|---|
| 项目目录 | `D:\n8n-workflow-plugin` |
| 运行时 | Node >= 24，无运行期第三方依赖（只用 node: 内置模块与全局 fetch/crypto） |
| 开发依赖 | typescript / vitest / @types/node（已安装） |
| 构建 | `pnpm build` → `dist/`（tsc，NodeNext ESM） |
| 测试 | `pnpm test`（vitest） |
| 启动 | `pnpm build && node dist/server/main.js`（默认 127.0.0.1:8777） |

已从旧分支拷贝进 `src/` 并可用的核心：`types.ts` / `model.ts` / `registry.ts` / `engine/**` / `expressions/**` / `nodes/**`（约 4000 行 + 28 个测试文件）。这些是**运行在浏览器/宿主里的实现**，现在要改造成 Node 独立服务；不能直接改回宿主依赖。

**禁止**：`git` 提交（Lead 统一提交）、改 `package.json` 依赖、改 `tsconfig.json`、碰和鸣仓库 `D:\Heming`。

## 2. 目录与归属

```
D:\n8n-workflow-plugin\
  src/
    types.ts / model.ts / registry.ts     Lead（已冻结）
    engine/**                             wf-engine
    expressions/**                        wf-expr
    nodes/core/**  nodes/index.ts         wf-nodes-core
    nodes/integrations/** nodes/templates.ts  wf-nodes-app
    server/config.ts storage.ts runtime.ts main.ts scheduler.ts   Lead
    server/http.ts mcp.ts credentials.ts  wf-desktop
  public/                                 index.html style.css canvas.js app.js（无构建，原生 JS）
    canvas.js canvas.css                  wf-canvas
    app.js index.html style.css           wf-shell
  plugin/plugin.json                      Lead
  docs/DESIGN.md README.md                Lead
  src/**/*.test.ts                       各文件作者
```

只改自己名下文件；需要别人配合发消息给 lead。**不要**改 `src/types.ts`、`src/model.ts`、`src/registry.ts`。

## 3. 已冻结的核心契约（已拷贝，语义与旧分支一致）

- `types.ts`：`Item`、`Workflow`、`WorkflowNode`、`NodeTypeDescription`、`NodeExecutionContext`、`INodeType`、`WorkflowExecution`、`WORKFLOW_LIMITS`、`NodeHelpers`（`httpRequest`/`sleep`/`runUserCode?`/`executeSubWorkflow?`）等。
- `model.ts`：create/normalize/validate/连接/克隆/`outputCountOf` 等（纯函数）。
- `registry.ts`：`registerNodeType` / `getNodeType` / `listNodeTypes` / `clearNodeRegistry`。
- 引擎：`executeWorkflow(ExecuteOptions): Promise<WorkflowExecution>`（永不 throw）、`nextScheduleRun(workflow, from)`、`EngineEvent`、`EngineDeps`。
- 表达式：`hasExpression/evaluateExpression/resolveValue/resolveParameters/buildExpressionContext`，以及 wf-expr 提供的 `runUserCode(options): Promise<unknown>`（`UserCodeRunner` 形状）。

## 4. 服务端契约（Lead 已实现 config/storage/runtime/main，wf-desktop 做 http/mcp/credentials）

### 4.1 配置 `src/server/config.ts`
```ts
interface WorkflowConfig {
  host: "127.0.0.1"; port: number;        // 默认 8777
  dataDir: string;                          // 默认 <项目>/data
  llm?: { baseUrl: string; apiKey: string; model: string };  // OpenAI 兼容
  maxExecutionMs: number;
}
loadConfig(env = process.env): WorkflowConfig   // data/config.json 覆盖 env（简单 merge）
```
env：`WF_PORT` / `WF_DATA_DIR` / `WF_LLM_BASE_URL` / `WF_LLM_API_KEY` / `WF_LLM_MODEL`。

### 4.2 存储 `src/server/storage.ts`（Lead 实现，接口稳定）
```ts
interface Store {
  listWorkflows(): Workflow[];
  getWorkflow(id: string): Workflow | undefined;
  createWorkflow(input?: { name?: string; from?: Workflow }): Workflow;
  saveWorkflow(wf: Workflow): Workflow;            // 归一 + 上限 + versionId/updatedAt，写盘
  removeWorkflow(id: string): boolean;             // 级联删执行记录
  setActive(id: string, active: boolean): Workflow | null;
  markRun(id: string, at: number): void;           // 只写 lastRunAt
  listExecutions(filter?: { workflowId?: string; limit?: number }): WorkflowExecution[];
  getExecution(id: string): WorkflowExecution | undefined;
  saveExecution(exec: WorkflowExecution): void;    // 60 条 / 1MB 双淘汰，最新在前
  removeExecution(id: string): boolean;
  clearExecutions(workflowId?: string): number;
  listCredentials(): CredentialMeta[];
  saveCredential(input: CredentialInput): CredentialMeta;
  removeCredential(id: string): boolean;
  getCredentialData(type: string, id: string): Promise<Record<string, unknown> | null>;
  getSettings(): Settings; saveSettings(patch: SettingsPatch): Settings;
  getStaticData(workflowId: string, nodeId?: string): Record<string, unknown>;
  saveStaticData(workflowId: string, nodeId: string | null, data: Record<string, unknown>): void;
  addNotification(n: { title: string; body?: string; workflowId?: string }): void;
  listNotifications(limit?: number): Array<{ id: string; title: string; body: string; at: number; workflowId?: string }>;
}
```
数据文件全在 `data/`：`workflows.json` / `executions.json` / `credentials.json` / `settings.json` / `static.json` / `notifications.jsonl`。原子写（tmp+rename）。坏条目逐条丢弃。凭据值由 `credentials.ts` 的 vault 加密后存。

### 4.3 运行时 `src/server/runtime.ts`（Lead 实现）
```ts
interface Runtime {
  runWorkflow(workflow: Workflow, opts?: { mode?: ExecutionMode; startNodeId?: string; destinationNodeId?: string; inputData?: Item[]; onEvent?: (e: EngineEvent) => void; abortSignal?: AbortSignal }): Promise<WorkflowExecution>;
  isRunning(workflowId: string): boolean;
  stop(): boolean;                       // 取消当前执行
}
createRuntime(store: Store, config: WorkflowConfig): Runtime
```
内部构造 `EngineDeps`：`httpRequest`（全局 fetch）、`runUserCode`（expressions 的 Node 沙箱）、`getCredential`（store）、`executeSubWorkflow`（递归、深度 8、mode 透传、父 signal）、`staticData`（store）、`now`。

### 4.4 调度 `src/server/scheduler.ts`（Lead 实现）
15s 轮询、串行、只跑 active 且含 scheduleTrigger 的工作流、启动错过不补跑（把到点的 lastRunAt 推到 now）、失败写通知。导出 `createScheduler(store, runtime, { onExecution })`。

### 4.5 HTTP `src/server/http.ts`（wf-desktop）
`createHttpServer({ store, runtime, scheduler, config }): http.Server`；绑定 127.0.0.1；**所有响应带 CORS**（`Access-Control-Allow-Origin: *`、methods、headers 含 `mcp-session-id`、`content-type`），OPTIONS 直接 204。JSON body 上限 5MB。错误统一 `{ok:false,error}` + 4xx/5xx。

REST（`/api`）：
| 方法路径 | 入参 | 出参 |
|---|---|---|
| GET `/api/health` | — | `{ok,version,uptimeMs,scheduler:{running:boolean}}` |
| GET `/api/node-types` | — | `NodeTypeDescription[]` |
| GET `/api/templates` | — | `[{id,name,description}]` |
| GET `/api/workflows` | — | 摘要数组 `{id,name,active,nodeCount,triggerCount,updatedAt,lastRunAt?,lastStatus?}` |
| POST `/api/workflows` | `{name?,fromTemplateId?,json?}` | `Workflow` |
| GET `/api/workflows/:id` | — | `Workflow` |
| PUT `/api/workflows/:id` | `Workflow` | `{ok,workflow,issues}` |
| DELETE `/api/workflows/:id` | — | `{ok}` |
| POST `/api/workflows/:id/active` | `{active}` | `{ok,workflow}` |
| POST `/api/workflows/:id/duplicate` | — | `Workflow` |
| GET `/api/workflows/:id/export` | — | 类 n8n JSON |
| POST `/api/workflows/import` | `{json}` | `{ok,workflow,warnings[]}` |
| POST `/api/workflows/:id/run` | `{startNodeId?,inputData?}` | `{ok,executionId}`（异步启动，立即返回） |
| POST `/api/workflows/:id/stop` | — | `{ok,stopped}` |
| GET `/api/executions` | `?workflowId=&limit=` | `WorkflowExecution[]`（不含 runData，`data:undefined`） |
| GET `/api/executions/:id` | — | `WorkflowExecution`（含 runData） |
| DELETE `/api/executions/:id` | — | `{ok}` |
| POST `/api/executions/:id/retry` | — | `{ok,executionId}` |
| GET `/api/credentials` | — | `[{id,name,type,updatedAt}]` |
| POST `/api/credentials` | `{name,type,data}` | meta |
| PUT `/api/credentials/:id` | `{name?,data?}` | meta |
| DELETE `/api/credentials/:id` | — | `{ok}` |
| GET `/api/settings` | — | `{vars,llm:{configured,baseUrl?,model?}}`（不回 Key） |
| PUT `/api/settings` | `{vars?,llm?{baseUrl,apiKey?,model?}}` | 同上 |
| GET `/api/notifications` | — | 最近 50 条 |
| POST `/mcp` | JSON-RPC（见 §5） | JSON-RPC |
| GET `/` + `/static/*` | — | `public/` 静态文件（index.html 回落，防路径穿越） |

### 4.6 凭据 `src/server/credentials.ts`（wf-desktop）
- 四种类型：`httpBasic`（username/password）、`httpHeader`（name/value）、`httpQueryAuth`（name/value）、`bearerToken`（token）。
- 值加密：`data/secret.key`（32 字节随机，0600）→ AES-256-GCM；存储 `{iv,tag,data}` base64。
- `createVault(keyPath): { encrypt(plain:string): string; decrypt(payload:string): string }`
- 校验：字段白名单、长度上限、未知类型拒绝；错误中文。

## 5. MCP 契约（wf-desktop 实现 `src/server/mcp.ts`）

和鸣的 MCP HTTP 客户端行为（必须匹配）：
- 每个请求 `POST /mcp`，`content-type: application/json`，`accept: application/json, text/event-stream`；
- 首次 `initialize` 响应头带 `Mcp-Session-Id`（后续请求带 `mcp-session-id` 头，服务端可校验也可放行）；
- 之后发无 id 的 `notifications/initialized`；
- 支持方法：`initialize`、`ping`、`tools/list`、`tools/call`；`tools/list` 返回 `{tools:[{name,description,inputSchema}]}`；`tools/call` 返回 `{content:[{type:"text",text}], isError?}`（JSON 结果序列化进 text）。
- **单次调用 20 秒超时**（和鸣客户端硬限制）：所以 `workflow_run` 必须**异步启动并立即返回 executionId**，由智能体轮询 `workflow_run_status`。

MCP 工具（名称/入参/行为）：
| 工具 | 入参 | 说明 |
|---|---|---|
| `workflow_list` | — | 工作流列表摘要 |
| `workflow_get` | `{id}` | 完整工作流 JSON |
| `workflow_create` | `{name?, json?}` | 新建（可带完整工作流 JSON） |
| `workflow_update` | `{id, json}` | 覆盖保存并返回校验问题 |
| `workflow_delete` | `{id}` | 删除 |
| `workflow_validate` | `{json}` | 只校验，不入库 |
| `workflow_templates` | — | 模板列表（id/name/description/workflow） |
| `workflow_run` | `{id, startNodeId?, input?}` | 异步启动，返回 `{executionId}` |
| `workflow_run_status` | `{executionId}` | 状态 + 每节点状态/条数/错误（不含大数据） |
| `workflow_runs` | `{workflowId?, limit?}` | 最近执行摘要 |
| `node_types` | — | 节点类型清单（type/显示名/分组/参数 schema 摘要） |
| `credential_types` | — | 凭据类型与字段 |
| `workflow_import` | `{json}` | 从 n8n/本仓 JSON 导入 |
| `workflow_export` | `{id}` | 导出类 n8n JSON |

## 6. Node 适配要点（各模块作者必读）

1. **表达式/代码沙箱**：原来跑在浏览器 Blob Worker，现在改 `node:vm`：`vm.runInNewContext(code, sandbox, { timeout: ms })`；沙箱里只给 `items/$input/$json/$item/$itemIndex/$runIndex/console`，不给 `require/process/fetch/fs`；同步超时用 vm 的 timeout（打不断 Promise，代码节点按「同步代码」定位，文档写明）。
2. **HTTP**：节点一律走 `context.helpers.httpRequest`（runtime 用全局 fetch 实现），不要在节点里直接 fetch。
3. **大模型节点**：改成 OpenAI 兼容 `POST {baseUrl}/chat/completions`（非流式），连接配置来自 `config.llm`（`src/server/config.ts`），节点参数仍允许覆盖 system/user/maxTokens/JSON 输出；未配置时给中文可读错误。
4. **XML 节点**：Node 没有 DOMParser → 在 `xml.ts` 内实现一个够用的 XML→JSON 解析器（元素/属性/文本/自闭合/注释/CDATA/实体），JSON→XML 沿用字符串生成；不要引依赖。
5. **通知节点**：写本机通知日志（`store.addNotification`）并可原样透传数据；不再依赖宿主通知中心。
6. **InfoHub 三节点**：v1 用**通用「MCP 工具调用」节点**替代（`mcpTool`：url + tool + arguments，走 HTTP JSON-RPC 的 tools/call，20s 超时）；在 README 说明这是对宿主专属能力的替代。原 `infohubSearch/infohubAgenda/infohubSync` 删除或改名 `mcpTool`。
7. **模板**：4 个模板保留，节点 type 不许出现宿主专属节点；`llm` 模板参数保持通用。
8. **测试**：`vitest`（项目已装）。核心测试大多能直接跑；`fakeContext.ts` 保留（测试专用）。凡引用宿主路径（`../../../llmClient.js` 等）的文件在改造后必须 typecheck 通过、测试通过。

## 7. Web 编辑器契约（public/，原生 JS，无构建）

- `index.html` 以经典 `<script>` 依次加载 `canvas.js`、`app.js`，样式在 `style.css`/`canvas.css`。
- **Canvas 全局 API（wf-canvas 提供）**：
```js
window.WFCanvas = {
  mount(container, callbacks) // 返回实例
};
// callbacks: { onSelect(ids), onMoveNodes(moves), onConnect(conn), onRequestDelete(ids),
//              onOpenNode(id), onRequestAddNode(position) }
// 实例: { setWorkflow(workflow), setSelected(ids), setRunState(map), setReadOnly(bool), fit(), zoomBy(factor), getViewport() }
```
- Canvas 自己不拉数据、不存数据；移动/连线/删除只回调（app.js 改草稿）。
- `app.js`（wf-shell）负责：顶部 Tab（工作流/执行记录/凭据/设置）、列表、编辑器（工具栏 保存/运行/停止/导入/导出/模板/启停/撤销重做）、右侧节点面板（参数表单按 `NodeTypeDescription` 渲染、displayOptions、表达式提示、输入输出 JSON 预览、执行此节点）、执行记录列表/详情、凭据 CRUD、设置（变量/模型连接）。数据全部走 §4.5 REST；运行后按 700ms 轮询 `/api/executions/:id` 刷新节点状态与数据。
- 语言：中文；无 emoji；键盘可达（Esc 关面板、Ctrl/Cmd+S 保存、Ctrl/Cmd+Enter 运行）；空态给下一步。
- 视觉：简洁、层级清楚（字体 13–14px、卡片圆角 10px、边框 #e5e5e0、主色 #1a1a1a），不要求复刻和鸣。

## 8. 交付与验收

- 每块：`pnpm typecheck` 自己文件无错；`pnpm test` 自己目录全绿。
- 完成：`team_task_update` 标记 complete + `send_message` 给 lead 汇报（文件、测试数、遗留）。
- Lead 负责：插件包 `plugin/plugin.json`、`docs/DESIGN.md`、`README.md`、集成、全量门禁、git 提交。
