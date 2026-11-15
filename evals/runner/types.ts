/**
 * 评测 runner 的输入契约（与 `evals/README.md` 一一对应）。
 *
 * 这里只做**结构**，不做语义校验——校验在 `loader.ts` 里集中做，
 * 好处是 YAML 写错时能报「哪个文件、哪个字段」，而不是中途抛 undefined。
 */

/** 一条用例里的一次工具调用（模型侧脚本）。 */
export interface ScriptToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** 一次「模型回合」：要么给文本，要么给工具调用，或两者都有。 */
export interface ScriptTurn {
  text?: string;
  tool_calls?: ScriptToolCall[];
}

/** 用例的根目录配置（路径相对用例工作目录；缺省一条 `.` 的写根）。 */
export interface CaseRoot {
  path: string;
  mode: "read" | "write";
  name?: string;
}

export interface CaseSetup {
  fixture?: string;
  roots?: CaseRoot[];
  outOfRoot?: "ask" | "reject";
}

/** 假工具的返回内容（MCP / 记忆 / 技能在确定性模式下的替身）。 */
export interface FakeTool {
  name: string;
  result?: { text?: string; ok?: boolean };
}

/** 每回合上报的 token 用量（缺省 input 900 / output 120）。 */
export interface CaseUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 多步用例的一步（每步 = 一次独立的用户回合，历史在步之间累积）。 */
export interface CaseStep {
  prompt: string;
  script?: ScriptTurn[];
}

export type GraderType =
  | "contains"
  | "regex"
  | "exact"
  | "file_assert"
  | "tool_called"
  | "tool_sequence"
  | "max_rounds"
  | "hitl"
  | "no_side_effect"
  | "llm_judge";

/** grader 的并集（按 `type` 取用对应字段；未用到的字段忽略）。 */
export interface Grader {
  type: GraderType;
  /** contains / exact 的目标文本（`value` 可以是数组：全部命中才算过）。 */
  value?: string | string[];
  pattern?: string;
  /** contains / regex / exact 的取文本口径。 */
  in?: "final" | "tool_result" | "any";
  /** file_assert / no_side_effect 的路径（相对用例工作目录，或绝对路径）。 */
  path?: string;
  paths?: string[];
  contains?: string | string[];
  not_contains?: string | string[];
  exists?: boolean;
  tool?: string;
  tools?: string[];
  times?: number;
  /** max_rounds 的上限。 */
  max?: number;
  /** hitl 期望的结局。 */
  expect?: "allowed" | "denied";
  /** llm_judge 的评分要点（仅 --real 生效）。 */
  rubric?: string;
}

export interface EvalCase {
  id: string;
  name: string;
  owner: string;
  tags: string[];
  setup?: CaseSetup;
  /** 单步用例的提示词（与 `steps` 二选一）。 */
  prompt?: string;
  /** 单步用例的脚本（与 `steps` 二选一；`steps` 存在时被忽略）。 */
  script?: ScriptTurn[];
  /** 多步用例。 */
  steps?: CaseStep[];
  fake_tools?: FakeTool[];
  usage?: CaseUsage;
  graders: Grader[];
  /** YAML 文件路径（报错时报给人看）。 */
  file?: string;
}

/** 一次用例运行的观测结果（grader 的输入）。 */
export interface CaseObservation {
  /** 用例工作目录（fixture 复制到这里）。 */
  dir: string;
  /** 全部 rollout 记录（按发生顺序）。 */
  rollout: RolloutRecord[];
  /** 全部 assistant_final 文本，按顺序。 */
  finals: string[];
  /** 全部 tool_result 文本，按顺序。 */
  toolResults: string[];
  /** 模型的工具调用（按发生顺序）。 */
  toolCalls: { id: string; name: string }[];
  /** 工具调用结果（按发生顺序；`ok` 是工具层真实结果）。 */
  toolOutcomes: { id: string; name: string; ok: boolean; denied: boolean; text: string }[];
  /** 闸门裁决（按发生顺序）。 */
  decisions: { id: string; name: string; decision: "allow" | "deny"; reason?: string }[];
  /** 本次用例的模型回合数（= 假网关被调用次数）。 */
  rounds: number;
  /** 每回合的 token 用量（由 turn_end.usage 汇总）。 */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 本次用例耗时（毫秒）。 */
  durationMs: number;
}

/** rollout 记录的最小形状（runner 只关心这几类）。 */
export type RolloutRecord =
  | { type: "turn_start"; streamId: string; userText: string }
  | { type: "tool_call"; streamId: string; id: string; name: string; args: string }
  | { type: "tool_result"; streamId: string; id: string; name: string; ok: boolean; denied?: boolean; text: string }
  | { type: "assistant_final"; streamId: string; text: string }
  | { type: "turn_end"; streamId: string; status: string };
