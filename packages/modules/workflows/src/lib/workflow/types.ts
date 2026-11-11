/**
 * 工作流模块（内置模块 `workflows`）的领域类型：**唯一事实来源**。
 *
 * 设计语义参考 n8n 的公开文档（<> 表达式、items 数据流、节点级重试、错误输出、
 * 子流程、执行记录与执行数据分离等），但**没有使用 n8n 的任何源代码**——
 * n8n 自 2022-03-17 起采用 Sustainable Use License 1.0，不是 OSI 开源许可，
 * 不允许把它的代码复制进本仓或以本仓发行物分发。详见
 * `docs/superpowers/specs/2026-11-07-workflow-module.md` 的「来源与许可」一节。
 *
 * 这份文件只放**类型与极小纯函数**，不放执行逻辑：
 * - 执行引擎在 `engine/`；
 * - 表达式求值在 `expressions/`；
 * - 节点实现在 `nodes/`；
 * - 画布在 `components/workflow/`；
 * - 持久化在 `store.ts`。
 *
 * 改这里的类型等于改全模块的契约：先改契约、再改实现，不要反过来。
 */

// ---------------------------------------------------------------------------
// 数据单元（items）
// ---------------------------------------------------------------------------

/**
 * 二进制数据引用。在浏览器里我们**不存 Blob**：执行记录要能写进 localStorage，
 * 所以统一用 base64 文本（`data` 不含 `data:` 前缀）。
 * 单条二进制超过 `MAX_BINARY_BYTES` 时执行引擎会丢掉内容并留下说明，
 * 而不是让整次执行记录写不进磁盘。
 */
export interface BinaryData {
  /** base64（不含 `data:` 前缀）。 */
  data: string;
  /** MIME，例如 `image/png`、`application/json`。 */
  mimeType: string;
  fileName?: string;
  fileSize?: number;
}

/**
 * 数据单元：工作流里流动的最小单位（对应 n8n 的 `INodeExecutionData`）。
 *
 * - `json` 是唯一必填字段：节点之间传的是普通 JSON，便于预览、导出与表达式访问；
 * - `binary` 刻意做成可选的第二通道，避免把大对象塞进 `json` 导致执行记录爆掉；
 * - `pairedItem` 保留「这一项从上游哪一项来」的血缘，错误输出切分与调试要靠它。
 */
export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, BinaryData>;
  pairedItem?: number | { item: number; output?: number };
}

/** 一组 items。 */
export type ItemList = Item[];

/**
 * 节点输入：`main[inputIndex]` 是该输入口收到的全部 items。
 * 只有一个输入口的节点通常只读 `main[0]`；Merge 这类双输入节点会读 `main[1]`。
 */
export interface NodeInputData {
  main: Item[][];
}

/** 节点执行产物：`main[outputIndex]` 是该输出口产出的全部 items。 */
export interface NodeOutputData {
  main: Item[][];
}

// ---------------------------------------------------------------------------
// 节点类型描述（声明式）
// ---------------------------------------------------------------------------

/** 节点分组：决定画布调色板的分栏与颜色。 */
export type NodeGroup = "trigger" | "action" | "transform" | "flow" | "ai" | "output";

/** 触发方式。非触发节点没有 `trigger`。 */
export type TriggerKind = "manual" | "schedule" | "error" | "subworkflow" | "webhook";

/** 参数控件的类型（够用就好，不做通用表单引擎）。 */
export type NodePropertyType =
  | "string"
  | "multiline"
  | "number"
  | "boolean"
  | "options"
  | "multiOptions"
  | "json"
  | "code"
  | "dateTime"
  | "notice";

export interface NodePropertyOption {
  name: string;
  value: string | number | boolean;
  description?: string;
}

/** 参数可见性条件：`show[参数名]` 命中枚举值时显示（n8n displayOptions 的简化）。 */
export interface NodePropertyDisplayOptions {
  show?: Record<string, Array<string | number | boolean>>;
}

/** 一条节点参数描述：UI 按它渲染表单，默认值也由它决定。 */
export interface NodePropertyDescription {
  name: string;
  displayName: string;
  type: NodePropertyType;
  /** 新建节点时写进 parameters 的默认值。 */
  default?: unknown;
  description?: string;
  placeholder?: string;
  options?: NodePropertyOption[];
  required?: boolean;
  rows?: number;
  /** 该字段默认按表达式处理（字符串/多行/JSON/代码都支持 `{{ }}`）。 */
  expression?: boolean;
  displayOptions?: NodePropertyDisplayOptions;
}

