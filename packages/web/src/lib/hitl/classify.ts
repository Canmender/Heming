/**
 * 工具风险分类与参数摘要。
 *
 * 为什么单独一个模块：闸门要回答两个问题——
 * 「这个调用有多危险」与「这次调用到底要干什么」——
 * 而这两个答案必须是**纯函数**：不依赖 React、不依赖存储、可单测。
 *
 * 分类优先级（设计 §5.1）：
 * 1. 桥自带 `meta.risk`（作者显式声明，最高优先）；
 * 2. 内置前缀表（`self_*` / `chart_*` / `tone_*`）；
 * 3. 危险词正则（`delete` / `exec` / `powershell` …）→ danger；
 * 4. 读意图启发（`get` / `list` / `search` …）→ read；
 * 5. 兜底 → **write**（绝不兜底成 read）。
 *
 * ★ **MCP 的 `annotations` 不参与判定**。
 * 规范原文（`schema/2025-06-18/schema.json` 的 `ToolAnnotations.description`）：
 * > "NOTE: all properties in ToolAnnotations are **hints**. They are not
 * >  guaranteed to provide a faithful description of tool behavior
 * >  (including descriptive properties like `title`).
 * >  **Clients should never make tool use decisions based on ToolAnnotations
 * >  received from untrusted servers.**"
 *
 * 2025-12-11 版更明确：`MUST consider tool annotations to be untrusted`。
 * 实测真实服务器（Windows-MCP）**20/20 个工具都带 annotations**——
 * 所以这不是理论风险：恶意服务器只要把 `readOnlyHint` 设成 `true`，
 * 它的 `delete_file` / `run_command` 就会静默执行。
 * → annotations 只用于**展示标注**（如「该服务器自述为只读工具（未经核实）」）。
 */

import { containsSensitive } from "../selfEdit/guards.js";
import type { HitlCall, HitlSource, RiskLevel } from "./types.js";

/** 风险等级的大小序（用于比较「不高于某个等级」）。 */
export const RISK_ORDER: Record<RiskLevel, number> = { read: 0, write: 1, danger: 2 };

/**
 * 分类时外部（工具桥）给的风险提示。
 *
 * - `risk`：**作者显式声明**（我们自己的桥给的），参与判定，优先级最高。
 * - `displayName`：展示用的友好名，不参与判定。
 * - `readOnlyHint`：MCP 的 `annotations.readOnlyHint`。
 *   ★ **不参与判定**（规范明言 untrusted hint，见文件头），
 *   只用于界面上的「该服务器自述为只读工具（未经核实）」这类标注。
 */
export interface HitlRiskHints {
  risk?: RiskLevel;
  displayName?: string;
  readOnlyHint?: boolean;
}

/**
 * 显式命名的内置工具 → 风险。
 *
 * ★ **这是 self 工具分级的「兜底副本」，权威在 `selfEdit/tools.ts` 的 `riskHint`。**
 *
 * 桥显式声明的优先级最高（`resolveRisk` 的第 1 步），
 * 所以正常运行时**这张表对 self 工具根本轮不到**——
 * 它只在「没有桥」的场景生效：单测直接调 `resolveRisk("self_memory_write")`、
 * 或 Registry 侧按工具名判定（那边没有桥）。
 *
 * ⚠️ **两处必须同步改**：改了 `tools.ts` 的 `riskHint` 而忘了这里，
 * 这张表会**静默失效**（桥说什么就是什么，内置表轮不到，也不会有任何报错）。
 * → 改动 self 工具的风险等级时，两处一起改。
 */
const EXACT_RISK: Record<string, RiskLevel> = {
  // 记忆
  self_memory_list: "read",
  self_memory_write: "write",
  self_memory_remove: "write",
  // 技能
  self_skill_list: "read",
  self_skill_update: "write",
  self_skill_create: "write",
  // MCP：能改自己的执行环境，一律 danger
  self_mcp_list: "read",
  self_mcp_enable: "danger",
  self_mcp_disable: "danger",
  self_mcp_add_server: "danger",
  self_mcp_update_server: "danger",
  self_mcp_remove_server: "danger",
};

/** 前缀规则（优先级 3）：图表与去 AI 味都不写任何存储。 */
const PREFIX_RISK: { prefix: string; risk: RiskLevel }[] = [
  { prefix: "chart_", risk: "read" },
  { prefix: "tone_", risk: "read" },
];

/**
 * 危险词（优先级 4）。
 *
 * 注意这里**故意不含**「读」类词：MCP 工具名五花八门，
 * 靠名字猜「读意图」很容易把 `delete_and_list` 之类的名字判成只读。
 * 读意图启发排在危险词**之后**——判错成 danger 只是多问一次，
 * 判错成 read 则可能让危险操作直接落盘。
 */
const DANGER_WORDS =
  /delete|remove|kill|exec|run|powershell|registry|format|write|move|click|type/i;

/** 读意图启发（优先级 3.5，仅在危险词也没命中时使用）。 */
const READ_WORDS = /get|list|read|fetch|query|search|view/i;

