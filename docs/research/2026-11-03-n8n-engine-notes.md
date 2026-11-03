# n8n 工作流引擎调研：哪些语义值得移植到和鸣

- 日期：2026-11-03
- 调研对象：n8n `2.46.0`，commit `bb832f106c9cc5a39b01bb48bda578830bb8887b`（2026-11-03 06:33 UTC）
- 源码位置：`D:\Heming\.tmp\n8n`（`git clone --depth 1 --filter=blob:none --sparse` + `sparse-checkout`，`.tmp/` 已 gitignore，未提交任何内容）
- 和鸣基线：`d.48.1.11.0`；现状盘点见同日文档 `docs/research/2026-11-03-heming-automation-audit.md`，本文不重复其审计内容，只做机制级对照
- 本文所有行号均以上述 commit 为准，引用格式 `packages/...:行号`
- 方法：只读源码（未跑 `pnpm build` / `test`，未改任何源码文件，未 commit）

许可提示（必读）：n8n 是 fair-code，采用 Sustainable Use License，不是 OSI 开源。`LICENSE.md:19-24` 限定「仅可自用/非商业用途；对外分发须免费非商业」。因此本文说的「移植」一律指**按公开语义重新实现**，不是把 n8n 代码拷贝进和鸣；`.ee.` 文件另有企业许可，本文结论不依赖它们。

---

## 0. 一句话结论：最值得移植的 5 个设计

1. **动作是声明式数据，不是代码**：一个动作 = 一份描述（`INodeTypeDescription.properties` 参数表 + displayOptions 可见性）+ 一个受控执行函数；UI、默认值、校验、文档全部由描述驱动（`packages/workflow/src/interfaces.ts:3215`、`packages/workflow/src/interfaces.ts:2254`、`packages/cli/src/node-types.ts:101`）。
2. **执行结果统一成 items 数组并保留血缘**：节点输入输出都是二维 `INodeExecutionData[][]`，每项可用 `pairedItem` 指回上游哪一项；错误也走数据（error item），而不是只有异常一条路（`packages/workflow/src/interfaces.ts:1927`、`packages/core/src/execution-engine/workflow-execute.ts:1797`）。
3. **重试是节点级属性，只重跑该节点，且不产生中间运行记录**：默认 3 次 / 1000ms，硬夹在 2–5 次、0–5000ms（`packages/core/src/execution-engine/workflow-execute.ts:1861`、`:2397`）。
4. **执行记录与执行数据分离，清理是两级策略**：`status` 走 8 值状态机，`runData` 另存；按 maxAge + maxCount 软删，再过 buffer 硬删；失败执行默认保留（`packages/@n8n/db/src/entities/execution-entity.ts:41`、`packages/@n8n/config/src/configs/executions.config.ts:114`、`packages/@n8n/db/src/repositories/execution.repository.ts:757`）。
5. **调度把「下一次触发时刻」当成一等字段，并显式定义错过与去重**：`nextRunAt` + misfire 策略（coalesce / skip）+ 触发时刻去重键 `jobId:scheduledFor`（`packages/@n8n/scheduler/src/core/types/schedule.ts:86`、`packages/@n8n/scheduler/src/core/materializer/misfire.ts:29`、`packages/cli/src/scheduling/schedule-trigger-node/schedule-trigger-task.ts:14`）。

### 0.1 三处与任务书前提不一致的事实（以源码为准）

| # | 转述 | 实测 | 影响 |
| --- | --- | --- | --- |
| 1 | 存在 `prepareNodeExecution` | 本 commit 全仓 `grep prepareNodeExecution` **零命中**；生命周期被拆成 `createTaskStartedData`（`workflow-execute.ts:1784`）/ `executeNode`（`:1114`）/ `createTaskData`（`:2064`）三个方法 | 照名字去找会找不到落点；本文按真实方法名给证据 |
| 2 | n8n 用 tournament 解析器，「不是 eval」 | Tournament 确实先解析 + 改写 AST，但最后一步是 `new Function('E', code)` 动态生成函数执行（`packages/@n8n/tournament/src/FunctionEvaluator.ts:13`） | **不能**把 Tournament 当作「无 eval 的安全方案」移植；真正无代码生成的是更新的 native-evaluation 闭集解释器（见 §5） |
| 3 | 存在节点级 timeout | v1 引擎没有通用节点超时：`INode` 定义（`packages/workflow/src/interfaces.ts:1813-1845`）里没有超时字段，只有工作流级软超时；「超时」在节点上是各节点自己的参数（如 HTTP 的 `timeout`，`packages/core/src/execution-engine/routing-node.ts:240`） | 和鸣想做「单动作超时」需要自己设计，n8n 没有现成语义可抄 |

另一个必须知道的背景：本 commit 里 n8n 正在从 v1 引擎迁移到 v2（`packages/@n8n/engine/` 的 step 模型、`packages/@n8n/scheduler/` 的持久化调度）。v1 引擎仍是 `workflow-execute.ts` 这条生产路径。**对和鸣有价值的是它的数据模型与语义，不是 v1 的内部实现**——v2 的方向（step 行、scheduled job 行、显式 misfire）反而更接近「本机单用户小引擎」该有的形状。

---

## 1. 执行引擎：执行栈与节点生命周期

### 1.1 解决什么问题

把「节点图 + 分支 + 每节点可能多次运行」压成一个可持久化、可中断、可恢复的线性过程，而不是递归调用。和鸣现在是一动作一直线，但这套模型对「将来动作变多、要记录每一步」是直接可用的参照。

### 1.2 实现位置

| 概念 | 位置 |
| --- | --- |
| 待执行栈的数据结构 | `packages/workflow/src/run-execution-data/run-execution-data.v1.ts:60-70`（`nodeExecutionStack: IExecuteData[]`） |
| 单个待执行项 | `packages/workflow/src/interfaces.ts:572-578`（`IExecuteData { node, data, source, runIndex?, metadata? }`） |
| 主循环 | `packages/core/src/execution-engine/workflow-execute.ts:2303`（`processRunExecutionData`）、`:2332`（`while (this.isExecutionStackNotEmpty())`） |
| 取下一个节点 | `workflow-execute.ts:2254`（`popExecutionStack` = `shift()`）、`:2351` |
| 入栈 / 回栈 | `workflow-execute.ts:2259`（`pushExecutionStack` = `unshift()`，`:2547` 等待时回栈、`:2179` 失败时回栈） |
| 下游节点入栈 | `workflow-execute.ts:2567-2628`（遍历 `connectionsBySourceNode`） |
| 节点执行入口 | `workflow-execute.ts:1378`（`runNode`）→ `:1114`（`executeNode`） |
| 生命周期钩子 | `workflow-execute.ts:2390`（`nodeExecuteBefore`）、`:2540`/`:2555`/`:2182`（`nodeExecuteAfter`）；钩子类型在 `packages/core/src/execution-engine/execution-lifecycle-hooks.ts:16-59` |

### 1.3 关键代码行为

主循环就是一个普通工作队列（不是递归）：

```ts
// workflow-execute.ts:2332-2352
executionLoop: while (this.isExecutionStackNotEmpty()) {
  if (this.shouldStopExecuting()) return;
  executionData = this.popExecutionStack();
  executionNode = executionData.node;
  ...
  const hasInputData = this.ensureInputData(workflow, executionNode, executionData);
  if (!hasInputData) { lastExecutionTry = currentExecutionTry; continue executionLoop; }
```

`executeNode` 只做三件事：造上下文、调用节点、收尾（close 函数）。节点「有没有 execute 方法」在 `runNode` 里分流成 execute / poll / trigger / declarative / webhook 五种：

```ts
// workflow-execute.ts:1155-1163
} else if (nodeType.execute) {
  data = isNodeClassInstance(nodeType)
    ? await nodeType.execute(context, subNodeExecutionResults)
    : await nodeType.execute.call(context, subNodeExecutionResults);
} else { throw new UnexpectedError("Can't execute node. ..."); }
```

每个节点跑完生成一条 `ITaskData`，这是「运行记录」的最小单位：

```ts
// workflow-execute.ts:2064-2079
executionTime: Date.now() - taskStartedData.startTime,
metadata: executionData.metadata,
executionStatus: this.runExecutionData.waitTill ? 'waiting' : 'success',
```

其中 `startTime/executionIndex/source` 来自执行前（`:1784-1791`），`error` 在执行失败时补上（`:2125-2126`）。字段定义见 `packages/workflow/src/interfaces.ts:3709-3745`。

### 1.4 出错时如何向上传播

三条路径，优先级如下：

1. **节点抛异常**：`try/catch` 捕获后转成可序列化错误，`lastNodeExecuted` 记为该节点（`workflow-execute.ts:2496-2498`、`:2002-2034`）；重试耗尽后交给 `handleNodeExecutionError`。
2. **节点返回错误项**（`item.error` 或 `json.error`）：不算抛异常，但在重试判定里被当成失败（`:2392-2394`），见 §2。
3. **不继续执行**：`handleNodeExecutionError` 返回 `continueExecution: false`，主循环 `break`（`:2522-2524`），循环结束；`processSuccessExecution` 把工作流状态置为 `error` 并把错误写进 `resultData.error`（`:2969-2999`、`:3028-3033`）。剩下没执行的节点不再执行，但已产生的 `runData` 保留在结果里。

