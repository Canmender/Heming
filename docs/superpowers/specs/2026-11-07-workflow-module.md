# 工作流模块（workflows）：节点式自动化平台

- 日期：2026-11-07
- 分支：`feat/n8n-workflow`（从 `d.85.2.42.0` 拉出，独立 worktree）
- 版本：`d.87.2.42.0`（特性位 +1；并行会话占用了 `d.86` 的特性位，本分支跳一位避免版本冲突）
- 定位：插件区 → 「模块」Tab 里的**第五个内置能力模块**（与幕僚 / 信息中枢 / 自动化 / 模型路由同构）
- 调研依据：
  - `docs/research/2026-11-03-n8n-engine-notes.md`（执行栈、重试、错误输出、子流程、持久化调度的机制级调研）
  - `docs/research/2026-11-03-n8n-license-and-reuse.md`（许可边界、可借鉴/不可借鉴清单、声明模板）
  - `docs/research/2026-11-03-heming-automation-audit.md`（本仓自动化现状、红线与扩展点）

---

## 0. 一句话

给和鸣补上一个**节点式自动化平台**：在画布上把触发器、HTTP、代码、条件分支、大模型、
本机归档等节点连成一条工作流，手动或定时执行，逐节点看输入输出、错误与耗时；
数据只在本机，不执行任意 shell，不引入 n8n 的代码或依赖。

## 1. 背景与问题

和鸣原有的「自动化」模块（d.47/d.66）只做两件事：定时同步本机归档、重扫日程。
它是**白名单动作 + 定时器**，不能分支、不能组合、不能对接外部接口，也不能把
「智能体能力」编排进一条流程。用户提出「要有 n8n 那样的东西」，指的正是这层空缺：

1. **可编排**：动作不再是枚举，而是节点（触发器 / 转换 / 分支 / 集成），连起来就能表达复杂流程；
2. **可观察**：每次执行都能逐节点看到输入、输出、耗时与错误，而不是只有一个「成功/失败」；
3. **可触发**：手动、定时、子流程调用、失败触发，而不是只有「每天几点」；
4. **可复用**：工作流能导入导出、从模板起手、被别的流程调用；
5. **在本机**：不把数据交给第三方服务，也不把「用户自己编排」的能力外包给 n8n。

## 2. 目标 / 非目标

### 2.1 目标（本版交付）

- 工作流模型：节点、连接、设置、标签、启用状态、版本 id；
- 画布编辑器：缩放/平移、框选、多选拖动、拖线连接、删除、撤销/重做、节点面板、适配视图；
- 执行引擎：items 数据流、执行栈、分支、多输入合并、节点级重试、三种错误策略、
  `executeOnce`、`pinData`、部分执行、子流程、错误工作流、取消、上限兜底；
- 节点库：30 个核心/集成节点（清单见 §7）；
- 表达式：`{{ }}` + `$json/$items/$node/$now/$today/$vars/$parameter` 与常用 helper；
- 代码节点：Web Worker 沙箱里跑用户自己写的 JS（无 DOM/网络/存储入口）；
- 触发器：手动、定时（间隔/每天/每周/Cron）、错误、子流程调用；
- 凭据：本机保存、桌面端系统安全存储加密、节点按类型引用；
- 执行记录：逐节点数据、状态、耗时、错误、重跑、清理与双淘汰；
- 导入导出：类 n8n 导出形状（`{name,nodes,connections,settings}`），便于迁移与互操作；
- 起手模板：让用户不用从空画布开始；
- 模块接线：插件区模块卡、导航、命令面板、存储水位、后台调度、停用/启用；
- 文档、测试、版本与发布说明。

### 2.2 非目标（本版明确不做）

- **Webhook 触发器与「响应 Webhook」节点**：需要本机端口监听 + 桌面桥 + 路径令牌，
  牵动桌面进程安全模型，单独立轮；
- **任意 shell / 命令节点**：本仓红线（顶本机执行权限）不放开；
- **代码节点联网**：沙箱里没有 fetch/WebSocket，需要网络请用 HTTP 节点；
- **n8n 的 400+ 第三方集成与凭据类型**：只做「核心能力 + 本机能力」，
  第三方服务用 HTTP 节点或 MCP 工具替代；