/** 参数摘要优先读取的字段（按顺序取第一个命中的）。 */
const SUMMARY_FIELDS = ["path", "file", "url", "query", "name", "server"];

/**
 * 字段名本身像敏感信息。
 *
 * 按「词元」判定而不是整串正则：`key` 单独出现是记忆的主题键（不是密钥），
 * 而 `api_key` / `apiKey` / `access_token` 才该被屏蔽。整串匹配会把
 * `author`、`compass` 这类无辜字段名也误伤。
 */
const SENSITIVE_TOKENS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "passcode",
  "passphrase",
  "credential",
  "credentials",
  "cookie",
  "authorization",
  "auth",
  "apikey",
]);

/** 单独一个 `key` 不算敏感（记忆主题键是它），但「api/access/private + key」算。 */
const KEY_CONTEXT_TOKENS = new Set(["api", "access", "private", "secret"]);

/** 把字段名拆成词元（下划线/连字符/驼峰都是分隔符）。 */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** 工具来源的前缀判定。 */
const SOURCE_PREFIX: { prefix: string; source: HitlSource }[] = [
  { prefix: "self_", source: "self" },
  { prefix: "chart_", source: "chart" },
  { prefix: "tone_", source: "tone" },
];

/** 工具名 → 中文动作名（给人看）。 */
const DISPLAY_NAMES: Record<string, string> = {
  self_memory_list: "列出记忆",
  self_memory_write: "写入记忆",
  self_memory_remove: "删除记忆",
  self_skill_list: "列出技能",
  self_skill_update: "更新技能",
  self_skill_create: "创建技能",
  self_mcp_list: "列出 MCP 服务",
  self_mcp_enable: "启用 MCP 工具",
  self_mcp_disable: "停用 MCP 工具",
  self_mcp_add_server: "新增 MCP 服务",
  self_mcp_update_server: "修改 MCP 服务",
  self_mcp_remove_server: "删除 MCP 服务",
  chart_types: "查询图表类型",
  chart_render: "生成图表",
  tone_detect: "检测 AI 味",
};

/** 前缀兜底的中文动作名。 */
const PREFIX_DISPLAY: { prefix: string; label: string }[] = [
  { prefix: "self_memory_", label: "记忆操作" },
  { prefix: "self_skill_", label: "技能操作" },
  { prefix: "self_mcp_", label: "MCP 配置操作" },
  { prefix: "chart_", label: "图表操作" },
  { prefix: "tone_", label: "文本检测" },
];

/** 未知工具的兜底显示名。 */
const UNKNOWN_DISPLAY = "外部工具";

/**
/**
 * 按名字猜工具来源（**兜底**）。
 *
 * ★ **真实来源以调用方传入的 `source` 为准**——这里只能靠名字猜：
 * MCP 服务器在协议里报的是**裸工具名**（实测形如 `"App"`），
 * 没有 `服务__工具` 那种前缀（那是我们**内部**给模型看的命名空间）。
 * 所以真实的 MCP 工具走到这里会落到 `"unknown"`。
 *
 * → 调用方（`classifyCall` 的 `source` 参数）应传准确来源，
 *   这个函数只在没传时兜底。
 */
export function sourceOf(name: string): HitlSource {
  for (const { prefix, source } of SOURCE_PREFIX) {
    if (name.startsWith(prefix)) return source;
  }
  if (name.includes("__")) return "mcp";
  return "unknown";
}

/**
 * 按名字猜风险（内置前缀表 + 危险词 + 读意图启发 + write 兜底）。
 *
 * 这是**没有外部标注时**的口径：宁可判成 write 让用户多问一次，
 * 也不要把认不出来的工具当只读放过去。
 */
export function riskOfName(name: string): RiskLevel {
  const exact = EXACT_RISK[name];
  if (exact) return exact;
  for (const { prefix, risk } of PREFIX_RISK) {
    if (name.startsWith(prefix)) return risk;
  }
  if (DANGER_WORDS.test(name)) return "danger";
  if (READ_WORDS.test(name)) return "read";
  return "write";
}

/**
 * 风险等级解析（含外部标注）。
 *
 * 顺序：作者显式声明 > 内置表 > 危险词 > 读意图 > write 兜底。
 *
 * ★ **MCP 的 `readOnlyHint` 不在这里**。
 * 规范明言 annotations 是 untrusted hint（文件头有原文），
 * 服务端自述「我是只读的」不能作为放行依据——否则恶意服务器一改标注就能绕过确认。
 */
export function resolveRisk(name: string, hints?: HitlRiskHints): RiskLevel {
  if (hints?.risk) return hints.risk;
  return riskOfName(name);
}

/** 给人看的中文动作名。 */
export function displayNameOf(name: string, hints?: HitlRiskHints): string {
  if (hints?.displayName) return hints.displayName;
  const exact = DISPLAY_NAMES[name];
  if (exact) return exact;
  for (const { prefix, label } of PREFIX_DISPLAY) {
    if (name.startsWith(prefix)) return label;
  }
  return UNKNOWN_DISPLAY;
}