```ts
// workflow-execute.ts:2511-2525
if (executionError !== undefined) {
  const outcome = await this.handleNodeExecutionError({...});
  nodeSuccessData = outcome.nodeSuccessData;
  if (!outcome.continueExecution) break;
}
```

### 1.5 `continueOnFail` / `onError` 的语义（三种取值）

`OnError = 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow'`（`packages/workflow/src/interfaces.ts:1812`），旧字段 `continueOnFail` 仍兼容（`:1828`）。判定入口：

```ts
// workflow-execute.ts:1061-1066
private continuesOnError(node: INode): boolean {
  return node.continueOnFail === true ||
    ['continueRegularOutput', 'continueErrorOutput'].includes(node.onError ?? '');
}
```

| 取值 | 行为 | 证据 |
| --- | --- | --- |
| `stopWorkflow`（默认） | 记错误、停整条工作流、状态 `error` | `workflow-execute.ts:2165-2189` |
| `continueRegularOutput` | 把该节点的**输入项原样透传**给下游（节点没有 main 输入时输出为空），继续执行 | `:2154-2162` |
| `continueErrorOutput` | 成功项留在原输出，错误项被切到「最后一个 main 输出」（错误输出）：错误源是 `item.error`，或 `json` 只有 `error/message/details` 三键时的 `json.error` | `:1948-1954` 调用 `:3063-3169`，切分逻辑 `:3098-3168` |

错误输出还有一个细节：错误项会把配对的上游 item 的 `json` 合并进来（`dataProxy.$getPairedItem`，`:3119-3158`），这样错误分支能看到「是哪条输入失败的」。

### 1.6 子工作流怎么执行

子工作流不是引擎内递归，而是宿主注入的能力：

- 接口：`IWorkflowExecuteAdditionalData.executeWorkflow`（`packages/workflow/src/interfaces.ts:4044-4048`）
- 实现：`packages/cli/src/workflow-execute-additional-data.ts:316-411`；子执行有自己的 execution 记录（`:365`），父执行通过 `metadata.subExecution` 指过去（`packages/workflow/src/interfaces.ts:3620`），`doNotWaitToFinish` 时分离执行（`:397-408`）
- 超时继承：子工作流截止时间 = `min(父截止, 子自己截止)`，不等待时用子自己的（`:299-311`），并写进子执行的 `additionalData.executionTimeoutTimestamp`（`:731-737`）
- 子工作流失败回到父节点时，按「节点失败」同样路由：能 continue 就产出一个 error item 并配对每个输入项，否则重新抛（`workflow-execute.ts:1391-1415`）
- 安全闸：`callerPolicy` / `callerIds` 限制谁能调用该子工作流（`packages/workflow/src/interfaces.ts:4197`）

### 1.7 移植到和鸣：保留 / 丢掉 / 改造

- **保留**：执行栈这个心智模型（数组 + shift/unshift，而不是递归），以及「每步产出一条记录（开始时间、耗时、状态、数据、错误）」的形状。和鸣动作未来若变成「同步 → 导出 → 通知」多步，这正是需要的骨架。
- **保留**：`continueOnFail` 的三种语义收敛成和鸣的「本步失败后是否继续后续步骤」。注意 n8n 的「透传输入」对和鸣没意义（没有 data 管道），应改成「产出 error 状态的步骤记录，然后继续 / 停止」。
- **丢掉**：`continueErrorOutput` 的错误输出连接、多输出、AI tool 的 `rewireOutputLogTo`、`alwaysOutputData`、`executeOnce`——这些都是「节点图」的产物，和鸣本轮没有图。
- **丢掉**：子工作流整机制。和鸣若要做组合，应该用**显式声明的动作序列**（白名单动作按固定顺序），而不是允许引用任意另一条自动化任务——后者等于打开「动态拼接任务」的口子，会削弱白名单边界。只借鉴「截止时间取 min、子执行有独立记录、父记录能指到子记录」这三条。
- **改造**：n8n 的「主循环 + 节点类型分派」对和鸣是过度设计；和鸣只需要「一个动作一个 `run` 函数」，把「记录/重试/超时」放在 runner 外层（横切），不要塞进每个动作里。

---

## 2. 重试：节点级、只重跑节点、中间尝试不留档

### 2.1 解决什么问题

慢速外部依赖（HTTP、数据库、本机边车）偶发失败，重试一次往往就好了。n8n 把重试做成节点属性而不是工作流属性，因此同一个工作流里「易失败的节点」可以单独开启。

### 2.2 实现位置

| 内容 | 位置 |
| --- | --- |
| 节点字段 | `packages/workflow/src/interfaces.ts:1822-1824`（`retryOnFail?`、`maxTries?`、`waitBetweenTries?`） |
| 参数校验/默认值 | `packages/core/src/execution-engine/workflow-execute.ts:1861-1872` |
| 重试等待 | `workflow-execute.ts:1878-1885`（`waitForRetry`，可被取消） |
| 重试主循环 | `workflow-execute.ts:2395-2499` |
| 失败判定 | `workflow-execute.ts:2392-2394`（`checkFailure`） |
| 写外部工具的参数边界 | `packages/cli/src/modules/mcp/tools/workflow-builder/update-workflow.tool.ts:147-149`（`maxTries` 2–5、`waitBetweenTries` 0–5000） |
| 运行记录里的重试链 | `packages/@n8n/db/src/entities/execution-entity.ts:57-61`（`retryOf` / `retrySuccessId`，用于「手动重试整个执行」） |

### 2.3 关键代码行为

```ts
// workflow-execute.ts:1861-1871
private getRetryParams(executionData: IExecuteData): [number, number] {
  const isResumedError = executionData.metadata?.resumeError !== undefined;
  if (executionData.node.retryOnFail !== true || isResumedError) return [1, 0];
  // TODO: Remove the hardcoded default-values here and also in NodeSettings.vue
  return [
    Math.min(5, Math.max(2, executionData.node.maxTries || 3)),
    Math.min(5000, Math.max(0, executionData.node.waitBetweenTries || 1000)),
  ];
}
```

```ts
// workflow-execute.ts:2398-2405
for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
  try {
    if (tryIndex !== 0) {
      if (!(await this.waitForRetry(waitBetweenTries))) break; // 取消就不再重试
      executionError = undefined;
    }
    ...
  } catch (error) {
    executionError = this.reportNodeExecutionError(error, executionNode, workflow);
  }
}
```

要点：

- **默认值**：`retryOnFail !== true` 时只跑 1 次；开启后 `maxTries` 缺省 3、`waitBetweenTries` 缺省 1000ms。因为用了 `||`，用户显式写 `0` 也会落回默认值（所以「0 次等待」实际做不到 0；MCP 工具 schema 允许 0 但引擎不会采纳）。
- **硬边界**：tries ∈ [2,5]，wait ∈ [0,5000]ms，前端 UI 与 MCP 工具都被同一组数字约束。
- **哪些失败会重试**：没有按错误类型/HTTP 状态分类。`catch` 捕获的任何异常都会重试；另外节点「返回错误项」也会触发重试，判定只看**第一个输出的第一个 item**：

```ts
// workflow-execute.ts:2392-2394
const checkFailure = (data: IRunNodeResponse | EngineRequest) =>
  !isEngineRequest(data) && isErrorValue(data.data?.[0]?.[0]?.json?.error);
```

  `NodeApiError` 的 `httpCode` 只在错误上报与展示里用到（`:1979-1995` 明确把 axios 错误从上报里排除），**不参与重试决策**；`429` 只在声明式 HTTP 节点里给一句提示（`packages/core/src/execution-engine/routing-node.ts:319-322`）。
- **重试期间状态怎么记**：**中间尝试完全不落记录**。`ITaskData` 在重试循环之后才写（`workflow-execute.ts:2508`、`:2537`），失败时也只写最终那条（`:2125-2126`）；`runIndex` 由 `runData` 长度推导（`:1844-1852`），重试不会让它自增。也就是说「重试了 3 次」这件事在 n8n 里**不可见**，只能看到最终失败。
- **重试粒度**：重跑整个节点（所有 items），不是单个 item。没有 per-item 重试。
- **等待是串行阻塞的**：`waitForRetry` 直接 `await sleep(...)`，注释里写着 TODO 想改成「等待期间跑别的节点」（`:1881`）。对单用户桌面 App 这反而是对的（不并发）。
- **可持续性**：等待用 `sleep(ms, abortController.signal)`，取消会立刻中断重试（`:1878-1885`）。
- **手动重试整个执行**是另一个机制：新建一条 execution，用 `retryOf/retrySuccessId` 关联（`execution-entity.ts:57-61`），不复用上面的节点级重试。

### 2.4 移植到和鸣：保留 / 丢掉 / 改造

- **保留**：三个参数的名字与数值边界（`retry.maxTries` 2–5、`waitBetweenTries` 0–5000ms、默认 3/1000）；「重试是任务/节点可选属性、默认关闭」；「等待可被取消」。
- **保留**：重试只重跑当前动作，不影响前后步骤。
- **必须改造**：
  1. n8n 的 `||` 默认值写法会让 `0` 失效，和鸣归一化时应用 `??` 并明确夹紧，别复制这个坑。
  2. n8n 不记录中间尝试；和鸣恰好缺「运行记录」，应当在运行记录里写 `attempts`（以及每次失败的 `errorCode`），让用户看到「失败 2 次后成功」。这是**比 n8n 更适合桌面 App**的偏离。
  3. n8n 不看错误类型；和鸣必须看，否则「边车未连接」「权限拒绝」「数据损坏」这类确定性失败会被重试放大。建议在动作执行器返回 `{ ok:false, retryable:boolean, code }`，只对 `retryable` 重试（见 §10 第 4 条）。
  4. n8n 的重试等待会阻塞后续节点；和鸣是全局单槽串行，重试等待期间会把「下一条任务」也挡住，需要在口径里写明（或把重试实现成「写 `retryAt` 后释放锁」，见 §10 第 5 条）。