- **多用户 / 权限 / 项目空间 / 团队共享工作流**：本仓是全站一个团队、工作流只属本机；
- **队列模式 / worker 横向扩容 / 持久化调度器**：单机单进程，不做分布式语义；
- **跨重启的执行恢复（waiting 持久化）**：Wait 节点只在本次运行内等待；
- **二进制外置存储（S3 等）、执行数据脱敏规则、审计导出**；
- **n8n 的 AI Agent/LangChain 工具链**：本版只提供「大模型」节点（单次补全），不做 Agent 编排；
- **工作流画布内的 sticky note / 便签 / 注释节点**（节点备注字段保留）。

## 3. 与 n8n 的关系：来源与许可（必读）

> 本能力的**设计思路**参考了 n8n 项目的公开文档，**未使用其源代码，也未引入其 npm 包**。
>
> - 参考项目：n8n（https://github.com/n8n-io/n8n），调研版本 monorepo 2.46.0，commit `bb832f106c9c`（2026-11-03）
> - 参考页面与要点：
>   - 执行与编排语义：https://docs.n8n.io/build/understand-workflows/understand-executions
>   - 执行顺序：https://docs.n8n.io/build/flow-logic/understand-execution-order
>   - 错误处理：https://docs.n8n.io/build/flow-logic/handle-errors-gracefully
>   - 表达式与代码：https://docs.n8n.io/build/code-in-n8n
> - 对方许可证：Sustainable Use License 1.0（https://github.com/n8n-io/n8n/blob/master/LICENSE.md）。
>   该许可**不授予**复制其代码、或在商业产品中分发其代码的权利；`LICENSE_EE.md` 与 `.ee.` 文件另有企业许可。
> - 我们的实现方式：独立实现。仅借鉴不受版权保护的概念、接口语义与行为约定
>   （例如「节点输入输出都是 items 数组」「重试是节点级属性」「执行记录与执行数据分离」
>   「错误输出是最后一个 main 输出口」「表达式用 `{{ }}` 模板」），
>   没有复制、没有逐行改写、没有把 n8n 源码结构当规格书逐文件翻译。
> - 许可证影响：本实现为和鸣自有代码，按本仓库许可证发布，不受 SUL 约束。
> - 明确排除：本模块不引入 n8n 源码或其 npm 包（`n8n-workflow` / `n8n-core` / `n8n-nodes-base` 等）；
>   原因见 `2026-11-03-n8n-license-and-reuse.md` §4。
> - 记录人 / 日期：Lead / 2026-11-07

## 4. 总体架构

```
UI 层（components/workflow/）
  WorkflowPage ─┬─ WorkflowList（列表/搜索/模板/导入导出）
                ├─ WorkflowEditor ─┬─ Canvas（wf-canvas：纯 SVG/div，自研）
                │                  ├─ NodeDetailPanel（参数表单/节点设置/输入输出/单节点运行）
                │                  └─ 工具栏（保存/运行/停止/撤销重做/启用/执行记录）
                ├─ ExecutionsPanel（历史/详情/重跑/清理）
                └─ CredentialsPanel（凭据列表/编辑/删除）

状态与运行时（lib/workflow/）
  store.ts        工作流 CRUD + 持久化（heming.workflows.v1）
  executions.ts   执行记录持久化 + 淘汰（heming.workflows.executions.v1）
  credentials.ts  凭据模型 + secureStorage 信封（heming.workflows.credentials.v1）
  transfer.ts     导入/导出（类 n8n 形状）
  runtime.ts      引擎依赖装配（HTTP 桥/fetch、代码沙箱、凭据、子流程）
  scheduler.ts    定时触发循环（15s、串行、错过不补跑）

执行层
  engine/         execute.ts（执行栈）/ runData.ts / errors.ts / schedule.ts
  expressions/    {{ }} 求值（同步）+ 代码沙箱（Worker）
  nodes/          core/*（触发器/数据/分支/HTTP/代码）+ integrations/*（日期/加密/XML/大模型/归档/通知）

模型层
  types.ts        领域类型（唯一事实来源）
  model.ts        创建/连接/校验/归一/克隆
  registry.ts     节点注册表
```

