# 工作流引擎（独立插件）· 设计

- 版本：1.0.0（独立项目；不随和鸣版本号走）
- 形态：独立本机服务（Node ≥ 24）＋ 原生 JS Web 编辑器 ＋ 声明式插件包（`plugin/plugin.json`）
- 定位：**独立插件作者身份**。不参与和鸣主分支开发，不合并、不装入本机软件；和鸣只通过插件声明接入本机 MCP 服务。

---

## 1. 背景与目标

用户在「和鸣」里想要 n8n 那样的节点式自动化。和鸣的第三方插件只能声明能力（技能 / 远程 MCP / 命令），
**不执行随包代码**；因此把工作流能力做成一个**独立本机服务**：

1. 服务自带执行引擎、Web 编辑器与 MCP 接口，脱离和鸣也能用；
2. 和鸣侧只安装一个声明式插件包，通过 MCP 工具让智能体创建/运行/查看工作流；
3. 数据（工作流、执行记录、凭据）只在本机，服务只监听回环地址。

### 目标（v1）

- items 数据流 + 执行栈引擎：分支、多输入合并、回环、重试、错误三态、executeOnce、pinData、部分执行、
  子流程、错误工作流、取消、上限兜底；
- 29 个节点（触发 / 数据 / 流程 / HTTP / 代码 / 日期 / 加密 / XML / LLM / MCP 工具 / 通知）；webhookTrigger 由服务端 /webhook/<路径> 路由触发；
- 表达式 `{{ }}`（`$json/$items/$node/$now/$today/$vars/$parameter` + helper）；
- 代码节点 Node 沙箱；
- 本机 Web 编辑器（原生 JS，无构建）：画布、参数表单、执行记录、凭据、导入导出、模板；
- HTTP REST + MCP（供和鸣智能体调用）；
- 本机 JSON 存储与 AES-256-GCM 凭据加密；
- 定时触发（15s 轮询、串行、不补跑）。

### 非目标（v1 明确不做）

- Webhook 触发器 / 响应节点（需要常驻端口与鉴权设计，单独立轮）；
- 跨重启的持久化等待 / 断点续跑；
- 多用户、权限、团队共享；
- n8n 的 400+ 第三方集成与凭据类型（用 HTTP / MCP 工具代替）；
- AI Agent 多轮自主编排（只有单次补全的 LLM 节点）；
- 分布式队列 / worker 扩容；
- 图片/二进制外置存储、执行数据脱敏导出；
- 浏览器端（服务就是本机 Node 进程；Web 编辑器只是它的一个视图）。

## 2. 来源与许可

> 本能力的**设计思路**参考了 n8n 项目的公开文档，**未使用其源代码，也未引入其 npm 依赖**。
>
> - 参考项目：n8n（https://github.com/n8n-io/n8n），调研版本 monorepo 2.46.0，commit `bb832f106c9c`（2026-11-03）
> - 参考页面：
>   - 执行与编排：https://docs.n8n.io/build/understand-workflows/understand-executions
>   - 执行顺序：https://docs.n8n.io/build/flow-logic/understand-execution-order
>   - 错误处理：https://docs.n8n.io/build/flow-logic/handle-errors-gracefully
>   - 代码与表达式：https://docs.n8n.io/build/code-in-n8n
> - 对方许可证：Sustainable Use License 1.0（https://github.com/n8n-io/n8n/blob/master/LICENSE.md）。
>   该许可不授予复制其代码、或在商业产品中分发其代码的权利。
> - 我们的实现方式：独立实现。仅借鉴不受版权保护的概念与行为约定（items 数组、节点级重试、
>   错误输出口、执行记录与执行数据分离、`{{ }}` 表达式），没有复制、没有逐行改写。
> - 许可证影响：本实现为自有代码，按本仓库许可证发布，不受 SUL 约束。
> - 明确排除：不引入 `n8n-workflow` / `n8n-core` / `n8n-nodes-base` 等包，也不把 n8n 源码 vendor 进本仓库。

## 3. 架构