- **丢掉**：`isResumedError` 跳过重试、`maxTries` 的手动重试链（`retryOf`）——和鸣没有「整个执行重试」的概念，只有下一次计划。

---

## 3. 节点模型：声明式参数 + 注册表

### 3.1 解决什么问题

n8n 有 1500+ 节点，不可能为每个节点手写 UI 和校验。它把「节点是什么」压成纯数据描述，UI 和参数解析都从描述推导；代码里只剩一个 `execute`。

### 3.2 实现位置

| 内容 | 位置 |
| --- | --- |
| 节点实例（工作流里的节点） | `packages/workflow/src/interfaces.ts:1813-1845`（`INode`：`type`、`typeVersion`、`parameters`、`disabled`、`retryOnFail`、`onError`…） |
| 节点类型描述 | `packages/workflow/src/interfaces.ts:3215-3261`（`version`、`inputs/outputs`、`properties`、`credentials`、`requestDefaults`…） |
| 参数描述 | `packages/workflow/src/interfaces.ts:2254-2290`（`displayName`、`name`、`type`、`default`、`options`、`displayOptions`、`routing`、`typeOptions`…） |
| 参数类型枚举 | `packages/workflow/src/interfaces.ts:2013-2037`（`string`/`number`/`boolean`/`options`/`collection`/`fixedCollection`/`json`…） |
| 可见性规则 | `packages/workflow/src/interfaces.ts:2219-2236`（`IDisplayOptions.show/hide`，值为期望值数组） |
| 可见性求值 | `packages/workflow/src/node-helpers.ts:419-470`（`displayParameter`） |
| 参数依赖排序 | `packages/workflow/src/node-helpers.ts:690-745`（`getParameterDependencies` / `getParameterResolveOrder`） |
| 带默认值与可见性过滤的解析 | `packages/workflow/src/node-helpers.ts:773-850`（`getNodeParameters`） |
| 节点注册与查找 | `packages/cli/src/node-types.ts:19`、`:101-128`（`getByNameAndVersion`） |
| 节点加载（文件 → 类 → 注册表） | `packages/core/src/nodes-loader/directory-loader.ts:165-242`、`:244-259` |
| 版本化节点 | `packages/workflow/src/node-helpers.ts:1901-1909`（`getVersionedNodeType`） |
| 声明式 HTTP 节点的路由 | `packages/core/src/execution-engine/routing-node.ts:64`（`runNode`）、`:142-196`（用 `requestDefaults` + `properties` 逐项算请求参数） |

### 3.3 关键代码行为

```ts
// packages/workflow/src/interfaces.ts:2254-2274（节选）
export interface INodeProperties {
  displayName: string;
  name: string;
  type: NodePropertyTypes;
  typeOptions?: INodePropertyTypeOptions;
  default: NodeParameterValueType;
  displayOptions?: IDisplayOptions;
  options?: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection>;
  required?: boolean;
  routing?: INodePropertyRouting;
}
```

可见性不是硬编码，而是声明：

```ts
// packages/workflow/src/interfaces.ts:2223-2228
show?: {
  '@version'?: Array<number | DisplayCondition>;
  '@feature'?: Array<string | DisplayCondition>;
  [key: string]: Array<NodeParameterValue | DisplayCondition> | undefined;
};
```

`displayParameter` 的语义是：`show` 里**所有**规则都命中才显示，`hide` 里**任一**命中就隐藏；`getParameterResolveOrder` 按 `displayOptions` 依赖关系排序后再解析，保证「先算 A 才能判断 B 是否显示」（`node-helpers.ts:826-831`）。

注册表本身很薄：`getByNameAndVersion` 只是查 map + 应用版本，节点由 `DirectoryLoader.loadNodeFromFile` 注册进 `known.nodes` / `nodeTypes` / `types.nodes`（`directory-loader.ts:219-234`），查找时才懒加载类（`:244-259`）。

### 3.4 与「动作注册表」的关系，以及移植取舍

n8n 的节点 ≈ 和鸣的动作，一一对应关系：

| n8n | 和鸣对应物 | 是否要 |
| --- | --- | --- |
| `INodeTypeDescription`（`name`/`version`/`properties`/`description`） | 动作描述 object（`kind`/`version`/`label`/`params`/`describe`） | 要 |
| `INodeProperties[]` | 动作参数 schema（枚举/布尔/数字，带 `label`、`default`、`visibleIf`） | 要，但只保留和鸣用得到的 4–5 种类型 |
| `displayOptions.show/hide` | 参数可见性（例如「仅 sync 动作显示来源勾选」） | 要；现有 `packages/web/src/components/AutomationPage.tsx:497` 写死 `kind==="infohub.sync"` 正是该被替换的点 |
| `NodePropertyTypes` 全量 | 只留 `string`/`number`/`boolean`/`select`/`multiSelect` | 只留子集 |
| `INodeType.execute(context)` | `run(task): Promise<AutomationResult>` | 要 |
| `credentials` / `requestDefaults` / `routing` | **无**（和鸣红线：任务不含凭据、不发任意请求） | 不要 |
| `version` + 版本化节点类 | `version: number` + 归一化迁移（老任务按旧版本读） | 要版本号，不要「多版本类」机制 |
| 文件扫描加载 / 社区节点 | 静态注册（编译期 import） | 不要动态加载 |

建议的注册表形态（与审计文档 §4-(a) 的 `kinds.ts` + `actions.ts` 拆分一致）：

```ts
interface ActionDescriptor {
  kind: AutomationKind;            // 白名单字面量
  version: number;
  label: string;
  params: ActionParamDescriptor[]; // 声明式参数，驱动 UI 与校验
  describe(task): string;
  validate(draft): string;         // 空串=通过
  run(task, ctx: { signal?: AbortSignal }): Promise<AutomationResult>;
}
```

要丢掉的 n8n 复杂度：类实例/`loadClass`/`IVersionedNodeType`/`requestDefaults`/`poll`/`trigger`/`webhook`/`supplyData`/`credentials`/i18n 翻译文件/图标与 codex 元数据。

---

## 4. 数据流：items、per-item、pairedItem

### 4.1 解决什么问题

一个节点可能产出 0/1/N 条数据，下游要能逐条处理，还要能回答「这条结果是从上游哪条来的」。n8n 的答案是：**所有节点输入输出都是 items 数组的数组**，血缘用 `pairedItem`。

### 4.2 实现位置

| 内容 | 位置 |
| --- | --- |
| 单条数据 | `packages/workflow/src/interfaces.ts:1927-1973`（`json`、`binary?`、`error?`、`pairedItem?`、`metadata?`） |
| 连接数据（按输出索引） | `packages/workflow/src/interfaces.ts:3759-3764`（`ITaskDataConnections`） |
| 血缘 | `packages/workflow/src/interfaces.ts:1864-1868`（`IPairedItemData { item, input?, sourceOverwrite? }`） |
| 自动盖章 | `packages/core/src/execution-engine/workflow-execute.ts:1797-1838`（`addPairedItemLineage`） |
| 缺失血缘的启发式修复 | `workflow-execute.ts:3190-3249`（`assignPairedItems`） |
| 节点自行标注 | `packages/core/src/execution-engine/node-execution-context/utils/construct-execution-metadata.ts:8-17`；`routing-node.ts:52-54` |
| 每 item 一个 ctx（声明式节点） | `packages/core/src/execution-engine/routing-node.ts:98-117`；上下文类 `packages/core/src/execution-engine/node-execution-context/execute-single-context.ts:27-127` |
| 「每 item 执行一次」是节点选项不是引擎开关 | `packages/workflow/src/constants.ts:29`（`CODE_EXECUTION_MODES = ['runOnceForAllItems','runOnceForEachItem']`，只有 Code 节点使用） |
| `executeOnce` | `workflow-execute.ts:1100-1112`（只保留每个输入的第 1 条） |
| 空/无输出的分支语义 | `workflow-execute.ts:2488-2493`（`null` = 分支结束）；`:2604-2608`（空数组不调度下游）；`:2040-2061`（`alwaysOutputData` 注入一条空 item） |

### 4.3 关键代码行为

引擎默认是「每节点执行一次，一次拿到全部 items」：

```ts
// execute-single-context.ts:93-108（声明式/每 item 路径里，一个 item 一个上下文）
getInputData(inputIndex = 0, connectionType = NodeConnectionTypes.Main) {
  ...
  const data = allItems?.[this.itemIndex];
  ...
  return data;
}
```

血缘在节点执行前由引擎统一盖：

```ts
// workflow-execute.ts:1826-1832
return {
  ...item,
  pairedItem: { item: itemIndex, input: inputIndex || undefined },
};
```

错误也走数据：当 `continueOnFail` 时，节点可以 `return { json: {}, error: nodeError }`（`routing-node.ts:304-306`、`:341-343`），下游/错误输出据此分流。`INodeExecutionData` 的注释明确写了这条契约（`packages/workflow/src/interfaces.ts:1939-1945`）。