分层原则（为什么这样切）：

- **执行引擎不认识具体节点**：只依赖 `NodeTypeDescription + execute`，节点库可增量扩充；
- **画布不认识持久化**：只吐回调（移动/连线/删除/打开），由 shell 决定怎么落盘；
- **持久化不认识 React**：纯函数 + store，UI 只是消费者；
- **表达式/沙箱不认识节点**：节点通过 `context.helpers` 拿能力，不直接 import 引擎内部。

## 5. 数据模型

### 5.1 Item（数据单元）

```ts
interface Item {
  json: Record<string, unknown>;        // 必填：普通 JSON，可预览/可导出/可表达式访问
  binary?: Record<string, BinaryData>;  // 可选第二通道：base64 + mime
  pairedItem?: number | { item: number; output?: number }; // 血缘
}
```

节点输入是 `Item[][]`（按输入口），输出是 `Item[][]`（按输出口）。
所有节点返回 `Item[]` / `Item[][]` / `{main: Item[][]}` / `undefined` 之一，引擎统一收敛。

### 5.2 Workflow / Node / Connection

```ts
interface Workflow {
  id; name; description?; tags[]; nodes[]; connections; settings; active; versionId;
  createdAt; updatedAt; lastRunAt?;
}
interface WorkflowNode {
  id; name; type; position; parameters;
  disabled?; notes?;
  retryOnFail?; maxTries?; waitBetweenTries?;
  onError?: "stopWorkflow" | "continueRegularOutput" | "continueErrorOutput";
  alwaysOutputData?; executeOnce?;
  credentials?: Record<凭据类型, 凭据id>;
  pinData?: Item[];
}
type WorkflowConnections = Record<sourceNodeId, { main: Array<Array<{node,targetInputIndex}>> }>;
```

**连接用节点 id 做键**（不是名字）：重命名节点不会丢边；显示名只用于表达式 `$node["名字"]`
与错误信息，并在工作流内保持唯一。

### 5.3 执行记录

```ts
interface WorkflowExecution {
  id; workflowId; workflowName; mode; status;
  startedAt; finishedAt?; durationMs?;
  triggerNodeId?; triggerData?;
  runData: Record<nodeId, NodeRunData[]>;   // 每个节点每次运行一条
  error?; parentExecutionId?;
}
interface NodeRunData {
  startTime; executionTime; executionIndex; source[];
  status: "success" | "error" | "waiting";
  data?: { main: Item[][] };   // 受 saveData* 设置控制
  error?: NodeErrorInfo;
  itemsTotal;
}
```

**执行记录与执行数据分离**：列表只读元数据；点开才读节点数据。这样执行多了也不会把列表拖死。

## 6. 执行引擎语义

1. **执行栈**：`{nodeId, inputData}` 队列从触发节点（或指定起点）开始，弹出一个节点，
   把「输出口有 items 的下游」按画布位置顺序压回队列；不用递归。
2. **回环合法**：Loop 节点（分批循环）会把循环输出连回上游，引擎允许环，
   以「最多 500 次节点运行 + 单次执行 10 分钟」兜底，超过即置错并停止。
3. **输入合并**：同一输入口的多根上游线按上游节点画布位置（`x*10000+y`）排序后依次拼接 items。
4. **多输入就绪**：有多个输入口且都接了线的节点（如 Merge），等所有已连接输入口都至少
   完成过一个上游节点才执行，避免被执行两次。
5. **重试**：节点级 `retryOnFail` + `maxTries`（夹在 2–5）+ `waitBetweenTries`（0–5000ms）；
   只重跑该节点，中间尝试不留档。
