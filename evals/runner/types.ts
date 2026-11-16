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
  /**
   * 预置任务清单（d.161）：用来测「清单还有未完成项时会不会自动续跑」。
   *
   * 为什么由用例预置而不是让模型先调 `todo_write`：续跑的判据是**清单状态本身**，
   * 预置能把「清单写入」与「到顶要不要续」两件事拆开测，失败时一眼看出是哪一半。
   */
  todos?: { content: string; status: "pending" | "in_progress" | "completed" }[];
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
  | "min_rounds"
  | "prompt_contains"
  /** 工具返回的图片张数（d.168）：验证 file_image 真的把图交给了管道。 */
  | "image_attached"
  | "todo_state"
  | "hitl"
  | "no_side_effect"
  | "evidence"
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
  /** min_rounds 的下限（用来证明「确实跑过了那个上限」，例如自动续跑）。 */
  min?: number;
  /** todo_state（d.163）：跑完后任务清单里各状态的数量，未写的项不校验。 */
  total?: number;
  completed?: number;
  pending?: number;
  in_progress?: number;
  /** hitl 期望的结局。 */
  expect?: "allowed" | "denied";
  /** llm_judge 的评分要点（仅 --real 生效）。 */
  rubric?: string;
  /**
   * evidence 的期望：`files` / `commands` 里的每一条都必须出现在
   * `assistant_final.evidence` 里（子串匹配，路径分隔符不敏感）。
   * 用途：让「只自称完成、没有证据」的回合判负（P3/T15 验收）。
   */
  files?: string[];
  evidence_commands?: string[];
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
  /**
   * 子代理脚本（d.163）：`agent_task` 的子会话按序消费这些回合。
   *
   * 确定性模式没有模型绑定，子会话必须由脚本驱动；不给它脚本，
   * `agent_task` 只会回「没有可用的模型绑定」，等于测不到子代理的真实循环。
   */
  subagent_script?: ScriptTurn[];
  /** 为 true 时注入真实 `todo_write`（d.163；缺省不注入，避免改变既有用例的工具清单）。 */
  todo?: boolean;
  /** 为 true 时注入真实 `run_command`（d.165；缺省不注入，避免改变既有用例的工具清单）。 */
  shell?: boolean;
  /**
   * 为 true 时确定性闸门放行 `run_command`（d.165）。
   *
   * 命令风险是 danger（生产里每条都要人点确认）：不写这个开关，命令调用会被闸门拒绝——
   * 这正好用来测「危险工具默认不放行」；要验证工具层真实行为（工作目录越界、非零退出码）
   * 的用例才显式写 `allow_danger: true`。
   */
  allow_danger?: boolean;
  /**
   * 为 true 时该用例**天生慢**（故意等超时 / 等取消），不参与 p95 延迟红线（d.167）。
   *
   * 为什么不干脆把阈值放宽：`p95` 的意义是抓「整体变慢」。d.166 的 `cmd-004` 必须真的等
   * 1 秒（工具层超时下限是 1000ms，再短就测不到），它一进来就把 p95 从 26ms 顶到 100ms，
   * 于是 `--compare` 判红——**验证「会超时」的用例反过来把「延迟回归」这条红线弄红了**。
   * 把「天生慢」显式标出来，比放宽全体阈值诚实，也不会漏掉真正的整体变慢。
   */
  slow?: boolean;

  /**
   * 跑起来多久之后模拟「用户点停止」（毫秒，d.169）。
   *
   * 只给取消类用例用：编排层的 `abortAll()` 会把信号透传给在途工具，
   * 命令工具据此调 `bridge.cancel` 让主进程杀进程树。
   * 没有它，「点停止真的停住了」只能靠单元测试猜。
   */
  abort_after_ms?: number;
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
  /**
   * 工具返回的图片张数（d.168）。
   *
   * 为什么不看 rollout：rollout 的 `tool_result` 只有文本，图片是在编排层另起一条
   * user 消息发给模型的；能从 rollout 推出「有图」是巧合，不是契约。
   */
  images: number;
  /**
   * 本次用例的模型回合数（= 假网关被调用次数；真实模型模式下 = 真实请求次数，d.183）。
   */
  rounds: number;
  /** 是否真实模型模式（d.183）：真实模式下「工具调用恰好 N 次」这类脚本口径要放宽。 */
  real?: boolean;
  /**
   * 本轮真正发给模型的系统提示词（d.161）。
   *
   * 为什么要观测它：d.154 的运行环境段、d.156 的默认人设、d.157 的长任务协议都只活在这段文本里，
   * 以前评测只能看工具结果与最终回答——提示词里写丢了、写重了，评测完全看不见。
   */
  systemPrompt: string;
  /** 每回合的 token 用量（由 turn_end.usage 汇总）。 */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 用例跑完后本会话任务清单的状态（d.163；没有清单就是空数组）。 */
  todos: { content: string; status: string }[];
  /** 本次用例耗时（毫秒）。 */
  durationMs: number;
  /** 全部 assistant_final 的完成证据（P3/T15；没有证据就是空数组）。 */
  evidence: {
    files: string[];
    commands: string[];
    outputDigest?: string;
  }[];
}
}

/** rollout 记录的最小形状（runner 只关心这几类）。 */
export type RolloutRecord =
  | { type: "turn_start"; streamId: string; userText: string }
  | { type: "tool_call"; streamId: string; id: string; name: string; args: string }
  | { type: "tool_result"; streamId: string; id: string; name: string; ok: boolean; denied?: boolean; text: string }
  | {
      type: "assistant_final";
      streamId: string;
      text: string;
      evidence?: { files: string[]; commands: string[]; outputDigest?: string };
    }
  | { type: "turn_end"; streamId: string; status: string };