/** 参数是否需要屏蔽（字段名可疑或取值命中密钥模式）。 */
function isSensitive(key: string, value: string): boolean {
  if (containsSensitive(value)) return true;
  const tokens = tokenizeKey(key);
  if (tokens.some((t) => SENSITIVE_TOKENS.has(t))) return true;
  // 单独的 `key` 不是密钥（记忆主题键就是它），但 api_key / access_key 是。
  if (tokens.includes("key") && tokens.some((t) => KEY_CONTEXT_TOKENS.has(t))) return true;
  return false;
}

/** 解析参数 JSON；解析失败一律当空对象（宁可少信息，不要把原始串糊到界面上）。 */
function parseArgs(argsJson: string): Record<string, unknown> {
  const text = (argsJson ?? "").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 抹掉 URL 里的 userinfo（`user:pass@`）。
 *
 * ★ `SENSITIVE_PATTERNS` **不覆盖**这个形态（实测 `https://user:pass@host/mcp` 漏检），
 * 但凭据就在 URL 里、会被原样显示到确认弹窗上。
 *
 * 抹 userinfo 而不是整条遮掉：URL 的其余部分（主机、路径）正是用户判断
 * 「这个服务要连哪里」所需要的信息。
 */
function maskUrlUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@");
}

/**
 * 参数摘要（一行）。
 *
 * 规则：优先取 `path` / `file` / `url` / `query` / `name` / `server` 字段；
 * 命中敏感特征的字段值替换成 `***`；一个已知字段都没有时给截断后的 JSON。
 *
 * 只要参数里出现「像密钥的字段名」（api_key / token / password …），
 * 整条摘要就退化成 `***`——此时无法确定哪个字段是「目标」，
 * 与其猜错把密钥摆到界面上，不如什么都不显示。
 */
export function summarizeArgs(argsJson: string): string {
  const args = parseArgs(argsJson);
  for (const field of SUMMARY_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) {
      if (isSensitive(field, value)) return "***";
      // URL 的 userinfo 要单独抹：它不在敏感模式的覆盖范围内
      return field === "url" ? maskUrlUserinfo(value.trim()) : value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return isSensitive(field, String(value)) ? "***" : String(value);
    }
  }
  // 兜底：没有已知字段。出现可疑字段名时整条退化成 ***。
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && isSensitive(k, v)) return "***";
    if (typeof v === "number" && isSensitive(k, String(v))) return "***";
  }
  // 整段 JSON 截断；敏感取值先替换再序列化，避免密钥漏进摘要。
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && isSensitive(k, v)) safe[k] = "***";
    else if (typeof v === "number" && isSensitive(k, String(v))) safe[k] = "***";
    else if (typeof v === "string" && k === "url") safe[k] = maskUrlUserinfo(v);
    else safe[k] = v;
  }
  return JSON.stringify(safe).slice(0, 80);
}

/**
 * 规则匹配用的资源标识（不做脱敏展示，但会避开密钥并将其判成通配）。
 *
 * 与 `summarizeArgs` 的区别：摘要是给人看的（敏感值一律 `***`），
 * 规则要能精确匹配，所以取原始值；但**敏感字段不落规则**——
 * 把疑似密钥写进 `localStorage` 只为了让规则匹配，不值得。
 * URL 仍剥掉 userinfo；路径统一成正斜杠，避免 Windows / POSIX 写法不一致。
 */
export function ruleResource(argsJson: string): string {
  const args = parseArgs(argsJson);
  for (const field of SUMMARY_FIELDS) {
    const value = args[field];
    if (typeof value !== "string" || !value.trim()) continue;
    if (isSensitive(field, value)) return "*";
    const raw = field === "url" ? maskUrlUserinfo(value.trim()) : value.trim();
    return raw.replace(/\\/g, "/").slice(0, 200);
  }
  return "*";
}

/**
 * 分类一个工具调用，产出完整的 `HitlCall`。
 *
 * @param name OpenAI 格式工具名
 * @param argsJson 模型给的参数 JSON
 * @param source 工具来源（不传则按名字推断）
 * @param hints 外部风险标注（桥自带 meta / MCP annotations）
 */
export function classifyCall(
  name: string,
  argsJson: string,
  source?: HitlSource,
  hints?: HitlRiskHints,
): HitlCall {
  return {
    id: "",
    name,
    argsJson: argsJson ?? "",
    displayName: displayNameOf(name, hints),
    risk: resolveRisk(name, hints),
    summary: summarizeArgs(argsJson),
    source: source ?? sourceOf(name),
  };
}

/** 最小 tool_call 形状（避免 lib/hitl 依赖 agentStream 造成循环引用）。 */
export interface RawToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/**
 * 由原始 tool_call 造出 `HitlCall`。
 *
 * `id` 在这里才有意义（`classifyCall` 不知道模型的 tool_call id）。
 */
export function toHitlCall(call: RawToolCall, hints?: HitlRiskHints): HitlCall {
  const classified = classifyCall(call.function.name, call.function.arguments, undefined, hints);
  return { ...classified, id: call.id };
}
