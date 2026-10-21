/**
 * HITL（工具执行前人工确认）层的对外出口。
 *
 * 与 `lib/mcp/index.ts` 同一风格：调用方只 import 这一个入口，
 * 内部文件怎么拆不外泄。
 */
export type {
  Decision,
  DenyCause,
  GateOutcome,
  HitlBatch,
  HitlCall,
  HitlMode,
  HitlRule,
  HitlSource,
  HitlVerdict,
  PolicyOutcome,
  PolicyScope,
  RiskLevel,
  RuleEffect,
} from "./types.js";
export {
  RISK_ORDER,
  classifyCall,
  displayNameOf,
  resolveRisk,
  riskOfName,
  ruleResource,
  sourceOf,
  summarizeArgs,
  toHitlCall,
  type HitlRiskHints,
  type RawToolCall,
} from "./classify.js";
export {
  GIT_UNCHANGED,
  MUST_CONTAIN,
  allowedText,
  deniedText,
  notExecutedText,
  ruleDeniedText,
} from "./text.js";
export { appendToolAudit, type ToolAuditEntry } from "./audit.js";
export {
  DEFAULT_HITL_POLICY,
  HITL_KEY,
  HITL_RULES_KEY,
  MAX_HITL_RULES,
  HitlPolicyStore,
  type HitlPolicy,
} from "./policy.js";
export {
  createHitlGate,
  toHitlBatch,
  type HitlGate,
  type HitlGateDeps,
} from "./gate.js";