6. **错误策略**：
   - `stopWorkflow`（默认）：整条执行置 `error`，保留已产生的 runData；
   - `continueRegularOutput`：把该节点输入原样透传下游，继续；
   - `continueErrorOutput`：成功项留在原输出，错误项切到最后一个输出口（错误输出），
     错误项带 `{json: {error, message, ...上游json}}`，继续。
7. **executeOnce**：同一执行内该节点只运行一次（首次拿全部输入），再次入栈直接跳过。
8. **pinData**：节点有固定数据时不执行、直接用固定输出（调试/部分执行）。
9. **部分执行**：`startNodeId`（从该节点开始，传入 inputData）+ `destinationNodeId`（到此为止）。
10. **子流程**：`executeWorkflow` 节点通过 runtime 注入的回调执行另一条工作流，
    父执行 id 传下去；递归深度上限 8 层；父取消信号传递给子执行。
11. **错误工作流**：执行失败且 `settings.errorWorkflowId` 存在时，以 `mode:"error"` 执行它，
    输入是错误上下文（execution/workflow/error 三段）；它自己失败不覆盖原错误。
12. **事件**：`executionStart / nodeStart / nodeFinish / executionFinish`，UI 靠它画运行态。
13. **确定性**：同一工作流 + 同一输入 ⇒ 同样的执行顺序；时间可注入（测试）。

## 7. 节点库（30 个）

| 分组 | type | 显示名 | 说明 |
|---|---|---|---|
| 触发 | `manualTrigger` | 手动触发 | 点击运行时触发 |
| 触发 | `scheduleTrigger` | 定时触发 | 间隔 / 每天 / 每周 / Cron（5 段） |
| 触发 | `errorTrigger` | 错误触发 | 错误工作流的入口，接收错误上下文 |
| 触发 | `executeWorkflowTrigger` | 子流程触发 | 被「执行子工作流」节点调用时触发 |
| 流程 | `if` | 条件判断 | 两输出：true / false |
| 流程 | `switch` | 分支 | 多条规则 + 兜底输出（动态输出数） |
| 流程 | `merge` | 合并 | 追加 / 按位置 / 按字段 / 选择分支 |
| 流程 | `splitInBatches` | 分批循环 | 循环项 / 完成后两个输出 |
| 流程 | `wait` | 等待 | 等待若干秒（可取消，不跨重启） |
| 流程 | `noOperation` | 空操作 | 原样透传（占位/汇合） |
| 流程 | `stopAndError` | 停止并报错 | 主动失败，消息可选表达式 |
| 数据 | `set` | 设置字段 | 增/改/删字段，值支持表达式 |
| 数据 | `splitOut` | 拆分 | 把数组字段拆成多条 items |
| 数据 | `filter` | 过滤 | 条件筛选（且/或、多种比较） |
| 数据 | `sort` | 排序 | 按字段、方向、类型 |
| 数据 | `limit` | 限制 | 取前/后 N 条 |
| 数据 | `removeDuplicates` | 去重 | 按全部或指定字段 |
| 数据 | `aggregate` | 汇总 | 计数/求和/收集字段为数组/拼接 |
| 数据 | `itemLists` | 列表操作 | 拆分/汇总/排序/限制/只需其一 |
| 集成 | `httpRequest` | HTTP 请求 | 方法/头/查询/体/超时；桌面端走主进程桥 |
| 集成 | `code` | 代码 | 用户 JS，Web Worker 沙箱，逐项或一次性 |
| 集成 | `executeWorkflow` | 执行子工作流 | 调用另一条工作流并取回输出 |
| 集成 | `dateTime` | 日期时间 | 取当前/加减/取整/格式化/提取部分 |
| 集成 | `crypto` | 加密 | SHA-256/SHA-1/HMAC/Base64/UUID |
| 集成 | `xml` | XML | XML ↔ JSON（DOMParser） |
| 集成 | `llm` | 大模型 | 用本机模型连接做一次补全（可选 JSON 输出） |
| 和鸣 | `infohubSearch` | 归档检索 | 只读检索本机 QQ/微信归档 |
| 和鸣 | `infohubAgenda` | 归档日程 | 只读读取本机日程摘要 |
| 和鸣 | `infohubSync` | 归档同步 | 写：必须显式选择来源 |
| 和鸣 | `notification` | 站内通知 | 往通知中心推一条 |

