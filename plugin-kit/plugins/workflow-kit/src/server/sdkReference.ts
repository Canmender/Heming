/**
 * 智能体用的 SDK / 规范参考（静态文本）。
 *
 * 为什么做成静态内容而不是让智能体读源码：参考是「契约」——工作流 JSON 的结构、
 * 表达式上下文、节点设置、试跑语义。它随代码发布，内容与实现同版本；
 * 智能体按 topic 取用，不必在提示词里塞一大段（也不会随模型记忆漂移）。
 */

export const SDK_REFERENCE_TOPICS = [
  "overview",
  "workflow-json",
  "expressions",
  "node-settings",
  "testing",
  "patterns",
  "troubleshooting",
] as const;

export type SdkReferenceTopic = (typeof SDK_REFERENCE_TOPICS)[number];

const OVERVIEW = `# 工作流引擎 · 智能体参考（总览）

工作流是一条有向图：nodes 数组 + connections 对象。数据以 items 数组在节点间流动，每个 item 形如 {json:{...}}。

一次典型设计流程：
1. node_types 看有哪些节点；node_type_detail {type} 拿完整参数 schema；
2. credential_list 看可用凭据（只回 id/名称/类型，不含密钥）；
3. 生成工作流 JSON → workflow_validate；
4. workflow_test + pinData 用固定数据试跑（副作用节点 pin 掉）；
5. workflow_create / workflow_update 保存；
6. workflow_run 异步运行 → workflow_run_status 轮询；
7. 需要定时运行时 workflow_set_active {active:true}（等价发布）。

边界：代码节点跑在本机 node:vm 沙箱（同步、无网络/文件）；HTTP 是本机出网入口；
凭据不会出现在工作流导出物里；执行数据有体积上限（单条 64KB、整条 1MB）。`;

const WORKFLOW_JSON = `# 工作流 JSON 结构

{
  "name": "举例",
  "description": "可选",
  "tags": ["可选"],
  "nodes": [
    {
      "id": "稳定 id（自己生成，建议 n1/n2 或 uuid）",
      "name": "工作流内唯一的显示名（中文）",
      "type": "manualTrigger",
      "position": { "x": 80, "y": 120 },
      "parameters": { },
      "disabled": false,
      "retryOnFail": false, "maxTries": 3, "waitBetweenTries": 1000,
      "onError": "stopWorkflow | continueRegularOutput | continueErrorOutput",
      "executeOnce": false,
      "alwaysOutputData": false,
      "notes": "可选",
      "credentials": { "httpAuth": "凭据 id" },
      "pinData": [ { "json": { } } ]
    }
  ],
  "connections": {
    "源节点 id": { "main": [ [ { "node": "目标节点 id", "type": "main", "index": 0 } ] ] }
  },
  "settings": {
    "timezone": "local",
    "saveDataSuccessExecution": "all",
    "saveDataErrorExecution": "all",
    "saveManualExecutions": true,
    "callerPolicy": "any"
  },
  "active": false
}

要点：
- connections 用节点 id 作键；main[输出口序号] = 目标数组；IF 输出 0=true、1=false；Switch 按规则顺序，最后一个是兜底。
- 节点参数名必须来自 node_type_detail，不要猜；表达式写在字符串里。
- 同一节点在循环里可运行多次；runData 会按次保留（有上限）。`;

const EXPRESSIONS = `# 表达式 {{ }}

- 整段就是一个表达式时保留原始类型（数字/数组/对象）；夹在文本里按字符串拼接。
- 可用变量：
  $json 当前 item 的 json；$items 当前输入全部 items；$itemIndex / $runIndex；
  $node["节点名"].json / $node["节点名"].all()；$now / $today（可 .format("yyyy-MM-dd")、.plus(1,"day")、.startOf("week")）；
  $timestamp；$workflow；$execution；$vars（全局变量）；$parameter（当前节点原始参数）。
- 常用函数：$if / $isEmpty / $length / $toJson / $fromJson / $number / $string / $boolean / $uuid / $random / $item(index)，
  以及字符串/数组方法（原生 JS）。
- 示例：{{ $json.name }}、{{ $now.plus(1,"day").format("yyyy-MM-dd") }}、
  {{ $items.length }}、{{ $node["设置字段"].json.id }}。
- 安全：表达式在本机求值，window/fetch/localStorage/process 等被遮蔽；不要写多语句（只支持单个表达式）。`;

const NODE_SETTINGS = `# 节点级设置（写在节点对象上）

- retryOnFail（true 才重试）+ maxTries（2–5，默认 3）+ waitBetweenTries（0–5000ms，默认 1000）；
- onError：stopWorkflow（默认，失败即停）/ continueRegularOutput（输入原样透传继续）/
  continueErrorOutput（错误项切到最后一个输出口，形如 {json:{error:"消息", ...上游json}}）；
- executeOnce：同一执行内只运行一次（首次拿全部输入）；
- disabled：禁用节点，数据透传；
- pinData：固定输出（引擎不执行该节点，直接用这些 items）——workflow_test 就是靠它做无副作用试跑；
- alwaysOutputData：没有输出也把下游入栈（调试用）；
- credentials：{ 凭据类型: 凭据 id }，类型见 credential_types；
- notes：画布备注。

执行记录：每个节点每次运行都记 status / 耗时 / itemsTotal / 输出（受保存策略裁剪）、错误；
整条执行的状态是 success | error | canceled（超时会置 canceled 并写明原因）。`;