```
public/（原生 JS 编辑器）
   index.html  app.js  canvas.js  style.css
        │  REST /api/*（fetch，轮询执行）
        ▼
src/server/
   main.ts       进程入口：配置 → 存储 → 运行时 → 调度 → HTTP
   config.ts     env + data/config.json（端口/数据目录/LLM 连接/执行上限）
   storage.ts    JSON 文件存储（工作流/执行/凭据/设置/静态数据/通知），原子写 + 双淘汰
   credentials.ts AES-256-GCM 文件级加密 + 凭据类型/校验
   runtime.ts    EngineDeps 装配：HTTP(fetch)/代码沙箱/凭据/子流程/静态数据
   scheduler.ts  定时触发（15s、串行、不补跑）
   http.ts       REST + 静态文件 + CORS + MCP 路由
   mcp.ts        MCP JSON-RPC（initialize/tools/list/tools/call）
        │
        ▼
src/engine/     execute.ts（执行栈）/ runData.ts / errors.ts / schedule.ts
src/expressions/  {{ }} 求值 + node:vm 代码沙箱
src/nodes/      core/*（触发器/数据/流程/HTTP/代码）+ integrations/*（日期/加密/XML/LLM/MCP/通知）
src/types.ts model.ts registry.ts   领域模型 / 工作流归一校验 / 节点注册表
```

分层原则：引擎不认识具体节点（只依赖 `NodeTypeDescription + execute`）；节点只通过
`context.helpers` 拿外部能力；HTTP/MCP 层只做协议；存储层不认识引擎（只管 JSON 与上限）。

## 4. 数据模型

### 4.1 Item

```ts
interface Item {
  json: Record<string, unknown>;
  binary?: Record<{ data: string; mimeType: string; fileName?: string }>;
  pairedItem?: number | { item: number; output?: number };
}
```

节点输入/输出都是 `Item[][]`（按输入/输出口）。`json` 是主通道，`binary` 是可选第二通道（base64）。

### 4.2 Workflow / Node / Connection

```ts
interface Workflow {
  id; name; description?; tags[]; nodes[]; connections; settings; active; versionId;
  createdAt; updatedAt; lastRunAt?;
}
interface WorkflowNode {
  id; name; type; position; parameters; disabled?; notes?;
  retryOnFail?; maxTries?; waitBetweenTries?;
  onError?: "stopWorkflow" | "continueRegularOutput" | "continueErrorOutput";
  alwaysOutputData?; executeOnce?; credentials?; pinData?;
}
type Connections = Record<sourceNodeId, { main: Array<Array<{ node: targetId; type: "main"; index: number }>> }>;
```

连接用**节点 id** 做键（重命名不丢边）；显示名只用于表达式 `$node["名字"]` 与错误信息。

### 4.3 Execution

```ts
interface WorkflowExecution {
  id; workflowId; workflowName; mode; status;
  startedAt; finishedAt?; durationMs?; triggerNodeId?; triggerData?;
  runData: Record<nodeId, NodeRunData[]>; error?; parentExecutionId?;
}
```

执行记录与执行数据分离：列表读元数据，点开才读节点数据；`saveDataSuccessExecution` /
`saveDataErrorExecution` 控制是否保存数据。

## 5. 执行引擎语义

1. **执行栈**：从触发器（或指定起点）开始，弹出节点 → 执行 → 把「输出口有 items 的下游」按画布位置压回队列；
2. **回环合法**（Loop 用法），以 500 次节点运行 / 单次 10 分钟兜底；
3. **多输入就绪**：同一输入口多上游按画布位置依次拼接；多输入节点（Merge）等所有已连接输入口都有上游完成才执行；
4. **重试**：节点级，夹 2–5 次 / 0–5000ms，只重跑该节点；
5. **错误三态**：停止 / 输入透传继续 / 成功项留原输出、错误项切到最后一个输出口；
6. **executeOnce / pinData / 部分执行**（startNodeId + destinationNodeId）；
7. **子流程**：注入回调递归，父执行 id 下传、深度 8、父取消传递；错误工作流 `mode:"error"`；
8. **确定性**：同输入同顺序；时间可注入；事件流 `executionStart / nodeStart / nodeFinish / executionFinish`。