/** 节点类型描述：声明式数据，UI、默认值、校验、调色板全部由它驱动。 */
export interface NodeTypeDescription {
  /** 稳定类型 id（英文，小驼峰，例如 `httpRequest`）。持久化后不可改。 */
  type: string;
  /** 显示名（中文，例如「HTTP 请求」）。 */
  displayName: string;
  group: NodeGroup;
  /** 一句话说明「这个节点做什么」，调色板与详情面板共用。 */
  description: string;
  /** 图标 key（`components/workflow/nodeIcons.tsx` 里映射；未知走兜底图标）。 */
  icon: string;
  /** 强调色（可选，形如 `#3b82f6`；缺省由分组决定）。 */
  color?: string;
  /** 输入口数量（触发器为 0）。 */
  inputs: number;
  /** 输出口数量；动态输出（Switch）用 `getOutputCount` 计算。 */
  outputs: number;
  /** 输出口名字（缺省「输出」/「输出 1」……）。 */
  outputNames?: string[];
  properties: NodePropertyDescription[];
  /** 是否触发器节点。 */
  isTrigger?: boolean;
  /** 触发方式（仅触发器节点）。 */
  trigger?: TriggerKind;
  /** 新建节点的默认名字；缺省用 displayName。 */
  defaultName?: string;
  /** 描述版本，预留给未来的参数迁移。 */
  version: number;
}

// ---------------------------------------------------------------------------
// 节点执行上下文与执行器
// ---------------------------------------------------------------------------

/** 执行模式（与 n8n 的 execution mode 对齐，但只保留本仓用得到的几种）。 */
export type ExecutionMode = "manual" | "trigger" | "retry" | "subworkflow" | "error" | "partial";

/** 单次执行的终态。`waiting` 预留给跨重启的等待（v1 不做持久化等待）。 */
export type ExecutionStatus = "new" | "running" | "success" | "error" | "canceled" | "waiting";

/** 节点失败后怎么办（n8n `onError` 的三种取值）。 */
export type OnErrorMode = "stopWorkflow" | "continueRegularOutput" | "continueErrorOutput";

/** 一次节点运行的记录（执行数据）。 */
export interface NodeRunData {
  /** 开始时间（epoch ms）。 */
  startTime: number;
  /** 耗时（ms）。 */
  executionTime: number;
  /** 本次执行内的第几次节点执行（0 起；循环里会递增）。 */
  executionIndex: number;
  /** 数据来源：上游节点 id（触发节点为空）。 */
  source: Array<{ previousNode?: string }>;
  status: "success" | "error" | "waiting";
  /** 输出数据；`saveData*` 关掉时为 undefined。 */
  data?: NodeOutputData;
  error?: NodeErrorInfo;
  /** 该次运行的输出条数（所有输出口之和），列表页排序/展示用。 */
  itemsTotal: number;
}

/** 结构化错误：执行记录与 UI 都读这个形状。 */
export interface NodeErrorInfo {
  message: string;
  /** 补充说明（例如「检查凭据是否过期」）。 */
  description?: string;
  nodeId?: string;
  nodeName?: string;
  nodeType?: string;
  /** HTTP 状态码（HTTP 节点用字符串，与 n8n 一致）。 */
  httpCode?: string;
  stack?: string;
  /** 出错的是第几项（错误输出模式下按 item 分流时用）。 */
  itemIndex?: number;
}

/** 执行记录（与执行数据分离；数据只在本机，撑不下时按条数/字节淘汰）。 */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  /** 工作流名快照：工作流改名/删除后历史记录仍能读懂。 */
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** 本次由哪个节点触发（节点 id）。 */
  triggerNodeId?: string;
  /** 触发器收到的数据（手动/Webhook/子流程调用）。 */
  triggerData?: Item[];
  /** 节点 id → 该节点每次运行的记录。 */
  runData: Record<string, NodeRunData[]>;
  error?: NodeErrorInfo;
  /** 子流程执行时指向父执行。 */
  parentExecutionId?: string;
}