单 item 与多 item 的边界，实际由 4 条规则决定：

1. `executeOnce`：截断为第一条输入（`:1100-1112`）。
2. 返回 `null`：节点成功但无数据，分支到此结束（`:2488-2493`）。
3. 返回 `[]`（空数组）：节点执行了但没数据，下游不会被调度（`:2604-2608`）。
4. `alwaysOutputData`：即使没数据也塞一条 `{json:{}}`，保持血缘指向所有输入（`:2040-2061`）。

### 4.4 移植到和鸣：保留 / 丢掉 / 改造

- **保留**：`AutomationResult` 里显式区分「成功有数据 / 成功无数据 / 失败带错误项」，并保留一个可选的 `items` 字段承载「一次动作产出多条结果」的场景——和鸣的 `infohub.sync` 天然是「每个来源一条 report」，这正是 items 的用法（`packages/web/src/lib/automation/runner.ts:50-54` 现在把 reports 压成一句中文摘要，信息被压缩掉了）。
- **保留（简化）**：`pairedItem` 的思想——每条结果记录它来自哪次输入/哪个来源。和鸣单步任务没有上游，但「本次运行 → 产出 N 条结果」的父子关系仍值得留一个 `runId`。
- **丢掉**：二维数组（输出索引 × items）、多输入类型（`main`/`ai_tool`/`ai_memory`…）、binary、`executeOnce`、`alwaysOutputData`、`assignPairedItems` 的启发式、`$getPairedItem`。
- **改造**：不要引入「每 item 执行一次」的引擎模式。和鸣动作是一个整体，多结果只是 `items` 数组，不需要逐 item 重跑动作。
- **注意**：n8n 的空数组 vs null 区分对「图」有意义，对单步任务无意义；和鸣只需要 `items?: AutomationRunItem[]`，空数组就是「无结果」，不需要 null。

---

## 5. 表达式：n8n 怎么做到「能写 JS」以及为什么不能照搬

### 5.1 解决什么问题

用户希望在参数里写 `={{ $json.email }}`、`{{ $now.minus({days:1}) }}`，让节点参数动态化。n8n 的方案是「表达式字符串 + 数据代理」。

### 5.2 实现位置

| 内容 | 位置 |
| --- | --- |
| 表达式入口 | `packages/workflow/src/workflow-expression.ts:85-195`（`getParameterValue`，递归解析 `=` 开头的字符串/对象/数组） |
| 单值解析 | `packages/workflow/src/expression.ts:844-877`（`resolveSimpleParameterValue`） |
| 求值器选择 | `packages/workflow/src/expression.ts:292-331`（`legacy` / `vm` / `quickjs`；`vm` 只在 Node，浏览器只能 `quickjs`） |
| 内置变量 | `packages/workflow/src/workflow-data-proxy.ts:1768-1799`（`$json`、`$node`、`$parameter`、`$now`、`$today`、`$binary`、`$item`、`$items`、`$input`、`$workflow`、`$itemIndex`、`$runIndex`、`$jmespath`、`DateTime/Interval/Duration`） |
| `$json`/`$binary` 的真实取值 | `workflow-data-proxy.ts:1803-1827`（Proxy 的 get 钩子按当前上下文节点/条目取） |
| 参数错误注解 | `packages/core/src/execution-engine/node-execution-context/node-execution-context.ts:556-591`（表达式错误补 `parameter` 与 `cause`） |
| 沙箱 AST 钩子 | `packages/workflow/src/expression-sandboxing.ts:24`（保留变量名）、`:193`（类扩展校验）、`:222`（`this` 清洗）、`:333`（`$` 校验）、`:389`（原型清洗）、`:561-563`（禁 `with`）、`:572-575`（钩子总表）、`:577-583`（属性名 sanitizer） |
| legacy 求值器（关键） | `packages/workflow/src/expression-evaluator-proxy.ts:9-15`；`packages/@n8n/tournament/src/FunctionEvaluator.ts:8-21` |

### 5.3 关键代码行为

`getParameterValue` 只做一件事：递归遍历参数值，遇到 `=` 开头就求值，对象/数组继续下钻。

```ts
// workflow-expression.ts:162-169
if (Array.isArray(parameterValue)) {
  const returnData = parameterValue.map((item) => resolveParameterValue(item as NodeParameterValueType, {}));
  return returnData as NodeParameterValue[] | INodeParameters[];
}
```

**关键事实：legacy 引擎最终用 `new Function`。**

```ts
// packages/@n8n/tournament/src/FunctionEvaluator.ts:8-16
private getFunction(expr: string): Function {
  if (expr in this._codeCache) return this._codeCache[expr];
  const [code] = this.instance.getExpressionCode(expr);
  const func = new Function('E', code + ';');
  this._codeCache[expr] = func;
  return func;
}
```

也就是说：Tournament 做的是「用 recast/esprima 解析 → 用 AST 钩子改写（保留变量、禁 `with`、禁原型/类扩展、`$` 必须被调用、访问属性前 sanitize）→ 拼成函数体 → `new Function` 执行」。沙箱钩子清单见 `expression-sandboxing.ts:572-575`，它确实堵住了常见逃逸，但**本质仍是动态代码生成**。vm/quickjs 引擎只是把执行放进 isolate（`expression.ts:318-331`，`packages/@n8n/expression-runtime/`），同样是执行 JS。

**真正「无代码生成」的是新的 native-evaluation 子集解释器**：

- 入口与设计说明：`packages/workflow/src/expressions/native-evaluation/index.ts:23-57`（只支持数据根访问、允许的方法白名单、5 个数组迭代器；「expression text is never executed as code」）
- 回退：不符合子集的表达式「declined」后走正常（isolate）管线（`packages/workflow/src/expressions/native-evaluation/index.ts:59-60`、`expression.ts:864-877`）
- 预算：`MAX_RESULT_LENGTH = 1_000_000`、`MAX_STEPS = 100_000`、`MAX_WORK = 10 * MAX_RESULT_LENGTH`、`MAX_DEPTH = 64`（`packages/workflow/src/expressions/native-evaluation/grammar.ts:297-318`）
- 解析依赖：仍是 esprima AST（`grammar.ts`/`parser.ts`），只是把 AST 重新解析成闭集语法树

### 5.4 移植到和鸣：只借鉴设计，不建议本轮落地

- **不可移植**：Tournament / `new Function` / Code 节点 / vm / quickjs。原因有三：① 直接违反和鸣「无任意脚本执行」红线；② Electron 渲染进程通常有 CSP（`unsafe-eval` 禁用）与 `contextIsolation`，`new Function` 会失败或逼迫放宽安全策略；③ 即使只允许「表达式」，`$json['__proto__']` 这类逃逸面在桌面端是不可接受的维护负担。
- **设计可借鉴**：native-evaluation 的「闭集语法 + 预算 + 不符合就拒绝」思路。若将来和鸣真要参数动态化，正确形态是**受限占位符**而不是表达式语言：固定词表（如 `{{date}}`、`{{taskName}}`、`{{lastStatus}}`）+ 手写 tokenizer + 白名单替换，绝不允许属性访问/函数调用。成本是 L，收益在本轮几乎为零（现有动作参数全是枚举/布尔，见审计文档 §4-(a)）。
- **可移植的小东西**：错误注解（哪个参数、哪个 item、原始表达式文本）；`$now` 等「只读时间变量」如果做占位符，也应只暴露字符串/数字，不暴露对象。
- **求值顺序**：和鸣无需支持「参数里再嵌表达式」；若做占位符，一次遍历即可，不要递归求值（n8n 的递归是为了对象/数组嵌套）。

---

## 6. 执行记录：实体、数据、清理

### 6.1 解决什么问题

「刚才那次为什么失败」「昨天跑了几次」「三个月前的记录能不能清掉」。n8n 把记录拆成两层：**元数据行**（可查询、可清理）与**执行数据**（大对象、可分离存储）。

### 6.2 实现位置

| 内容 | 位置 |
| --- | --- |
| execution 实体 | `packages/@n8n/db/src/entities/execution-entity.ts:41-155` |
| execution 状态枚举 | `packages/workflow/src/execution-status.ts:1-14`（`canceled/crashed/error/new/running/success/unknown/waiting`） |
| 终态/可崩溃状态 | `packages/workflow/src/execution-status.ts:13-35` |
| 执行数据实体（与元数据分离） | `packages/@n8n/db/src/entities/execution-data.ts:9-39` |
| 单节点运行记录字段 | `packages/workflow/src/interfaces.ts:3709-3745`（`ITaskData`） |
| 结果数据形状 | `packages/workflow/src/run-execution-data/run-execution-data.v1.ts:47-59`（`resultData.error/runData/lastNodeExecuted/...`） |
| 写执行数据 + 大小统计 | `packages/cli/src/executions/execution-persistence.ts:859-877`、`:888-918` |
| 清理配置默认值 | `packages/@n8n/config/src/configs/executions.config.ts:101-180` |
| 软删除 SQL 语义 | `packages/@n8n/db/src/repositories/execution.repository.ts:757-803` |
| 硬删除批次 | `packages/@n8n/db/src/repositories/execution.repository.ts:806-832`；`packages/cli/src/services/pruning/executions-pruning.service.ts:33-68` |

### 6.3 关键代码行为

元数据行（节选）：

