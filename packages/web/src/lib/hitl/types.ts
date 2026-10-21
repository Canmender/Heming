/**
 * HITL（Human-in-the-loop，工具执行前人工确认）层的类型定义。
 *
 * 这一层是**纯类型**（零运行时），供三层共用：
 * - `lib/hitl/**`：纯逻辑闸门（不引 React，可单测）；
 * - `store/hitl.ts`：React 侧的待确认队列；
 * - `lib/agentStream.ts`：只在 `bridge.execute` 之前调一次闸门。
 *
 * 依赖方向严格单向：hitl 不知道 agentStream 的存在，agentStream 只认这里的类型。
 */

/**
 * 风险等级。
 *
 * - `read`：只读（看截图、查记忆、算数），不该打断用户；
 * - `write`：会改状态（写记忆、改技能、落文件）；
 * - `danger`：可能造成不可逆后果（删文件、跑命令、改自己的执行环境）。
 *
 * 分类原则是**白名单制**：认不出来的一律按 `write` 起，宁可多问一次，
 * 也不要把一个没见过的工具当成只读放过去。
 */
export type RiskLevel = "read" | "write" | "danger";

/**
 * 一次决策。
 *
 * - `allow`：仅本次允许；
 * - `allow-session`：本会话内允许该工具（会话授权，进程退出即失效）；
 * - `deny`：拒绝；
 * - `pass`：策略层自动放行（闸门内部消解，不外传到 UI 与模型）。
 *
 * ★ 用 `pass` 而不是 `auto`：`auto` 曾经是策略档位的名字，
 * 同名两义（档位 vs 判定结果）迟早让人误读。档位里已没有 `auto`。
 */
export type Decision = "allow" | "allow-session" | "deny" | "pass";

/**
 * 策略档位。
 *
 * - `strict`：全部询问；
 * - `guarded`：只读放行，写操作与危险操作必问（**默认**）；
 * - `trusted`：同 `guarded`，但「本会话内允许」的授权开始生效。
 *
 * ★ **只有三档，没有「全放行」档。**
 * 曾经有过 `auto`（全部放行），被否掉了——它与自我修改工具组合后是致命的：
 *
 * ```
 * self_mcp_add_server（加一个 MCP）   ← danger，必须问
 *   → self_mcp_enable（启用它）        ← danger，必须问
 *     → 那个 MCP 的所有工具             ← auto 档下全部静默执行
 * ```
 *
 * 加上「装第三方包」（MCP Registry），这条链的后果是
 *「用户随手装了个包 → 任意代码静默执行」。
 * 而用户开启 HITL 的动机恰恰是"我要安全边界"——
 * 给一个一键关掉边界的档位，是误触即失效的设计。
 * `trusted`（会话内记住允许）已覆盖「不想被打扰」的需求，且有会话边界。
 */
export type HitlMode = "strict" | "guarded" | "trusted";

/** 策略作用域：按智能体分别授权 / 所有智能体共用一份授权。 */
export type PolicyScope = "per-agent" | "global";

/** 工具来源：MCP 外部服务 / 自我修改 / 图表 / 去 AI 味 / 认不出来。 */
export type HitlSource = "mcp" | "self" | "chart" | "tone" | "unknown";

/**
 * 策略层判定结果。
 *
 * 刻意与 `Decision` 分开：`Decision` 描述的是**用户已经做出的决定**，
 * 而策略层此刻还不知道用户会怎么答——它只能回答「免问放行」还是「要问人」。
 *
 * ★ `pass` 而非 `auto`：与 `HitlMode` 已删除的 `auto` 档同名会混淆。
 */
export type PolicyOutcome = "pass" | "ask";

/**
 * 记住的规则效果。
 *
 * `deny` 优先于 `allow`：同一工具/资源上两类规则同时存在时，按拒绝处理。
 * `allow` 只对 `read`/`write` 生效——`danger` 永远会问，
 * 否则「按资源记住」就成了事实上的全放行。
 */
export type RuleEffect = "allow" | "deny";

/** 一条落盘的授权规则：工具 + 资源 + 效果。资源为 `*` 表示该工具的所有调用。 */
export interface HitlRule {
  tool: string;
  resource: string;
  effect: RuleEffect;
  at: string;
  /**
   * 规则归属的智能体。缺省 = 历史遗留的全局规则（对所有智能体生效）。
   *
   * 为什么要分作用域：群聊里 A 智能体被拒绝的写操作，不该让 B 智能体的同一工具
   * 也永久免问/永久被拒。新规则一律带 agentId，旧规则保持全局以兼容既有存储。
   */
  agentId?: string;
  /** 智能体名快照：设置区展示用，避免为了显示名字再去查名册。 */
  agentName?: string;
}

/** 一个待确认的工具调用（已分类、已生成参数摘要）。 */
export interface HitlCall {
  /** 模型给的 tool_call id（回灌 tool 消息时用它对齐）。 */
  id: string;
  /** OpenAI 格式的工具名。 */
  name: string;
  /** 模型给的原始参数 JSON 字符串。 */
  argsJson: string;
  /** 给人看的中文动作名（如「写入记忆」）。 */
  displayName: string;
  /** 风险等级。 */
  risk: RiskLevel;
  /** 参数摘要（一行，敏感值已替换成 `***`）。 */
  summary: string;
  /** 工具来源。 */
  source: HitlSource;
}

/**
 * 一批待确认的工具调用（闸门一次确认一批，不逐条弹窗）。
 *
 * `calls` 与 `auto` 必须分开：「需要用户裁决」与「已自动放行、只展示」
 * 混在一起的话，`strict` 档下要问的只读项会被 UI 当成已经放行而藏起来。
 */
export interface HitlBatch {
  streamId: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  /** 需要用户裁决的调用。 */
  calls: HitlCall[];
  /** 已自动放行的调用（只读项，折叠展示，不可勾选）。可缺省。 */
  auto?: HitlCall[];
}

/** 用户（或策略）对一个工具调用给出的裁决。 */
export interface HitlVerdict {
  /** 对应的 `HitlCall.id`。 */
  callId: string;
  /** 裁决（不含 `pass`——`pass` 是策略层消解出来的，闸门不会把它交给 UI）。 */
  decision: Exclude<Decision, "pass">;
  /** 拒绝理由 / 说明（可选）。 */
  reason?: string;
  /** 是否把本次裁决记成规则（按工具 + 资源落盘）。缺省 false。 */
  remember?: boolean;
}

/**
 * 拒绝原因分类。
 *
 * - `user`：用户当场拒绝（或在同一轮里拒绝过同一调用）；
 * - `rule`：命中了用户此前记住的拒绝规则；
 * - `gate`：闸门/UI 异常，**不是用户拒绝**——回灌文案不能写「用户拒绝了」。
 */
export type DenyCause = "user" | "rule" | "gate";

/**
 * 闸门给出的最终结果：一个 tool_call 对一条。
 *
 * `deny` 的项**绝不能**被 `bridge.execute` 执行；它会被替换成一段
 * 「明确声明未修改」的文案回灌给模型（见 `text.ts` 的 `deniedText`）。
 */
export type GateOutcome =
  | { kind: "allow"; call: HitlCall }
  | { kind: "deny"; call: HitlCall; reason?: string; cause?: DenyCause };