> 每个节点都带中文参数说明、默认值、`displayOptions` 条件显示与单测；
> 节点不得直接 `fetch` / 读 localStorage / 拿密钥，能力一律经 `context.helpers`。

## 8. 表达式与代码沙箱

### 8.1 表达式（同步）

- 语法：`{{ 表达式 }}`，可出现在任意字符串参数里；整段就是一个表达式时**保留原始类型**
  （数字/对象/数组），夹在文本里按字符串拼接；
- 上下文：`$json`、`$items`、`$itemIndex`、`$runIndex`、`$node["名字"].json/.all()`、
  `$now`、`$today`、`$timestamp`、`$workflow`、`$execution`、`$vars`、`$parameter`；
- helper：`$if/$isEmpty/$length/$toJson/$fromJson/$number/$string/$boolean/$uuid/$random/$item(index)` 等；
- 日期：`$now.plus(1,"day").format("yyyy-MM-dd")`、`startOf("week")` 等（本地时区，不引日期库）；
- 错误：中文、带表达式片段，指明「哪个变量不存在」。

### 8.2 代码节点（Web Worker 沙箱）

- 用户在代码节点里写 JS，输入 `items` / `$input.all()/first()/last()`，返回数组；
- 运行在 Blob Worker：**没有 DOM、没有 window、没有 fetch/WebSocket/localStorage**；
- 超时默认 10 秒，超时 terminate 并报中文错误；无 Worker 环境（jsdom/测试）走受限同步 fallback；
- 模式：一次性处理全部 items / 逐项处理。

### 8.3 信任边界（写清楚，别让后来者误会）

- 表达式与代码都是**本机用户自己写的**，与本机脚本同级信任，不是外部输入；
- 遮蔽全局与沙箱的目标是「防误用与明显逃逸」，不是对抗恶意代码；
- 工作流导入来自外部文件时会先做结构校验并展示摘要，但**不承诺沙箱化第三方工作流**——
  导入别人写的工作流等于运行他的表达式，这是产品已声明的边界（与 n8n 编辑器同口径）。

## 9. 触发器与调度

- 定时触发支持：每 N 分钟/小时、每天某时刻、每周某几天、5 段 Cron；
- 调度器 `useWorkflowScheduler(enabled)`：登录后挂载、模块启用时才生效、15 秒轮询、全局串行；
- **错过不补跑**：应用启动时若「下次运行时间」已过，直接顺延到下一个周期（与自动化模块同口径）；
- 只有 `active: true` 且含定时触发器的工作流会被调度；
- 手动运行不改变定时计划；失败推一条站内通知（kind `automation`）。

## 10. 凭据

- 类型：`httpBasic`、`httpHeader`、`httpQueryAuth`、`bearerToken`；
- 值只存本机：桌面端经 `secureStorage`（系统安全存储）加密信封，浏览器端明文兜底并在界面注明；
- 节点用 `credentials: { 类型: 凭据id }` 引用；表单只显示「已选凭据」，不回显密钥；
- 导出工作流**不包含凭据值**（与 n8n 一致）。

## 11. 本机存储与淘汰

| 键 | 内容 | 上限 |
|---|---|---|
| `heming.workflows.v1` | 工作流数组 | 50 条 / 单条 512KB |
| `heming.workflows.executions.v1` | 执行记录（最新在前） | 60 条 / 1MB，条数+字节双淘汰 |
| `heming.workflows.credentials.v1` | 凭据 | 30 条 |
| `heming.workflows.vars.v1` | 全局变量 + 模块设置 | 64KB |
| `heming.workflows.static.v1` | 工作流静态数据 | 128KB |

- 读写统一走 `lib/memory/storage.ts` 的 `readJson/writeJson`（永不抛，失败只返回 false）；
- 读盘用 `normalizeWorkflow` 逐条归一，坏条目丢弃而不是让整张列表读不出来；
- 执行数据按 `saveDataSuccessExecution / saveDataErrorExecution` 裁剪；
  单节点单次运行最多保留 200 条 items，单条 item 预览超 64KB 截断并标注；