| 字段 | 含义 |
| --- | --- |
| `id` / `workflowId` | 主键、所属工作流 |
| `status` | 8 值状态机；`finished` 已废弃（`execution-entity.ts:46-52`） |
| `mode` | 触发方式（manual/trigger/webhook/integrated…） |
| `createdAt` / `startedAt` / `stoppedAt` | 创建、真正开始、结束（`startedAt` 为 null 表示排队中，`:69-77`） |
| `deletedAt` | 软删标记（`@DeleteDateColumn`，`:83-84`） |
| `retryOf` / `retrySuccessId` | 手动重试链（`:57-61`） |
| `waitTill` | 等待恢复时间（`:89-90`） |
| `storedAt` | 执行数据存哪：`db`/`fs`/`s3`/`az`（`:92-96`） |
| `jsonSizeBytes` / `binaryDataSizeBytes` | 体积，用于「不加载大对象也知道多大」（`:112-127`） |
| `deduplicationKey` | 唯一键，防调度重复投递（`:100-110`，唯一索引 `:36-40`） |
| `resumeAttempts` | 恢复尝试次数（`:129-131`） |

执行数据单独一张表 `ExecutionData`：`data`（序列化的 run data）+ `workflowData`（工作流快照）+ `workflowVersionId`（`execution-data.ts:9-39`），写入时三者一起原子写（`execution-persistence.ts:859-877`），并存字节数。

清理是两级（这是最值得抄的部分）：

```ts
// execution.repository.ts:769-802（节选）
const pruningCriteria = new Brackets((qb) => {
  qb.where({ stoppedAt: Raw((column) => `${column} <= 现在 - pruneDataMaxAge`) });
  if (pruneDataMaxCount > 0) {
    const countCutoff = ...orderBy('id','DESC').offset(pruneDataMaxCount).limit(1);
    qb.orWhere(`id <= (${countCutoff.getQuery()})`);
  }
});
// 只对终态软删：status NOT IN ('new','running','waiting')；有 annotation 的豁免
```

默认配置（`executions.config.ts:114-135`）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `EXECUTIONS_DATA_PRUNE` | `true` | 总开关 |
| `EXECUTIONS_DATA_MAX_AGE` | `336` 小时（14 天） | 超过才可软删 |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `10000` | 最多保留条数，`0` 不限 |
| `EXECUTIONS_DATA_HARD_DELETE_BUFFER` | `1` 小时 | 软删后至少留 1 小时才硬删 |
| 软删扫描间隔 | 60 分钟 | `PruningIntervalsConfig.softDelete`（`:8-16`） |
| 硬删扫描间隔 | 15 分钟 | 同上 |
| `EXECUTIONS_DATA_SAVE_ON_ERROR` | `all` | **失败执行默认保留** |
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | `all` | 成功也默认保留 |
| `EXECUTIONS_DATA_SAVE_ON_PROGRESS` | `false` | 每节点执行完就落盘（贵） |
| `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS` | `true` | 手动执行也存 |
| `EXECUTIONS_DATA_MAX_DISPLAY_SIZE` | 100 MB | 超过则列表接口不返回 run data（`:173-180`） |

硬删是分批的：每批 100 条、按 id 从新到旧、批间 sleep 1s、可被 AbortSignal 中断（`executions-pruning.service.ts:49-68`、`:101-107`）。

### 6.4 映射到和鸣：建议的记录形状

n8n 的字段太多，但「记录什么」的结论很清晰。给和鸣的 `AutomationRun`（独立键，独立于任务）：

| 和鸣字段 | 取自 n8n 的什么 | 说明 |
| --- | --- | --- |
| `id` | `execution.id` | 建议 `${taskId}:${plannedAt}`，天然去重 |
| `taskId` / `kind` | `workflowId` + 节点类型 | 任务改名后仍可追溯 |
| `trigger` | `mode` | `schedule` / `manual`（手动运行不重试、不通知，见 §10） |
| `plannedAt` | 调度任务的 `scheduledFor` | **必存**：区分「计划 09:00」与「实际 09:00:13 开跑」 |
| `startedAt` / `finishedAt` | `startedAt` / `stoppedAt` | 耗时 = 两者差 |
| `status` | 状态枚举的子集 | 建议 `success` / `error` / `canceled` / `skipped`（比 n8n 少，够用） |
| `attempts` | 无（n8n 不记） | 和鸣应记：1 表示一次成功，>1 表示重试过 |
| `errorCode` | `error.name` + `httpCode` | 供「可重试」判定与 UI 分类 |
| `detail` | `error.message` | 沿用 `MAX_DETAIL_CHARS=160` |
| `items?` | `runData[node].data` | 可选；只放摘要（来源、条数），**不放原始内容**（红线 R7） |
| `sizeBytes` | `jsonSizeBytes` | 写入前估算，超限先淘汰 |

### 6.5 移植取舍

- **保留**：两层结构（记录摘要 + 可选明细）；终态才可清理；maxAge + maxCount 双条件；软删 → 缓冲 → 硬删；失败默认保留；体积字段；批次清理 + 中断。
- **必须放大缩放**：10000 条 / 14 天是 DB 尺度，和鸣 localStorage 只有 ~5MB 且自动化现用 256KB（审计文档 §3.1）。建议 30–50 条 / 128–192KB，按 **UTF-8 字节**双淘汰（中文 1 字 3 字节，`MAX_DETAIL_CHARS=160` 的中文详情约 480 字节）。
- **丢掉**：TypeORM 实体与关系、`storedAt` 多后端、binary、annotation、`waitTill`/`resumeAttempts`、工作流快照（和鸣的动作定义已经在任务里，快照只会在任务被编辑后产生歧义）、`retryOf` 链、`deduplicationKey` 的数据库唯一索引（用记录 id + 读盘去重代替）。
- **改造**：n8n 的清理是后台定时任务（system task）；和鸣不能引入常驻服务，清理应当在「写入记录时顺手 prune」这个时机做（与 `pruneNotifications` / `pruneRuns` 的既有做法一致，见审计文档 §4-(c)）。
- **改造**：n8n 手动重试会新建一条 execution；和鸣不要，重试次数写进同一条记录（否则一次任务跑出 3 条记录，用户会以为重复执行）。

---

## 7. 调度与触发：cron、时区、错过、并发

### 7.1 解决什么问题

「到点就跑」看似简单，真正难的是：时区/DST、进程不在时错过的触发点怎么办、同一时刻多个任务、重复投递、长任务与下一次触发重叠。

### 7.2 实现位置（n8n 有两代，先说旧的一代）

**A. 进程内定时器 `ScheduledTaskManager`（trigger 节点用）**

| 内容 | 位置 |
| --- | --- |
| 类与注册 | `packages/core/src/execution-engine/scheduled-task-manager.ts:28`、`:67-148` |
| 时区 ctor | `scheduled-task-manager.ts:106`（`new CronTime(expression, timezone)`） |
| 规范化触发时刻（去重键的来源） | `:103-116`（`scheduledTime` 是「这一次为哪个时刻触发」） |
| 注册去重 / 集群选主 | `:70-81`（非 leader 不注册）、`:90-101`（同 key 重复注册告警） |
| 分组注销 | `:150-242` |
| 节点侧入口 | `packages/core/src/execution-engine/node-execution-context/utils/scheduling-helper-functions.ts:8-27`；`packages/nodes-base/nodes/Schedule/ScheduleTrigger.node.ts:560-580` |
| 时区来源 | `packages/workflow/src/workflow.ts:131`（`settings.timezone ?? 全局默认`）；`packages/workflow/src/global-state.ts:7`；`packages/@n8n/config/src/configs/generic.config.ts:8-12` |
| 生成 cron 时的随机秒（抖动） | `packages/workflow/src/cron.ts:52-72`（`randomInt(60)`）；持久化调度改用节点种子（`packages/cli/src/scheduling/seeded-cron.ts:10-40`） |

**B. 持久化调度 `@n8n/scheduler`（新路径）**

| 内容 | 位置 |
| --- | --- |
| ScheduledJob 字段 | `packages/@n8n/scheduler/src/core/types/schedule.ts:86-116` |
| 三种 recurrence 语义 | 同文件 `:18-68`（cron 走墙钟时区、interval 走绝对毫秒不受 DST 影响、one_off 固定时刻） |
| 生成触发时刻（窗口 + 上限） | `packages/@n8n/scheduler/src/core/materializer/plan.ts:51-94` |
| misfire 策略 | `packages/@n8n/scheduler/src/core/materializer/misfire.ts:29-61` |
| 策略枚举与默认宽限 | `packages/@n8n/constants/src/scheduler.ts:108-124`（`coalesce`/`coalesce_owner`/`skip`，默认 grace 60s） |
| 进程内 timer 漂移不补跑 | `packages/@n8n/scheduler/src/core/lifecycle/timeline.ts:35-36`（错过的时间槽直接跳过） |
| 触发 → 执行（去重） | `packages/cli/src/scheduling/schedule-trigger-node/schedule-trigger-task-handler.ts:73-147`；去重键格式 `schedule-trigger-task.ts:14-17` |
| 旧路径的去重键 | `packages/nodes-base/nodes/Schedule/ScheduleTrigger.node.ts:534-546`（`${workflowId}:${nodeId}:${scheduledTime.toISOString()}`） |
| 并发/队列模式 | `packages/@n8n/config/src/configs/executions.config.ts:96-100`（`regular`/`queue`）、`:19-31`（并发上限）、`:34-42`（队列恢复） |

### 7.3 关键代码行为

