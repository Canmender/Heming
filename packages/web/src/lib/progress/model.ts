import type { MessageTranscript, ToolTrace } from "../../store/chat.js";

/**
 * 会话进度的**纯函数模型**（d.147.4.88）。
 *
 * 为什么单独一层、不直接写在面板组件里：右侧栏要同时回答四个问题
 * （这一轮到哪一步了 / 走了哪些步骤 / 调了哪些工具 / 用一张图讲清顺序），
 * 四个视图必须来自**同一份推导**，否则「步骤说成功、工具还转圈」这类自相矛盾
 * 迟早出现。把推导抽成纯函数后，它可以脱离 React 直接测（`model.test.ts`），
 * 面板只做渲染。
 *
 * 数据来源只有两处，都是既有事实、不新增状态：
 * - 流式中的 `AgentStreamState`（text / reasoning / tools / status）；
 * - 已收口消息的转录 `MessageTranscript`（thinking / tools，本机持久化）。
 * 待确认项数来自 HITL 的单槽 `pending`（只取本会话那一批）。
 */

/** 这一轮所处的阶段（决定面板顶部的主叙述与颜色）。 */
export type ProgressPhase = "idle" | "thinking" | "acting" | "waiting" | "done" | "error";

/** 一步的种类：想 / 做 / 等确认 / 答。 */
export type ProgressStepKind = "think" | "tool" | "confirm" | "answer";

/** 一步的状态（与 `ToolTrace["status"]` 对齐，另加「等用户」）。 */
export type ProgressStepStatus = "running" | "ok" | "error" | "denied" | "waiting";

/** 面板里的一步（对应时间轴上的一个节点）。 */
export interface ProgressStep {
  /** 稳定键：思考/回答各一条，工具用调用 id，确认用 `confirm`。 */
  id: string;
  kind: ProgressStepKind;
  /** 给用户看的一句话（工具步是「调用 工具名」，确认步带条数）。 */
  label: string;
  status: ProgressStepStatus;
  /** 次要说明：工具结果/思考开头，已截断，渲染层再决定要不要折叠。 */
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

/** 工具调用的计数摘要（面板顶部的小字，也是流程图图例的数据源）。 */
export interface ProgressCounts {
  total: number;
  ok: number;
  error: number;
  denied: number;
  running: number;
}

/** 一次推导的完整结果：面板所有区块都从这里取数。 */
export interface ConversationProgress {
  phase: ProgressPhase;
  /** 顶部主叙述：「正在调用工具」「等待确认 2 项」…… */
  headline: string;
  /** 时间轴上的步骤（思考 → 工具… → 确认 → 回答）。 */
  steps: ProgressStep[];
  /** 原始工具轨迹（工具区块复用现有 `ToolTraceList` 渲染）。 */
  tools: ToolTrace[];
  /** 思考过程原文（已按转录上限截断过的就是截断后的）。 */
  thinking: string;
  counts: ProgressCounts;
  /** 待用户确认的项数（0 = 没有卡在确认上）。 */
  pendingConfirms: number;
  /** 步骤完成度：`done/total`，供进度条；没有步骤时都是 0。 */
  progress: { done: number; total: number };
  /** 这一轮是否有任何可展示的事实（false → 面板出空态）。 */
  hasData: boolean;
}

/** 推导输入里「正在流式的那一轮」所需字段（结构化，便于测试构造）。 */
export interface ProgressStreamSnapshot {
  text?: string;
  reasoning?: string;
  tools?: ToolTrace[];
  status?: "streaming" | "error";
  errorMessage?: string;
}

export interface ProgressInput {
  /** 正在流式的那一轮（本机生成或他机回声）；没有则为 undefined。 */
  stream?: ProgressStreamSnapshot;
  /** 已收口消息的转录（流式结束后用；与 stream 同时存在时 stream 优先）。 */
  transcript?: MessageTranscript;
  /** HITL 待确认项数（只算本会话那一批）。 */
  pendingConfirms?: number;
}

/** 步骤详情/工具结果的摘要长度：面板窄，超出一行只会变成噪音。 */
const DETAIL_MAX = 80;

function clip(text: string, max = DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

/** 工具状态 → 步骤状态（同名字段，显式列出以免将来加状态时静默错位）。 */
function stepStatusOf(tool: ToolTrace): ProgressStepStatus {
  switch (tool.status) {
    case "running":
      return "running";
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "denied":
      return "denied";
  }
}

function countOf(tools: readonly ToolTrace[]): ProgressCounts {
  const counts: ProgressCounts = { total: tools.length, ok: 0, error: 0, denied: 0, running: 0 };
  for (const tool of tools) counts[tool.status] += 1;
  return counts;
}

/**
 * 推导一次会话进度。
 *
 * 顺序即语义：先「想」，再按发生顺序一个个「做」，卡住时插入「等确认」，
 * 最后「答」。不造任何假步骤——没有思考文本就没有思考步，没调工具就没有工具步，
 * 这样「空态」与「真的刚开始」不会被编出来的节点糊成一片。
 */
export function buildConversationProgress(input: ProgressInput): ConversationProgress {
  const streaming = input.stream?.status === "streaming";
  const errored = input.stream?.status === "error";
  const tools: ToolTrace[] = input.stream?.tools ?? input.transcript?.tools ?? [];
  const thinking = (input.stream?.reasoning ?? input.transcript?.thinking ?? "").trim();
  const text = (input.stream?.text ?? "").trim();
  const pendingConfirms = Math.max(0, input.pendingConfirms ?? 0);
  const counts = countOf(tools);

  const steps: ProgressStep[] = [];

  if (thinking) {
    steps.push({
      id: "think",
      kind: "think",
      label: "思考",
      // 还在想（没有工具也没开始回答）时转圈；一旦往下走就视为已完成。
      status: streaming && tools.length === 0 && !text ? "running" : "ok",
      detail: clip(thinking),
    });
  }

  for (const tool of tools) {
    steps.push({
      id: tool.id,
      kind: "tool",
      label: `调用 ${tool.name}`,
      status: stepStatusOf(tool),
      ...(tool.result ? { detail: clip(tool.result) } : {}),
      startedAt: tool.startedAt,
      ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
    });
  }

  if (pendingConfirms > 0) {
    steps.push({
      id: "confirm",
      kind: "confirm",
      label: `等待你确认 ${pendingConfirms} 项工具调用`,
      status: "waiting",
      detail: "在对话里点「允许」或「拒绝」后，这里会继续往下走。",
    });
  }

  if (text) {
    steps.push({
      id: "answer",
      kind: "answer",
      label: streaming ? "生成回答" : "回答",
      status: streaming ? "running" : "ok",
      detail: clip(text),
    });
  }

  const done = steps.filter(
    (s) => s.status === "ok" || s.status === "error" || s.status === "denied",
  ).length;

  const phase: ProgressPhase =
    pendingConfirms > 0
      ? "waiting"
      : errored
        ? "error"
        : streaming
          ? tools.length > 0
            ? "acting"
            : "thinking"
          : steps.length > 0
            ? "done"
            : "idle";

  const headline =
    phase === "idle"
      ? "还没有进度"
      : phase === "thinking"
        ? "正在思考"
        : phase === "acting"
          ? "正在调用工具"
          : phase === "waiting"
            ? `等待确认 ${pendingConfirms} 项`
            : phase === "error"
              ? "这一轮中断了"
              : "这一轮已完成";

  return {
    phase,
    headline,
    steps,
    tools,
    thinking,
    counts,
    pendingConfirms,
    progress: { done, total: steps.length },
    hasData: steps.length > 0,
  };
}