- 录进设置区「本机存储」的「工作流」分组，可看占用、可清理。

## 12. 界面

页面：导航「工作流」（不占数字快捷键，默认排在「自动化」之后）。

- **列表**：名称、节点数、触发器数、启用开关、下次运行、最近执行状态、更新时间；
  搜索、新建（空白/模板）、导入、导出、复制、删除（二次确认）；
- **编辑器**：工具栏（返回/保存/运行/停止/撤销/重做/启用/执行记录/导入导出）+
  画布 + 右侧节点详情面板；快捷键 Ctrl/Cmd+S 保存、Ctrl/Cmd+Enter 运行、Delete 删除选中、
  空格拖平移、滚轮缩放、双击空白加节点；
- **画布**：自研 SVG/div（不引第三方画布库）：缩放 0.2–2、以光标为中心、框选、多选拖动、
  端口拖线（高亮可落点）、运行态描边与 item 数、禁用灰显、pinData 标记、适配视图；
- **节点详情**：参数表单（按 `NodePropertyDescription` 渲染 + displayOptions）、
  节点设置（重试/错误策略/执行一次/禁用/备注/固定数据）、输入/输出数据（树/表/原始）、
  「执行此节点」（部分执行）；
- **执行记录**：列表（状态/模式/时长/时间/工作流）+ 详情（逐节点、输入输出、错误）+ 重跑/删除/清空；
- **凭据**：列表 + 新建/编辑（按类型字段）+ 删除（二次确认）+ 「只存本机、桌面端加密」说明；
- **文案**：全中文、无 emoji、无「AI 腔」；空态给下一步动作；
- **可访问性**：画布 aria-label、节点 `role="button"`/tabIndex/Enter 打开、
  弹层焦点循环与 Esc 关闭、状态用 `role="status"` 播报、无鼠标也能完成主要操作。

## 13. 模块接线（与 d.70 可插拔模块同构）

- `lib/modules/registry.ts`：新增 `workflows` 模块（page `workflows`、
  `backgroundLoop: "workflow-scheduler"`、五个存储键、停用说明）；
- 导航轨 / 命令面板 / 导航分组 / 设置区导航顺序 / 存储水位：各加一项；
- `App.tsx`：路由懒加载 `WorkflowPage`；`useWorkflowScheduler(isModuleEffective(...,"workflows"))`；
- 插件区「模块」Tab：卡片显示贡献（导航入口+页面、后台调度每 15 秒）、本机数据与停用后果；
- 停用语义：只撤入口与调度，**不删任何数据**；重新启用即恢复；
- 默认启用：升级后入口在，行为与「没有这个模块」之前的其它页面无冲突。

## 14. 红线（本版必须守住）

1. 不复制、不引入 n8n 源码或其 npm 包；只按公开文档语义独立实现；
2. 不执行任意 shell / 命令节点；
3. 代码沙箱无 DOM / 网络 / 存储入口；HTTP 只能经节点与主进程桥（http/https、有上限）；
4. 工作流、执行记录、凭据、变量只在本机，不上云、不进团队动向、不导出到服务端；
5. 凭据值不随工作流导出；桌面端加密存储；
6. 定时触发不补跑、不自动拉起任何子进程；
7. 失败不阻塞主界面；执行上限（500 次节点运行 / 10 分钟）必须生效；
8. 导入外部工作流前先校验并展示摘要，坏包不进入「半可用」状态。

## 15. 测试与门禁

### 15.1 单元测试

- 模型：创建/归一（坏数据逐条丢弃）/校验/连接增删/克隆/名字唯一；
- 引擎：顺序、分支、合并、重试、三种 onError、executeOnce、pinData、部分执行、
  回环上限、取消、子流程、错误工作流、执行上限、事件顺序；