**misfire 是显式策略，不是「补跑」也不是「悄悄丢」：**

```ts
// misfire.ts:35-51（节选）
const graceDeadline = now.getTime() - job.misfireGraceSeconds * Time.seconds.toMilliseconds;
const behind = due.filter((occurrence) => occurrence.getTime() <= now.getTime());
if (behind.length === 0 || behind[0].getTime() > graceDeadline) return { occurrences: due, catchUpAt: null };
switch (job.misfirePolicy) {
  case Coalesce: { const catchUpAt = behind[behind.length - 1]; return { occurrences: [catchUpAt, ...ahead], catchUpAt }; }
  case Skip: return { occurrences: ahead, catchUpAt: null };
}
```

含义：只有「晚了超过 grace」才算错过；`coalesce` 保留**最近一次**错过的触发点补跑一次（其余丢弃），`skip` 全丢。注释明确写了「一旦错过就丢掉整个 backlog，否则会连续补跑」（`misfire.ts:14-23`）。

**触发时刻去重键**：每个 occurrence 一行 task（`plan.ts:11-16`），handler 用 `jobId:scheduledFor` 当 execution 的 `deduplicationKey`（`schedule-trigger-task-handler.ts:73`、`schedule-trigger-task.ts:14-17`），重复投递时靠数据库唯一索引拒绝，捕获 `DuplicateExecutionError` 后只记日志不再跑（`schedule-trigger-task-handler.ts:139-147`；唯一索引见 `execution-entity.ts:36-40`）。

**时区**：cron 表达式按 IANA 时区在墙钟上求值（`schedule.ts:18-29` 的注释明确「Wall-clock: fires at the given local time, so DST shifts the absolute instant」）；interval 则按绝对毫秒，DST 不影响（`:31-39`）。工作流设置里的 `'DEFAULT'` 是哨兵值，触发时要解析成实例时区（`schedule-trigger-task-handler.ts:74-84`）。

**「每 N 个周期」不是 cron 能表达的**：n8n 用「cron 候选 + 上一次触发时间过滤」实现（`schedule.ts:47-66`），并把上一次触发记在 workflow staticData，用本地时区的绝对分钟/小时/天序数比较（`packages/nodes-base/nodes/Schedule/GenericFunctions.ts:87-126`）——这是为了「每 3 周的周一和周三」但又不会因为跨小时导致多等一个周期。

**抖动**：自动生成的 cron 会随机秒（`cron.ts:52-72`），持久化版改成按节点 id 哈希出稳定的秒/分钟（`seeded-cron.ts:10-40`），避免整点所有节点一起打数据库，同时保持「重新激活后 cron 字符串不变」。

**并发与排队**：
- `EXECUTIONS_MODE=regular`（默认）：进程内 `ConcurrencyControlService` + `ConcurrencyQueue`，`N8N_CONCURRENCY_PRODUCTION_LIMIT` 默认 `-1` 不限（`executions.config.ts:19-31`、`concurrency-control.service.ts:66-100`、`concurrency-queue.ts:21-53`）。
- `EXECUTIONS_MODE=queue`：Bull + Redis + worker（`packages/cli/src/scaling/scaling.service.ts:106-121` 直接 `new BullQueue`），此时进程内并发队列关闭（`concurrency-control.service.ts:66-69`）。
- 队列模式下单节点也可以有并发上限（`ScheduledJob.concurrencyLimit`，`schedule.ts:108-112`），以及每个 occurrence 的 `maxAttempts` / `timeoutSeconds`（`:105-107`）。

### 7.4 移植到和鸣：保留 / 丢掉 / 改造

- **保留**：`nextRunAt` 作为一等字段（和鸣已有，`packages/web/src/lib/automation/model.ts:128-137`）；显式时区字段（新增 `timezone: string`，写 `Intl.DateTimeFormat().resolvedOptions().timeZone`，避免用户出差/改系统时区后计划漂移）；**触发时刻去重键**（`id = taskId:plannedAt`）。
- **保留（语义显式化）**：和鸣现在的行为其实已经等价于 n8n 的 `coalesce`：15s tick 找到 `nextRunAt <= now` 的任务跑一次，然后 `finishRun` 从「现在」重新排期（`packages/web/src/lib/automation/store.ts:188`），错过的那些时刻自然被折叠成一次。启动时 `rescheduleMissed` 直接顺延（`packages/web/src/lib/automation/store.ts:200-216`）等于 `skip`。**问题不是行为错，而是没写清**——建议在规格里命名这两种语义（运行期 coalesce、启动期 skip），并给任务加一个可选的 `misfire: 'coalesce' | 'skip'` 字段，默认与现状一致。
- **保留**：misfire grace 的概念（和鸣可用「tick 间隔」当隐式 grace，或显式 `graceSeconds`）。
- **丢掉**：cron 表达式解析（和鸣只有 daily + interval；引入 cron 库等于开放任意 cron 语法，收益低）、「每 N 周」recurrence、抖动（单用户串行，无需分摊）、持久化调度器的 materializer/窗口/owner/leader 选举、queue mode、Redis/Bull/worker、DB 行级锁与租约。
- **改造**：n8n 的 `scheduledTime` 是「计划时刻」而非「实际时刻」（`scheduled-task-manager.ts:103-116`）。和鸣必须把它落进运行记录（`plannedAt`），否则无法回答「这次是准点跑的，还是晚了 3 分钟补的」，也无法做去重。现在 `finishRun` 只写 `lastRunAt = now`（`packages/web/src/lib/automation/store.ts:183`），信息是不够的。
- **改造**：n8n 的召回依赖「进程活着 + 持久化 job 行」；和鸣是「进程活着 + localStorage」。sleep/休眠唤醒、页面双挂载（StrictMode 或两个窗口）都可能造成同刻双跑，去重键 + 内存 `runningId` 只能挡住后者，前者要靠「写入记录时以 `taskId:plannedAt` 去重」。

---

## 8. 超时与取消

### 8.1 解决什么问题

「跑飞了要能停」「超时要收尾并记录」「子任务不能活得比父任务久」。

### 8.2 实现位置

| 内容 | 位置 |
| --- | --- |
| 工作流超时配置 | `packages/@n8n/config/src/configs/executions.config.ts:101-112`（默认 `-1` 不限，上限 `maxTimeout=3600s`） |
| 工作流设置覆盖 | `packages/workflow/src/interfaces.ts:4193-4219`（`executionTimeout`） |
| 超时时间戳计算 | `packages/cli/src/workflow-runner.ts:605-614`、`:634-635` |
| 硬定时器 | `workflow-runner.ts:705-725`（到点 `stopExecution(new TimeoutExecutionCancelledError(...))`） |
| 软检查（每个节点边界） | `packages/core/src/execution-engine/workflow-execute.ts:2264-2282` |
| 取消接线 | `workflow-execute.ts:1667-1684`（`onCancel` → `status='canceled'`、任务状态置 canceled、`abortController.abort()`） |
| 取消后的状态回写 | `workflow-execute.ts:3251-3260`（所有 `running` 的 taskData 改 `canceled`） |
| 取消信号传递 | 节点上下文 `getExecutionCancelSignal()`；辅助函数 `packages/workflow/src/execution-cancellation.ts:6-25`（`throwIfExecutionCancelled`、`sleepUnlessExecutionCancelled`） |
| 停止执行 | `packages/cli/src/active-executions.ts:243-270`（`execution.workflowExecution?.cancel()`） |
| 取消原因类型 | `workflow-runner.ts:716`、`workflow-execute.ts:2840-2841`（手动/超时/关停） |
| 子工作流截止继承 | `packages/cli/src/workflow-execute-additional-data.ts:299-311`、`:731-737` |
| 节点级超时 | **不存在**；只有节点自己的参数（如 HTTP `timeout`，`routing-node.ts:240`）与调度任务的 `timeoutSeconds`（`schedule.ts:105-107`） |

### 8.3 关键代码行为

超时是「软」的：主循环每个节点开始前检查一次时间戳；超时只是把状态改成 canceled 并让循环退出，**不会打断正在跑的节点**。

```ts
// workflow-execute.ts:2275-2282
private shouldStopExecuting(): boolean {
  if (this.hasExecutionTimedOut()) { this.status = 'canceled'; this.timedOut = true; }
  return this.status === 'canceled';
}
```

真正的「停」依赖节点主动看 `AbortSignal`：取消回调里 `this.abortController.abort()`（`:1680`），节点通过 `getExecutionCancelSignal()` 拿到 signal，HTTP 请求与 `sleep` 都接受 signal（`execution-cancellation.ts:12-25`）。一个不理会 signal 的节点会一直跑到自己返回。

硬定时器只是为了在「节点卡死」时把执行标记结束并释放（`workflow-runner.ts:719-724` → `active-executions.ts:266` `workflowExecution.cancel()`），节点若正在 await 一个不可中断的 Promise，取消也只是让外层不再等它。

### 8.4 移植到和鸣：只做「看门狗 + 释放锁」，不要假装能中断