## 6. 节点（30 个）

| 分组 | 节点 |
|---|---|
| 触发 | `manualTrigger` `scheduleTrigger`（间隔/每天/每周/5 段 Cron）`errorTrigger` `executeWorkflowTrigger` |
| 数据 | `set` `splitOut` `filter` `sort` `limit` `removeDuplicates` `aggregate` `itemLists` |
| 流程 | `if`（两输出）`switch`（动态输出）`merge` `splitInBatches` `wait` `noOperation` `stopAndError` |
| 集成 | `httpRequest` `code`（vm 沙箱）`executeWorkflow` `dateTime` `crypto` `xml` `llm` `mcpTool` `notification` |

每个节点 = `NodeTypeDescription`（中文名/说明/参数表/默认值/displayOptions）＋ `execute` ＋ 单测。
节点内不直接 `fetch`（走 `helpers.httpRequest`）、不读文件和环境（除集成节点明确允许的配置读取）。

## 7. 表达式与代码沙箱

- `{{ 表达式 }}`：整段保留原始类型，文本内拼接；`$json/$items/$itemIndex/$runIndex/$node/$now/$today/$timestamp/$workflow/$execution/$vars/$parameter` + helper；
- 求值时遮蔽 `process/require/fetch/globalThis/Function/eval` 等；目标是防误用与明显逃逸；
- 代码节点：`node:vm` 的 `runInNewContext`，只注入 `items/$input/$json/$item/$itemIndex/$runIndex/console`，
  `timeout` 默认 10 秒；**只支持同步代码**（Promise/定时器不等待，文档写明）；无网络/文件/进程入口；
- 信任边界：工作流由本机用户/智能体编写，表达式与代码等同于本机脚本；不做对抗级隔离。

## 8. 触发与调度

- 定时触发：间隔（秒/分/时）、每天、每周、Cron（自写 5 段解析，逐分钟推进，最多 366 天）；
- 调度器：15 秒轮询、全局串行、只跑 `active` 且含定时触发的工作流；
- **启动时错过不补跑**：把到点工作流的 `lastRunAt` 推到当前时刻，下一次从当前算起；
- 失败写本机通知；手动运行不影响定时计划。

## 9. 凭据与存储

存储键（`data/` 下 JSON 文件）：

| 文件 | 内容 | 上限 |
|---|---|---|
| `workflows.json` | 工作流 | 50 条 / 单条 512KB |
| `executions.json` | 执行记录（最新在前） | 60 条 / 1MB 双淘汰 |
| `credentials.json` | 凭据元数据 + 密文 | 30 条 |
| `settings.json` | 全局变量 + 模型连接 | 64KB |
| `static.json` | 工作流静态数据（跨运行） | 512KB |
| `versions.json` | 历史版本快照（每次保存留上一版） | 每工作流 10 版 / 全局 4MB |
| `notifications.jsonl` | 本机通知 | 保留最近查询 50 条 |
| `secret.key` | AES-256-GCM 密钥 | 0600 |

原子写（tmp + rename）；读盘坏条目逐条丢弃；凭据值 AES-256-GCM 加密，导出工作流**不含凭据值**。

## 10. 接口

### 10.1 HTTP（详见 `docs/CONTRACT.md` §4.5）

`/api/health`、`/api/node-types`、`/api/templates`、`/api/workflows`（CRUD/导入导出/启停/复制/运行/停止）、
`/api/executions`（列表/详情/删除/重跑）、`/api/credentials`（CRUD）、`/api/settings`、
`/api/notifications`、`/mcp`、静态文件。

### 10.2 MCP（和鸣客户端兼容）