/** 节点日志器：只写本机控制台/调试面板，不落盘、不上云。 */
export interface NodeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** HTTP 请求选项（HTTP 节点与桌面桥共用一份形状）。 */
export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** 查询参数（值会做 URL 编码）。 */
  query?: Record<string, string>;
  body?: unknown;
  bodyType?: "json" | "text" | "form" | "none";
  timeoutMs?: number;
  /** 不跟随重定向（缺省跟随，最多 5 跳）。 */
  followRedirects?: boolean;
  /** 期望响应格式；json 解析失败时回退 text。 */
  responseType?: "json" | "text" | "base64";
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  /** 解析后的响应体（json 时可读对象；text/base64 时是字符串）。 */
  body: unknown;
  /** 原始文本（响应体过大或二进制时可能为空）。 */
  rawBody?: string;
  /** 原始字节数（拿不到时为 undefined）。 */
  size?: number;
}

/** 凭据解析器：节点按类型 + id 取凭据数据；拿不到返回 null（节点自己报可读的错）。 */
export type CredentialResolver = (
  type: string,
  id: string,
) => Promise<Record<string, unknown> | null>;

/** 子流程执行参数（执行子流程节点 → 宿主的回调）。 */
export interface SubWorkflowParams {
  workflowId: string;
  mode: ExecutionMode;
  /** 父执行 id（子执行记录里带上，便于从历史追到父子关系）。 */
  parentExecutionId: string;
  /** 传给子流程触发节点的 items。 */
  inputData: Item[];
  /** 父执行的取消信号：父执行被停止时子执行也应停下（runtime 负责传递）。 */
  abortSignal?: AbortSignal;
}

export interface SubWorkflowResult {
  execution: WorkflowExecution;
  /** 子流程运行结束时的输出 items（取触发链末端的输出）。 */
  output: Item[];
}

/** 节点可用的执行辅助能力。 */
export interface NodeHelpers {
  /**
   * 发一次 HTTP 请求。
   *
   * 为什么必须是注入而不是节点自己 `fetch`：浏览器里跨域读响应受 CORS 限制，
   * 桌面端由主进程桥接（无 CORS、可用系统代理）。节点只依赖这个抽象，
   * 换实现不影响节点代码。
   */
  httpRequest(options: HttpRequestOptions): Promise<HttpResponse>;
  /** 等待若干毫秒；`signal` 中止时抛错（Wait 节点与重试共用）。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * 跑用户代码（代码节点用）。由调用方注入沙箱实现；缺省时报可读错误，
   * 而不是偷偷用 eval——没有沙箱就不该执行第三方代码。
   */
  runUserCode?: UserCodeRunner;
  /**
   * 执行另一条工作流（执行子流程节点用）。由调用方注入：只有它能拿到工作流仓库、
   * 执行记录与递归深度控制，节点自己不该知道这些。
   */
  executeSubWorkflow?: (params: SubWorkflowParams) => Promise<SubWorkflowResult>;
}

/** 节点执行上下文：节点实现能看到的全部能力都在这里。 */
export interface NodeExecutionContext {
  node: WorkflowNode;
  workflow: Workflow;
  /** 第几次运行（0 起；同一节点在循环里会多次运行）。 */
  runIndex: number;
  /** 已解析表达式后的参数快照。 */
  parameters: Record<string, unknown>;
  inputData: NodeInputData;
  mode: ExecutionMode;
  executionId: string;
  /** 取参数（已解析）；缺省时返回 `fallback`。 */
  getNodeParameter<T>(name: string, fallback: T): T;
  /** 取某个输入口的全部 items。 */
  getInputData(inputIndex?: number): Item[];
  /** 取上游节点最近一次运行的输出（错误输出切分、Merge 用）。 */
  getNodeOutputData(nodeId: string, outputIndex?: number): Item[][];
  /** 工作流级静态数据（跨运行保留，例如游标/去重键）。 */
  getWorkflowStaticData(kind?: "global" | "node"): Record<string, unknown>;
  /** 按凭据类型取凭据；没有配置时返回 null。 */
  getCredential(type: string): Promise<Record<string, unknown> | null>;
  helpers: NodeHelpers;
  abortSignal: AbortSignal;
  logger: NodeLogger;
  /** 节点主动报告进度（长任务用；不进执行记录）。 */
  emitProgress?(message: string): void;
}