- **不可移植**：AbortSignal 贯穿整条链路依赖「执行体是自己进程内的 JS」。和鸣的动作最终是 `window.__heming_infohub` 的 IPC 调用（审计文档 §3.1/§7-5），主进程的桥调用（sync 30 分钟 / agenda 5 分钟 / 其它 60 秒）无法从渲染进程中断；`AbortSignal` 只能阻止「还没发出去的下一次调用」，不能取消已在跑的桥调用。
- **可移植**：把 `runningSince` 用起来（现在是死字段，审计文档 §3.3），加一个**运行看门狗**：`now - runningSince > runDeadline` 时把本次运行记为 `error`（`errorCode: 'timeout'`）、释放执行权、推失败通知。这不是「取消」，是「不再等它」；必须同时在 UI 上说明「底层任务可能仍在主进程继续」。
- **可移植（接口层面）**：动作执行器签名加 `ctx: { signal?: AbortSignal }`，`sleep` 与轮询型动作遵守它；未来的桥调用若支持 requestId 取消，可以无缝接上。
- **改造**：n8n 默认 `-1`（不限）是历史包袱（`executions.config.ts:104-105` 注释说以后会改）。和鸣反而应该有明确的默认值：`sync` 30 分钟、`agenda` 5 分钟与桥一致（审计文档 §1「桥调用形态」），不要抄「默认不限」。
- **注意**：n8n 的 timeout 与 cancel 是两条路径但共用状态 `canceled`；和鸣的状态建议分开（`timeout` 可映射为 `error` + `errorCode`），否则 UI 无法区分「用户取消」与「超时」。

---

## 9. 可移植 / 需改造 / 不可移植 判断表

| # | n8n 机制 | 判定 | 和鸣落法 / 理由 |
| --- | --- | --- | --- |
| 1 | 声明式节点描述（`INodeTypeDescription` + `INodeProperties`） | 可移植 | 动作注册表 = 描述 object + `run`；参数只保留 string/number/boolean/select 子集 |
| 2 | `displayOptions` 可见性规则 | 可移植 | 替代 `packages/web/src/components/AutomationPage.tsx:497` 的硬编码 `kind==="infohub.sync"` |
| 3 | 节点注册表 `NodeTypes` / `getByNameAndVersion` | 可移植（简化） | 静态 `Map<kind, descriptor>`；丢掉懒加载、版本类、文件扫描 |
| 4 | 节点级重试参数 `retryOnFail/maxTries/waitBetweenTries` | 可移植 | 数值边界照抄（2–5 / 0–5000ms / 默认 3 / 1000ms），但用 `??` 不用 `\|\|` |
| 5 | 「只重跑节点、中间尝试不记录」 | 需改造 | 和鸣应在运行记录里写 `attempts` 与每次失败码，让重试可见 |
| 6 | `onError` 三态（stop/continueRegular/continueError） | 可移植（收敛） | 映射为「本步失败后继续/停止」；错误透传输入对和鸣无意义，改为 error 步骤记录 |
| 7 | `continueErrorOutput` 错误输出连接 | 不可移植 | 单步任务没有下游分支，用状态 + 记录表达 |
| 8 | items 数组 | 可移植（简化） | `AutomationResult.items` 承载「每来源一条 report」，别压成一句摘要 |
| 9 | `pairedItem` 血缘 | 需改造 | 只保留 `runId` 级别的父子关系；不实现逐 item 追溯 |
| 10 | `executeOnce` / `alwaysOutputData` / null-vs-空数组 | 需改造 | 单动作无图，定义清楚「空结果」一种语义即可 |
| 11 | 表达式（Tournament / `new Function` / Code 节点） | 不可移植 | 违反「无任意脚本执行」；Electron CSP 也不允许 eval |
| 12 | native-evaluation 闭集解释器 | 需改造（设计可借鉴） | 需要 parser 依赖，成本 L；本轮不做，将来只做占位符词表 |
| 13 | execution 状态机（8 值）+ 时间戳字段 | 可移植 | 裁成 `success/error/canceled/skipped` + `plannedAt/startedAt/finishedAt` |
| 14 | execution 与 execution_data 分离、工作流快照 | 需改造 | 动作定义已在任务里，不存快照；只存结果摘要，明细可选 |
| 15 | maxAge + maxCount 软删，buffer 后硬删，失败保留 | 可移植（缩放） | 30–50 条 / 128–192KB，按字节 + 条数双淘汰，写入时顺手 prune |
| 16 | 执行数据分批硬删、可中断 | 不可移植 | localStorage 只有同步批量删除；直接全量重写键即可 |
| 17 | `nextRunAt` 一等字段 | 已具备 | 和鸣已有（`packages/web/src/lib/automation/model.ts:128-137`），补 `plannedAt` 与显式 `timezone` |
| 18 | misfire（grace + coalesce/skip） | 可移植（语义） | 现状=运行期 coalesce / 启动期 skip，需写进规格并可选配置 |
| 19 | 触发时刻去重键 `jobId:scheduledFor` + 唯一索引 | 可移植（换实现） | 记录 `id = taskId:plannedAt`，写入前同 id 去重 |
| 20 | cron 表达式 + IANA 时区 + 随机秒抖动 | 需改造 | 只保留 daily/interval + 本地时区字段；不引入 cron 语法 |
| 21 | 持久化调度器（materializer/窗口/租约/leader） | 不可移植 | 需要常驻服务 + DB，违反「不引入常驻后台服务」 |
| 22 | queue mode / Redis / Bull / worker / 并发上限 | 不可移植 | 红线；和鸣单槽并发（=1）已足够，且更好解释 |
| 23 | 工作流级软超时 + 硬定时 cancel | 需改造 | 只能做看门狗：标记失败、释放锁、通知；不能真正中断 IPC |
| 24 | AbortSignal 贯穿执行链 | 需改造 | 接口留 `signal`，动作内部自己决定是否遵守；桥调用无法取消 |
| 25 | 子工作流 + 截止时间 min 继承 + callerPolicy | 不可移植（本轮） | 若要组合，用显式动作序列；动态引用任意任务会掏空白名单边界 |
| 26 | 手动重试整条执行（`retryOf`） | 不可移植 | 和鸣用「下一次计划」+ 记录内 `attempts` 表达 |

---

## 10. 候选改进清单（8 条）

排序按「价值 / 成本 / 红线风险」。红线定义引用审计文档 §2（R1–R13），此处不再复述原文。

| # | 改进 | 价值 | 成本 | 红线兼容 | 风险 |
| --- | --- | --- | --- | --- | --- |
| 1 | 运行记录（独立键、双淘汰、级联删、含 `attempts`/`errorCode`/`plannedAt`） | 高：用户第一次能回答「刚才那次为什么失败」；也是通知/重试/看门狗的地基 | M | 兼容：只写本机 localStorage，不记正文（R5/R7），不碰桥 | 配额与孤儿记录（删除任务必须级联）；`detail` 中文按字节膨胀；测试需注入独立存储 |
| 2 | 失败通知（在 `finishRun` 单点收口，key 带本次运行标识） | 高：把「失败没人知道」补上 | S | 兼容：应用内通知，不上云（R5/R8） | 去重 key 写死会「第二次失败静默」；`skipped` 不能推（未连接时会刷屏） |
| 3 | 动作注册表（`kinds.ts` 纯数据 + `actions.ts` 含执行器；参数声明驱动 UI 与校验） | 中高：以后加动作不用改 6 处硬编码 | M | 兼容：动作仍是白名单字面量，参数仍是枚举/布尔（R1） | 注册表循环依赖（`kinds` 不能 import `runner`）；`sync` 字段对所有动作是否必填；改文案会打红现有断言 |
| 4 | 错误归一与「可重试」分类（`errorCode` + `retryable`） | 中：重试、通知、UI 配色都依赖它 | S | 兼容：纯本地判定，不新增外部依赖 | 误判会把确定性失败重试成 3 倍耗时；必须只对「明显瞬时」的错误为真 |
| 5 | 每任务重试策略（默认 0，显式开启，独立 `retryAt`，不写 `nextRunAt`） | 中：偶发失败自愈 | M | **需先改口径**：与 R2 / `HANDOFF:250`「没有失败自动重试」直接冲突；技术上不违红线 | 破坏「不补跑」（`rescheduleMissed` 必须清 `retryAt`）；`runCount` 是否含重试；手动运行是否重试；等待期占用全局锁 |
| 6 | misfire 语义显式化 + 触发去重键（`plannedAt`、grace、可选 `misfire` 字段） | 中：消除「准点还是补跑」「会不会双跑」的含糊 | S | 兼容：不改变默认行为 | 语义写错会在规格层制造新承诺；UI 需要一句解释文案 |
| 7 | 运行看门狗（`runningSince` 超时 → 记 `error/timeout`、释放锁、推通知） | 中：解决「卡住后永远转圈」 | M | 兼容：不 spawn、不重试、不引入服务（R4） | 桥调用无法真取消，底层可能仍在跑；误杀长 `sync`（30 分钟）会留下「记录失败但主进程成功」的不一致 |
| 8 | 受限占位符（非表达式；固定词表 + 手写 tokenizer） | 低（现有参数无需动态化） | L | 兼容：闭集、无 eval，符合「无任意脚本」；但很容易滑向「表达式语言」 | 一旦支持函数调用/属性访问就变成脚本引擎；维护成本高。**建议本轮不做** |

**本轮最适合落地的一条：第 1 条（运行记录），并把第 2 条挂在同一个 `finishRun` 收口点上一起做。**

理由：① 它是唯一「只用新增、不改现有语义」的改动，现有 48 例测试中只有 `packages/web/src/lib/automation/store.test.ts:138-164` 需要注入新存储（审计文档 §4-(c) 已列影响面）；② 它同时解决三个现存空洞——失败不可见（通知）、历史不可查（记录）、以后加动作要改多处（记录字段可扩展）；③ 它不触碰任何红线，也不与 `HANDOFF:250` 的「不做重试/不做取消」冲突；④ 重试（第 5 条）必须先把口径文档改了才能做，适合单独一轮。