POST `/mcp` JSON-RPC：`initialize`（返回 `Mcp-Session-Id` 响应头）、`notifications/initialized`、
`ping`、`tools/list`、`tools/call`。工具（19 个）：`workflow_list/get/create/update/delete/validate/templates/run/run_status/runs/import/export`、
`node_types`、`credential_types`，以及**智能体自主设计闭环**（1.1.0）：`credential_list`（凭据发现，不含密钥）、
`node_type_detail`（单节点完整参数 schema）、`workflow_test`（pinData 同步试跑，不产生副作用、不写回工作流）、
`workflow_set_active`（等价发布/取消发布）、`mcp_list_tools`（发现外部 MCP 服务的工具）。
`workflow_test` 默认 10 秒、最长 15 秒（MCP 单次调用 20 秒上限），超时置 `canceled` 并标 `timedOut`。
P1（1.2.0）再补 6 个：`workflow_search`（名称/描述/标签 + 启用状态过滤、返回可用标签）、
`workflow_execution_detail`（逐节点输入/输出，默认脱敏、单条 4KB 截断、总预算 240KB）、
`workflow_versions` / `workflow_version_get` / `workflow_restore`（每次保存自动留上一版，每工作流 10 版 / 全局 4MB）、
`workflow_sdk_reference`（JSON 结构/表达式/节点设置/试跑/常见链路/排错的静态规范）。
1.3.0 增加 `workflow_generate`（自然语言 → 工作流草稿，需配置模型连接，默认不保存）。

### 10.3 Webhook 触发

`webhookTrigger` 节点声明路径/方法/可选令牌；服务端在 `/webhook/<路径>` 路由里按
「active=true + 路径匹配 + 方法匹配」找到触发器，把请求体（数组按条、对象一条、空体一条 `{}`）
作为输入启动执行，返回 `202 {executionId}`。默认路径 = 工作流 id（不可猜），自定义路径需唯一；
同路径多条启用工作流返回 409。只监听回环地址；停止工作流即等价于关闭该 webhook。
**单次调用 20 秒超时** → `workflow_run` 异步返回 `executionId`，由智能体轮询 `workflow_run_status`。

## 11. Web 编辑器

原生 JS（无构建、无第三方库）：`public/index.html` + `app.js` + `canvas.js` + `style.css`。
画布：缩放/平移/框选/多选拖动/端口拖线/双击加节点/运行态描边；右侧参数表单由节点描述驱动；
执行记录逐节点看输入输出；凭据 CRUD；导入导出；模板；快捷键。
页面只是 REST 的一个视图——删掉 `public/` 服务仍可通过 MCP/HTTP 使用。

## 12. 安全边界

1. 只绑 `127.0.0.1`，无鉴权（回环即边界；不要端口转发）；**CORS 来源白名单**：仅和鸣客户端
   （`app://heming`）、本机 localhost 页面与无 Origin 调用；其它网页来源 403，云端网页版不能驱动本机插件；
2. 数据只在本机；出网只发生在 HTTP / LLM / mcpTool 节点（用户自己配置地址）；
3. 代码沙箱无网络/文件/进程入口；表达式遮蔽危险全局；
4. 凭据加密密钥与数据同目录——能读整个 `data/` 的人仍可解密（如实说明，不做安全承诺包装）；
5. 执行记录有体积上限（单条 item 64KB、整条记录 1MB），超限截断并标记 `dataTruncated`；
   代码沙箱用 `node:vm` + null 原型 context + JSON 字面量注入，自检用例确认宿主 `process/require` 不可达；
5. 导入外部工作流只做结构校验，不承诺沙箱化第三方逻辑（运行别人写的表达式等于运行其代码）。

## 13. 测试

- 引擎 / 表达式 / 节点 / 存储 / HTTP / MCP 各有单测；UI 有纯函数与 jsdom 交互测试；
- 门禁：`pnpm typecheck` + `pnpm test` 全绿；
- 与和鸣的联调：安装插件 → 接口区连接 → 授权工具 → 让智能体创建工作流并运行（在测试机上人工走一遍，不在本机安装）。

## 14. 路线图

1. Webhook 触发器（带路径令牌与 HMAC）；
2. 跨重启等待与执行恢复；
3. 变量/表达式面板、节点运行历史对比；
4. 更多节点（邮件、RSS、表格、文件）；
5. 执行数据导出/执行间对比、工作流包（.n8np 类似的多工作流导出）、Webhook 同步响应模式；
6. 执行数据导出与脱敏。