/** 节点执行函数可以返回的三种形状（统一收敛成 NodeOutputData）。 */
export type NodeExecuteResult = NodeOutputData | Item[][] | Item[] | undefined;

/** 一个节点类型：描述 + 执行函数。 */
export interface INodeType {
  description: NodeTypeDescription;
  execute(context: NodeExecutionContext): Promise<NodeExecuteResult>;
  /**
   * 触发节点专用：根据参数算出「下一次该在什么时候跑」。
   * 只有 `trigger === "schedule"` 的节点需要实现；返回 null 表示不可计算。
   */
  getNextRun?(parameters: Record<string, unknown>, from: Date): Date | null;
  /** 动态输出口数量（Switch 用）；缺省用 `description.outputs`。 */
  getOutputCount?(parameters: Record<string, unknown>): number;
}

// ---------------------------------------------------------------------------
// 工作流模型
// ---------------------------------------------------------------------------

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

/** 画布上的一个节点。 */
export interface WorkflowNode {
  /** 稳定 id（`wf-node-...`），连接与执行数据都按 id 索引。 */
  id: string;
  /** 显示名（工作流内唯一；表达式 `$node["名字"]` 按它索引）。 */
  name: string;
  /** 节点类型 id（`NodeTypeDescription.type`）。 */
  type: string;
  position: WorkflowNodePosition;
  parameters: Record<string, unknown>;
  disabled?: boolean;
  /** 节点备注（画布上可展开）。 */
  notes?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: OnErrorMode;
  /** 即使没有输出也把下游节点入栈（调试用）。 */
  alwaysOutputData?: boolean;
  /** 只运行一次（把全部输入 items 一次交给节点）。 */
  executeOnce?: boolean;
  /** 凭据类型 → 凭据 id。 */
  credentials?: Record<string, string>;
  /** 固定的输出数据（调试/部分执行用）；有值时引擎不执行本节点。 */
  pinData?: Item[];
}

/** 一条连接：从 `sourceNodeId` 的 `outputIndex` 到 `targetNodeId` 的 `inputIndex`。 */
export interface WorkflowConnection {
  node: string;
  type: "main";
  index: number;
}

/**
 * 连接表：`connections[sourceNodeId].main[outputIndex]` = 该输出口连到的目标列表。
 * 用**节点 id** 而不是名字做键，重命名节点不会丢连接。
 */
export type WorkflowConnections = Record<string, { main: WorkflowConnection[][] }>;

export interface WorkflowSettings {
  /** 固定本地时区（窗口侧不做时区换算；与自动化模块同口径）。 */
  timezone: "local";
  /** 成功执行是否保存节点数据。 */
  saveDataSuccessExecution: "all" | "none";
  /** 失败执行是否保存节点数据。 */
  saveDataErrorExecution: "all" | "none";
  /** 手动执行是否进历史。 */
  saveManualExecutions: boolean;
  /** 失败时交给哪个「错误触发」工作流处理。 */
  errorWorkflowId?: string;
  /** 允许其它工作流调用本工作流（`none` 只能在本工作流内手动跑）。 */
  callerPolicy: "any" | "none";
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  nodes: WorkflowNode[];
  connections: WorkflowConnections;
  settings: WorkflowSettings;
  /** 是否启用（定时触发只跑启用的工作流）。 */
  active: boolean;
  /** 每次保存生成新版本 id（执行记录可标记「跑的是哪一版」）。 */
  versionId: string;
  createdAt: number;
  updatedAt: number;
  /** 上次被触发的时间（调度判断「错过不补跑」用）。 */
  lastRunAt?: number;
  /** 定时任务的最多执行次数（0/undefined = 不限）。 */
  maxRuns?: number;
  /** 已执行次数（定时触发计数）。 */
  runCount?: number;
}