**不建议本轮做**：第 5（口径冲突）、第 7（需要论证桥层一致性）、第 8（收益与成本倒挂）。第 3、4、6 可作为同轮的低风险伴随项（注册表是纯重构、错误分类可为通知文案服务、misfire 只需写规格 + 一个字段）。

---

## 11. 明确不要照搬的 n8n 机制

| # | 机制 | 为什么不要 |
| --- | --- | --- |
| 1 | queue mode + Redis + Bull + worker + 多主 leader 选举（`packages/cli/src/scaling/`、`packages/@n8n/scheduler/` 的租约/选主） | 需要常驻后台服务与 Redis，直接违反「不引入常驻后台服务」「不上云」「只本机」。桌面单用户不需要分布式并发，全局单槽（并发=1）就是正确解 |
| 2 | 任意 JS：Code 节点、`new Function` 表达式、vm/quickjs isolate | 违反「无任意脚本执行」。即使沙箱化，桌面端要为此放宽 CSP/引入 native 模块，风险远大于收益 |
| 3 | 凭据系统（credentials、dynamic credentials、OAuth、`extendsCredential`、凭据解密） | 违反「任务不含凭据」。和鸣动作是白名单本机操作，参数里不应出现任何密钥；一旦引入凭据槽，就把「任务配置」变成「可被社工/文件篡改的凭证容器」 |
| 4 | DB 执行数据（TypeORM 实体、`execution_data` 行、`storedAt` 多后端、binary 存储 fs/s3/az） | 违反「数据只落 localStorage」「无 DB」。且 10000 条 / 100MB 是服务端尺度，localStorage 装不下也不需要 |
| 5 | `saveExecutionProgress` 逐节点落盘、`resumeAttempts`/`waitTill` 恢复 | 依赖 DB 事务与重放；和鸣的「运行记录」是事后日志，不是可恢复的执行状态机。不要把「记录」误做成「快照」 |
| 6 | Webhook / HTTP server 触发、Wait 节点、表单/聊天等待恢复 | 需要监听端口与外部回调，违反「不上云、无常驻服务」。和鸣的触发只有「本机时间」 |
| 7 | 轮询触发器（poll trigger）/ poll cursor（`packages/core/src/execution-engine/poll-trigger-executor.ts`） | 需要长期存游标并周期抓取外部系统；和鸣的「同步」就是一次性动作，没有增量游标语义 |
| 8 | 子工作流引擎（`executeWorkflow` + `callerPolicy` + 动态加载任意工作流） | 允许任务 A 调用任务 B，等于允许「数据驱动的动态任务拼接」，白名单会失效；且需要 DB 存执行树与跨执行权限 |
| 9 | 节点加载器（文件扫描、`loadClassInIsolation`、社区节点包、`NODES_INCLUDE/EXCLUDE`） | 动态 import 任意文件 = 任意代码执行入口；和鸣的动作必须在编译期静态注册 |
| 10 | AI agent/tool 节点、HITL 等待、`rewireOutputLogTo`、`EngineRequest` | 和鸣已有自己的 HITL 与智能体体系，两套状态机会互相污染；这些机制也依赖 DB 持久化暂停/恢复 |
| 11 | `continueErrorOutput` 错误输出连接、多输出路由、`alwaysOutputData` | 都是「图」的语义；单步任务没有下游分支，照搬会造出无法解释的配置项 |
| 12 | 手动重试整条执行（`retryOf`/`retrySuccessId` 新建执行） | 会让一次失败在记录里变成多条执行，用户会误以为重复跑；和鸣用记录内 `attempts` 表达 |
| 13 | n8n 源码本身（Sustainable Use License） | 商业分发受限（`LICENSE.md:19-24`）；只按语义重写，不要把 n8n 代码/片段复制进仓库 |

---

## 12. 附录：调研可复现信息

### 12.1 克隆与 sparse 配置

```bash
cd /d/Heming
git clone --depth 1 --filter=blob:none --sparse https://github.com/n8n-io/n8n.git .tmp/n8n
git -C .tmp/n8n sparse-checkout set \
  packages/workflow packages/core packages/cli/src \
  packages/@n8n/db packages/@n8n/scheduler packages/@n8n/tournament \
  packages/@n8n/expression-runtime packages/@n8n/config \
  packages/nodes-base/nodes/Schedule packages/@n8n/engine
git -C .tmp/n8n sparse-checkout add packages/@n8n/constants
git -C .tmp/n8n log -1 --format='%H %ci'   # bb832f1... 2026-11-03 06:33:41 +0000
```

注意：`sparse-checkout set` 只接受目录，`packages/cli/package.json` 这种文件路径会报 `fatal: ... is not a directory`，需用 `--skip-checks` 或干脆不列。

### 12.2 本文引用到的源码文件（按目录）

| 目录 | 主要用途 |
| --- | --- |
| `packages/core/src/execution-engine/workflow-execute.ts` | 执行栈、runNode/executeNode、重试、错误传播、超时检查、配对、错误输出切分 |
| `packages/core/src/execution-engine/routing-node.ts`、`node-execution-context/*` | 每 item 执行、参数解析、取消信号、错误注解 |
| `packages/core/src/execution-engine/scheduled-task-manager.ts` | 进程内 cron 调度 |
| `packages/core/src/nodes-loader/directory-loader.ts` | 节点注册/懒加载 |
| `packages/workflow/src/interfaces.ts` | INode/INodeProperties/INodeExecutionData/ITaskData/IWorkflowSettings 等全部数据契约 |
| `packages/workflow/src/workflow-expression.ts`、`expression.ts`、`expression-evaluator-proxy.ts`、`expression-sandboxing.ts`、`workflow-data-proxy.ts` | 表达式入口、内置变量、sandbox、Tournament 接线 |
| `packages/workflow/src/expressions/native-evaluation/*` | 无代码生成的闭集解释器（含预算） |
| `packages/workflow/src/node-helpers.ts` | displayOptions/依赖排序/参数解析/版本化节点 |
| `packages/workflow/src/cron.ts`、`execution-cancellation.ts`、`execution-status.ts`、`run-execution-data/*` | cron 生成、取消辅助、状态枚举、run data 形状 |
| `packages/@n8n/tournament/src/*` | AST 改写 + `new Function` 求值（本文的反面教材） |
| `packages/@n8n/scheduler/src/core/*` | 持久化调度：recurrence、misfire、materializer、timeline |
| `packages/@n8n/constants/src/scheduler.ts` | misfire 策略枚举、默认 grace |
| `packages/@n8n/db/src/entities/*`、`repositories/execution.repository.ts` | execution/execution_data 实体与清理 SQL |
| `packages/@n8n/config/src/configs/executions.config.ts`、`generic.config.ts` | 执行/清理/并发/时区默认值 |
| `packages/cli/src/workflow-runner.ts`、`active-executions.ts`、`workflow-execute-additional-data.ts` | 工作流超时、取消、子工作流 |
| `packages/cli/src/services/pruning/*` | 软删/硬删任务 |
| `packages/cli/src/scheduling/*` | 持久化调度接线、去重键、seeded cron |
| `packages/cli/src/node-types.ts` | 节点注册表实现 |
| `packages/nodes-base/nodes/Schedule/*` | Schedule Trigger 节点：时区、cron 生成、去重、recurrence |

### 12.3 未覆盖 / 未深入

- `packages/nodes-base` 的绝大多数节点实现（只读了 Schedule 与部分 GenericFunctions）。
- v2 引擎 `packages/@n8n/engine/` 只读了类型与少量注释，未追 step 生命周期；其「step 行 + 可重试分类」方向与本文结论一致，但细节不影响本文判断。
- queue mode 的 Bull 实现、worker 池、webhook relay、任务运行器（task runner）未深入。
- 前端（`packages/frontend`）的参数渲染/表达式编辑器未读；本文关于 UI 的结论只来自数据契约与既有和鸣实现。

### 12.4 与和鸣现状的对照（只列需要改的点）

| 和鸣现状 | 对应 n8n 语义 | 本文建议 |
| --- | --- | --- |
| `AutomationKind` 两字面量 + `packages/web/src/lib/automation/runner.ts:87-89` if/else | 节点类型 + 注册表 | 第 10 节第 3 条：注册表描述驱动 |
| `lastStatus/lastDetail/runCount` 单槽 | `ITaskData` 数组 + execution 行 | 第 10 节第 1 条：独立运行记录 |
| `finishRun` 无条件顺延 | `nextRunAt` + misfire | 第 10 节第 6 条：`plannedAt` + 语义显式化 |
| 只有 `runningId`，无时间上限 | 工作流超时（软）/看门狗 | 第 10 节第 7 条：用起 `runningSince` |
| 无重试（红线明确不做） | 节点级重试 | 第 10 节第 5 条：先改口径，再默认关闭地加字段 |
| 无失败通知 | 错误上报 + 错误工作流 | 第 10 节第 2 条：应用内通知，单点收口 |
| `localStorage` 256KB / 20 条任务 | maxAge + maxCount + 硬删 | 运行记录用独立键 + 字节/条数双淘汰 |

---

*本文为只读调研；未修改仓库任何源码，未运行构建/测试，未提交 clone 内容。*