- 表达式：类型保留/文本拼接/嵌套/$node/$items/日期/错误/缓存；
- 沙箱：正常返回、超时、越权访问被挡、逐项模式；
- 节点：每个节点的正常与错误路径（假上下文）；
- 存储：工作流/执行记录/凭据的归一、淘汰、清理；
- 导入导出：类 n8n 形状 ↔ 本仓形状、未知节点、坏连接；
- 调度：到点执行、串行、错过顺延、模块停用不跑；
- 画布几何：坐标变换、端口位置、命中、框选、缩放夹紧；
- 接线：模块注册表/导航/命令面板/存储水位/模块卡（既有用例同步更新）。

### 15.2 组件测试

- 画布：渲染节点、点击选中、拖动回调、拖线回调、Delete、双击空白、缩放；
- 页面：列表渲染/搜索/新建、编辑器打开、节点详情切换、执行记录、凭据；
- 模块卡：五个模块、开关、依赖、停用说明。

### 15.3 门禁（本机实跑，2026-11-07）

- 工作流模块：28 个测试文件 / 406 例全绿；
- web 全量：276 文件 / 4011 例全绿（基线 3604，净增 407）；shared 29 例 / server 141 例 / desktop 全绿
  （desktop 含新增 `http-bridge.test.js` 9 例）；
- 根门禁 `pnpm test`（`pnpm -r build` + 各包测试）与 `pnpm typecheck` 均 exit 0；
- 新增依赖 0。

## 16. 明确不做 / 下一轮候选

1. Webhook 触发器与响应节点（桌面本地端口 + 路径令牌 + 请求队列）；
2. 工作流级的「等待后跨重启恢复」（持久化 waiting 执行）；
3. n8n 风格的自定义节点 SDK（第三方声明式节点包）；
4. 画布内的便签/注释/分组框、自动布局；
5. 执行数据脱敏规则、执行导出（CSV/JSON）、审计视图；
6. AI Agent 编排（工具选择/多轮自主循环），当前只有单次补全的「大模型」节点；
7. 团队共享工作流与权限（本仓工作流只属本机）；
8. 触发器去重键 / 并发上限 / 队列模式等分布式语义。

## 17. 风险与回滚

- **风险：代码节点与表达式是用户代码**——已限定在本机、遮蔽全局、Worker 隔离与超时；
  界面在代码节点与表达式输入旁常驻说明「只在本机运行，能访问本机数据」。
- **风险：执行记录写满 localStorage**——条数 + 字节双淘汰，单节点 items 上限，
  写盘失败静默但保留内存态，并在存储水位里可见。
- **风险：定时任务在页面隐藏时被浏览器节流**——桌面端常驻；轮询用 15 秒间隔，
  后台节流最多让触发晚一点（不丢触发，下一次 tick 会补上当前到点的）。
- **回滚**：停用「工作流」模块即撤下入口与调度，数据保留；
  需要彻底清除时在插件区模块卡「清理本机数据」或设置区存储清理里删除 `heming.workflows.*` 键。

## 附录 A：文件清单

（以实际 diff 为准；见 `git diff --stat`）

- `packages/web/src/lib/workflow/{types,model,registry,store,executions,credentials,transfer,runtime,scheduler}.ts`
- `packages/web/src/lib/workflow/engine/{execute,runData,errors,schedule,index}.ts`
- `packages/web/src/lib/workflow/expressions/{index,date,helpers,sandbox}.ts`
- `packages/web/src/lib/workflow/nodes/{index,templates}.ts`、`nodes/core/*`、`nodes/integrations/*`
- `packages/web/src/lib/workflow/canvas/geometry.ts`
- `packages/web/src/components/workflow/*.tsx`、`components/workflow/canvas/*`
- `packages/desktop/http-bridge.js`（+ test）
- 模块接线：`lib/modules/registry.ts`、`store/ui.ts`、`lib/navGroups.ts`、`lib/palette/pages.ts`、
  `components/NavRail.tsx`、`components/icons.tsx`、`components/plugins/ModulesView.tsx`、
  `lib/storageUsage.ts`、`components/SettingsPage.tsx`、`App.tsx`