/** 持久化上限与常用尺寸常量（集中一处，测试与 UI 共用）。 */
export const WORKFLOW_LIMITS = {
  /** 最多保存多少条工作流。 */
  maxWorkflows: 50,
  /** 单条工作流 JSON 上限（字节）。 */
  maxWorkflowBytes: 512 * 1024,
  /** 执行记录最多保留多少条。 */
  maxExecutions: 60,
  /** 执行记录总字节上限。 */
  maxExecutionsBytes: 1024 * 1024,
  /** 单条执行记录里单个节点的输出最多保留多少条 items。 */
  maxItemsPerNodeRun: 200,
  /** 单条 item 的 JSON 预览上限（字节）；超出截断并在 UI 标注。 */
  maxItemPreviewBytes: 64 * 1024,
  /** 单条执行里二进制数据上限（字节）；超出整条执行不保存二进制。 */
  maxBinaryBytes: 2 * 1024 * 1024,
  /** 一次执行最多允许的节点运行次数（防死循环）。 */
  maxNodeRuns: 500,
  /** 单次执行最长时长（ms）。 */
  maxExecutionMs: 10 * 60 * 1000,
  /** 节点级重试次数的硬边界。 */
  minTries: 1,
  maxTries: 5,
  /** 节点级重试间隔的硬边界（ms）。 */
  maxWaitBetweenTries: 5000,
} as const;

/** 节点默认重试参数（n8n 同口径：默认 3 次 / 1000ms，夹在 2–5 与 0–5000）。 */
export function retryParams(node: Pick<WorkflowNode, "retryOnFail" | "maxTries" | "waitBetweenTries">): {
  tries: number;
  waitMs: number;
} {
  if (node.retryOnFail !== true) return { tries: 1, waitMs: 0 };
  const tries = Math.min(5, Math.max(2, Math.trunc(node.maxTries ?? 3)));
  const waitMs = Math.min(5000, Math.max(0, Math.trunc(node.waitBetweenTries ?? 1000)));
  return { tries, waitMs };
}

/** 判断某个节点是不是触发器（按注册信息优先，注册表未加载时退回类型的兜底规则）。 */
export function isTriggerType(type: string): boolean {
  return type.endsWith("Trigger");
}

/** 把一个节点的输出统一成 `NodeOutputData`（三种返回形状都接受）。 */
export function toOutputData(result: NodeExecuteResult): NodeOutputData {
  if (result === undefined) return { main: [] };
  if (Array.isArray(result)) {
    // 空数组表示「没有输出」而不是「一个输出口、零条数据」以外的含义
    return { main: [result as Item[]] };
  }
  if (Array.isArray(result.main)) return result;
  return { main: [] };
}

// ---------------------------------------------------------------------------
// 表达式与代码沙箱的对外契约（实现在 expressions/，由 wf-expr 负责）
// ---------------------------------------------------------------------------

/** `$now` / `$today` 的最小日期能力（不引日期库）。 */
export interface WorkflowDate {
  /** ISO 8601（含毫秒）。 */
  toISO(): string;
  /** 自定义格式：支持 yyyy MM dd HH mm ss SSS 与中文占位（见 expressions 文档）。 */
  format(pattern?: string): string;
  /** epoch 毫秒。 */
  toMillis(): number;
  /** 本地 Date（只读用途）。 */
  toDate(): Date;
  /** 加若干单位；返回新对象。 */
  plus(amount: number, unit: DateUnit): WorkflowDate;
  /** 减若干单位；返回新对象。 */
  minus(amount: number, unit: DateUnit): WorkflowDate;
  /** 取整到单位起点（day/hour/minute/second/month/year/week）。 */
  startOf(unit: DateUnit): WorkflowDate;
}

export type DateUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

/** 表达式求值上下文（引擎按「当前 item」构造；不是全局状态）。 */
export interface ExpressionContext {
  $json: Record<string, unknown>;
  $items: Item[];
  $itemIndex: number;
  $runIndex: number;
  $node: Record<string, { json: Record<string, unknown>; all: () => Item[] }>;
  $now: WorkflowDate;
  $today: WorkflowDate;
  $timestamp: number;
  $workflow: { id: string; name: string; active: boolean };
  $execution: { id: string; mode: ExecutionMode };
  $vars: Record<string, unknown>;
  /** 当前节点的原始参数（未解析），`$parameter["名字"]` 用。 */
  $parameter: Record<string, unknown>;
}

/** 代码节点的运行器（Web Worker 沙箱；测试可注入同步实现）。 */
export interface RunUserCodeOptions {
  code: string;
  mode: "runOnceForAllItems" | "runOnceForEachItem";
  items: Item[];
  itemIndex?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type UserCodeRunner = (options: RunUserCodeOptions) => Promise<unknown>;