const TESTING = `# 试跑与调试

- workflow_test { id, pinData, startNodeId?, timeoutMs? }：**同步**试跑。
  - pinData 形如 { "节点id或节点名": [ {json:{...}} ] }；被 pin 的节点不执行。
  - 有副作用的节点（触发器/HTTP/通知/mcpTool/executeWorkflow）先 pin 掉，避免真的发请求/发通知。
  - 默认 10 秒、最长 15 秒；超时返回 status=canceled、timedOut=true。
  - 返回逐节点 status/itemsTotal/error 与输出预览（每条 ≤2KB、最多 3 条），足以定位数据问题。
  - pinData 只活在本次试跑，不写回工作流。
- workflow_run 是异步的（返回 executionId），用 workflow_run_status 轮询；
  HTTP 节点失败会带 httpCode；表达式错误会说「变量不存在」；代码节点错误是中文沙箱错误。
- 需要看某次执行的完整节点数据时，用 workflow_execution_detail（默认脱敏 + 截断）。`;

const PATTERNS = `# 常见链路写法

1. 定时抓取 → 整理 → 通知：
   scheduleTrigger → httpRequest → set → notification
2. 条件分支：
   if（输出 0=true / 1=false）→ 两个分支各自的后续节点
3. 多路归并：
   if 两路 → merge（append 或按字段）→ 后续
4. 循环处理：
   splitInBatches（输出 0=本批继续、1=完成）→ 把「继续」接回上游处理节点形成回环
5. 子流程：
   executeWorkflow {workflowId} 调另一条工作流；被调方用 executeWorkflowTrigger 接收输入
6. 错误处理：
   工作流 settings.errorWorkflowId 指向一条以 errorTrigger 开头的工作流；或节点 onError=continueErrorOutput 自己处理
7. 大模型：
   set（拼提示词）→ llm（本机模型连接）→ 解析/通知
8. 调外部 MCP 服务：
   mcp_list_tools {url} 发现工具 → mcpTool {url, tool, arguments}
9. Webhook 触发：
   工作流里放 webhookTrigger（path 留空=工作流 id，method 默认 POST，可选 authToken），
   启用后再调用 POST http://127.0.0.1:8777/webhook/<路径>，请求体作为数据输入；
   停用工作流即关闭该 webhook。
10. 幂等/去重：
   code 或 removeDuplicates；跨运行状态用工作流静态数据（code 里 context 不直接暴露，建议用 set + 上游数据判断）

命名：中文、组内唯一；坐标从左到右 x+240、从上到下 y+120。`;

const TROUBLESHOOTING = `# 排错清单

- 「未知节点类型」：node_types 确认 type；导入 n8n 工作流时未识别节点会被丢弃并给 warning。
- 「缺少必填参数」：node_type_detail 看 required；中文参数名与 type 都对一遍。
- 表达式报「变量不存在」：检查 $json 字段是否在上游产出；先用 workflow_test 的 preview 看实际数据形状。
- HTTP 失败：看 error.httpCode；非 2xx 默认让节点失败，确需继续可开 neverError 或 onError。
- 代码节点：只支持同步代码（await/Promise 会报错）；无网络/文件/process；10 秒超时。
- 试跑没数据：确认 pinData 的键是节点 id 或节点名；被 pin 的节点不会再执行。
- 定时不触发：workflow_set_active 是否 true；工作流里是否有 scheduleTrigger；服务进程是否在运行。
- 执行记录缺数据：单条 64KB / 整条 1MB 会截断（标 dataTruncated）；这是有意上限，不是丢结果。
- 并发：同一条工作流同时只允许一个执行；不同工作流可并行。`;

const TOPIC_CONTENT: Record<SdkReferenceTopic, string> = {
  overview: OVERVIEW,
  "workflow-json": WORKFLOW_JSON,
  expressions: EXPRESSIONS,
  "node-settings": NODE_SETTINGS,
  testing: TESTING,
  patterns: PATTERNS,
  troubleshooting: TROUBLESHOOTING,
};

export function sdkReference(topic?: string): {
  topic: string;
  availableTopics: readonly string[];
  content: string;
} {
  const normalized = typeof topic === "string" ? topic.trim() : "";
  if (normalized && (SDK_REFERENCE_TOPICS as readonly string[]).includes(normalized)) {
    return {
      topic: normalized,
      availableTopics: SDK_REFERENCE_TOPICS,
      content: TOPIC_CONTENT[normalized as SdkReferenceTopic],
    };
  }
  return {
    topic: "overview",
    availableTopics: SDK_REFERENCE_TOPICS,
    content: OVERVIEW,
  };
}
