/**
 * 工作区权限规则（`.heming/permissions.json`）。
 *
 * 为什么要有这一层：HITL 现有的两条口子都是**个人**的——用户在弹窗里点「记住允许」
 * 存在 localStorage、档位也是个人设置。团队规范（「这个仓库不许写 .git」「跑 curl
 * 必须问我」）既不该依赖模型自觉，也不该让每个成员各点一遍弹窗。把它写成仓库里的
 * 文件，就能随代码一起版本化、评审、回滚。
 *
 * 语义与 Claude Code 的 `permissions.allow/deny/ask` 对齐：
 * - **deny 永远优先**：压过「记住的允许」、压过档位、压过 allow；
 * - **ask 强制询问**：即使策略层本来会免问（包括 trusted 档的会话授权）；
 * - **allow 自动放行**：只对 `read` / `write` 生效；`danger` 默认仍要问，
 *   除非该条规则显式写了 `"allowDanger": true`（危险操作要一条规则一条规则地放，
 *   不能因为写了个 `{"tool":"*"}` 就全局放行）。
 *
 * ★ **fail-closed 的口径**：
 * - 「没有规则」= 无桥 / 没有写根 / 文件不存在 / 读取失败 → `null`；
 * - 「有文件但内容坏了」= 解析失败 → `{ ok:false }`，闸门据此**全部拒绝**；
 * - 加载器本身抛错 → 闸门同样全部拒绝。
 * 只有在「能确定规则是什么」的时候才允许按规则少问/放行。
 *
 * ★ 这里只做纯逻辑 + 一个默认加载器；不引 React / store，可单测。
 * 需要导出的类型与函数都从本文件直接导出（`hitl/index.ts` 由另一条轨在改，暂不汇总）。
 */

import type { HitlCall } from "./types.js";
import {
  compareKey,
  foldSegments,
  isAbsolutePath,
  relFromRoot,
  toPosixPath,
  type FileRoot,
} from "../fileEdit/paths.js";
import { getFileBridge } from "../fileEdit/bridge.js";
import { currentFileRoots } from "../fileEdit/roots.js";

/** 规则文件相对工作区根的位置（固定契约）。 */
export const WORKSPACE_RULES_FILE = ".heming/permissions.json";

/** 单个文件最多接受的规则条数。 */
export const MAX_WORKSPACE_RULES = 200;

/** 默认加载器的缓存时长：5 秒。 */
export const WORKSPACE_RULES_CACHE_MS = 5_000;

/**
 * 「信任此工作区的权限规则」标记的存储键。
 *
 * 为什么 allow 规则需要信任：`.heming/permissions.json` 来自仓库，
 * 克隆一个陌生仓库时，里面的 allow 规则**不能**自动放宽本机权限
 * （`{"allow":[{"tool":"*"}]}` = 一份仓库就能把 HITL 关掉）。
 * deny / ask 是收紧方向，任何仓库里写了都直接生效；allow 只有用户
 * 显式信任过这个工作区之后才生效。
 */
export const WORKSPACE_RULES_TRUST_KEY = "heming.workspaceRules.trust.v1";

/** 工具名 / 路径 / 命令的长度上限：防止一份畸形文件把匹配拖慢。 */
const MAX_TOOL_CHARS = 200;
const MAX_PATTERN_CHARS = 500;

const NUL = "\u0000";

/**
 * 一条工作区规则。
 *
 * - `tool`：精确工具名、`*`（全部），或结尾 `*` 的前缀通配（如 `mcp__*`）。
 *   只支持 `*`，**不做正则**——规则文件随仓库分发，正则写错时的行为太难预期。
 * - `path`：可选，glob，**相对工作区根**、正斜杠。文件工具从参数里的
 *   `path` / `dir` / `file` 取目标再匹配。
 * - `command`：可选，glob，只对 `run_command` 的命令字符串生效（大小写不敏感）。
 * - `allowDanger`：可选，只有为 `true` 时该条 allow 才能放行 `danger` 调用。
 * - 同一规则同时写 `path` 与 `command` 时，两者都要命中才算命中。
 */
export interface WorkspaceRule {
  tool: string;
  path?: string;
  command?: string;
  allowDanger?: boolean;
}

/** 解析后的整份配置。 */
export interface WorkspaceRulesConfig {
  allow: WorkspaceRule[];
  deny: WorkspaceRule[];
  ask: WorkspaceRule[];
  /**
   * 紧急开关：为 `true` 时所有调用一律拒绝。
   *
   * 为什么要有：发现某个供应链工具正在作恶时，用户需要一条**立刻生效**的仓库级
   * 止血带（提交一个文件、等模型/团队同步即可），而不是逐个成员去点弹窗。
   */
  denyAll?: boolean;
}

/** 规则命中结果。`null` = 没有任何规则命中，交给原有策略判定。 */
export type WorkspaceRuleVerdict = "allow" | "deny" | "ask" | null;

/** 解析结果：失败时带原因，成功时带被丢弃的非法条目数。 */
export type WorkspaceRulesParseResult =
  | { ok: true; config: WorkspaceRulesConfig; invalid: number }
  | { ok: false; error: string };

/**
 * 加载结果。
 *
 * - `ok:true`：文件存在且解析成功（哪怕规则为空）；
 * - `ok:false`：文件存在但解析失败 → 调用方必须 **fail-closed**（全部拒绝）；
 * - `null`（加载器返回值）：没有规则来源（无桥 / 无写根 / 无文件 / 读失败）。
 *
 * `trusted` / `allowActive` 是给闸门与后续界面用的：`allow` 规则只有在用户
 * 信任过该工作区后才生效（见 `WORKSPACE_RULES_TRUST_KEY`）；未信任时
 * `allowActive:false`，闸门把 allow 回落成 ask（人工确认）。
 */
export type WorkspaceRulesLoad =
  | {
      ok: true;
      config: WorkspaceRulesConfig;
      invalid: number;
      source: string;
      /** 用户是否信任此工作区的权限规则（deny/ask 不需要信任，allow 需要）。 */
      trusted: boolean;
      /** allow 规则当前是否生效（现阶段等于 `trusted`，分开是为了将来可独立演进）。 */
      allowActive: boolean;
    }
  | { ok: false; error: string; source: string };

/** 规则匹配需要的上下文。 */
export interface WorkspaceMatchOptions {
  /** 当前生效的可写根（与文件工具、闸门共用 `currentFileRoots()` 的口径）。 */
  roots: FileRoot[];
}

/** 匹配结果。 */
export interface WorkspaceMatchResult {
  verdict: WorkspaceRuleVerdict;
  /** 命中说明（给人看：哪条规则、为什么）。 */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 工具名规整。
 *
 * 只接受三种形状：精确名、`*`、结尾带一个 `*` 的前缀（`mcp__*`）。
 * 中间的 `*`（`run_*cmd`）一律判非法：它看起来像通配，实际匹配不到任何东西，
 * 静默保留会让写规则的人以为生效了。
 */
function normalizeTool(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tool = raw.trim();
  if (!tool || tool.length > MAX_TOOL_CHARS || tool.includes(NUL)) return null;
  const star = tool.indexOf("*");
  if (star === -1) return tool;
  if (star !== tool.length - 1) return null;
  if (tool.slice(0, -1).includes("*")) return null;
  return tool;
}

/**
 * 规则路径规整：反斜杠 → 正斜杠、`./` 去前缀、压重复斜杠。
 *
 * 返回 `undefined` 表示字段本来就没写；`null` 表示写了但非法。
 * 绝对路径 / `..` 一律非法：规则路径的定义是「相对工作区根」，
 * 写绝对路径意味着这份规则换台机器就悄悄失效（或更糟：在别人机器上命中别的目录）。
 */
function normalizeRulePath(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.includes(NUL) || p.length > MAX_PATTERN_CHARS) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segs.length === 0) return null;
  if (segs.some((s) => s === "..")) return null;
  // `src/` 这种「只想写目录」的写法归一成 `src/**`：
  // 保持原样会永远匹配不到任何相对文件路径，属于静默失效，比报错更难发现。
  const hadTrailing = /\/$/.test(p);
  const joined = segs.join("/");
  return hadTrailing ? `${joined}/**` : joined;
}

/** 命令规整：只做 trim；命令里的反斜杠是内容，不能当路径分隔符改写。 */
function normalizeCommand(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const command = raw.trim();
  if (!command || command.length > MAX_PATTERN_CHARS || command.includes(NUL)) return null;
  return command;
}

/** 单条规则规整；非法返回 null。 */
function normalizeRule(raw: unknown): WorkspaceRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const tool = normalizeTool(item.tool);
  if (!tool) return null;
  const path = normalizeRulePath(item.path);
  if (path === null) return null;
  const command = normalizeCommand(item.command);
  if (command === null) return null;
  if (item.allowDanger !== undefined && typeof item.allowDanger !== "boolean") return null;
  return {
    tool,
    ...(path !== undefined ? { path } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(item.allowDanger === true ? { allowDanger: true } : {}),
  };
}

/**
 * 解析规则文件。
 *
 * 结构错误（不是 JSON / 顶层不是对象 / 三个分区不是数组 / `denyAll` 不是布尔）
 * → `ok:false`，调用方必须全部拒绝。单条规则错误 → 丢弃并计入 `invalid`
 * （这是规格明确要求的「坏条目逐条丢弃」，与整份文件结构损坏区分开）。
 *
 * ★ 解析顺序刻意是 **deny → ask → allow**：条数上限 200 时，保护性规则先占额度。
 * 反过来（按文件里  allow→deny→ask 的顺序）一份 allow 写了 200 条的仓库会把
 * 后面的 deny 全部挤掉——那是把上限变成一次静默的放宽，方向错了。
 */
export function parseWorkspaceRules(text: string): WorkspaceRulesParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `JSON 解析失败：${detail}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "顶层必须是 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of ["allow", "deny", "ask"] as const) {
    if (key in obj && !Array.isArray(obj[key])) {
      return { ok: false, error: `"${key}" 必须是数组` };
    }
  }
  if ("denyAll" in obj && typeof obj.denyAll !== "boolean") {
    return { ok: false, error: `"denyAll" 必须是布尔值` };
  }

  const config: WorkspaceRulesConfig = { allow: [], deny: [], ask: [] };
  let invalid = 0;
  let accepted = 0;
  for (const section of ["deny", "ask", "allow"] as const) {
    const list = obj[section];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const rule = normalizeRule(item);
      if (!rule || accepted >= MAX_WORKSPACE_RULES) {
        // 超过上限的条目同样丢弃并计数：加载结果里要能看出「这份文件没有被完整采用」。
        invalid += 1;
        continue;
      }
      config[section].push(rule);
      accepted += 1;
    }
  }
  if (obj.denyAll === true) config.denyAll = true;
  return { ok: true, config, invalid };
}

/* ------------------------------------------------------------------ */
/* 匹配                                                                */
/* ------------------------------------------------------------------ */

/** 正则转义（glob 里的其余字符按字面量处理）。 */
function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * glob → 正则。
 *
 * 路径模式（`segmentAware`）里 `*` 不跨 `/`、`**` 跨段；
 * 命令模式里两者都等于「任意字符」——命令里的 `/` 只是普通字符。
 * 大小写不敏感：项目既有的路径规则口径（`compareKey`）就是大小写不敏感，
 * Windows 文件系统本身也不区分；命令按规格要求大小写不敏感。
 */
function compileGlob(pattern: string, segmentAware: boolean): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      let stars = 1;
      while (pattern[i + 1] === "*") {
        stars += 1;
        i += 1;
      }
      if (!segmentAware) {
        out += ".*";
      } else if (stars >= 2) {
        // `**/` 可以匹配零层目录（`**/x` 命中 `x` 与 `a/b/x`）。
        if (pattern[i + 1] === "/") {
          out += "(?:.*/)?";
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += segmentAware ? "[^/]" : ".";
    } else {
      out += escapeRegExp(ch);
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

/** 工具名是否命中规则里的 `tool`。 */
function toolMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** 安全解析参数 JSON（与 classify/ruleTargets 同一口径：失败当空对象）。 */
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

/** 取第一个非空的字符串目标参数（path / dir / file 的固定顺序）。 */
function firstPathArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "dir", "file"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * 把调用里的路径参数换算成「相对工作区根」的形式。
 *
 * - 绝对路径：必须在某个根内（`relFromRoot`），否则算越界 → 不匹配任何 path 规则；
 * - 相对路径：折叠 `.`/`..`，折完仍以 `..` 开头即越界 → 不匹配。
 *
 * 为什么越界要算不匹配而不是直接拒绝：规则是「工作区里的规范」，
 * 工作区外的路径本来就不归它管；越界本身由现有 roots 机制拦。
 * 但 deny 的 `{"tool":"*"}`（不带 path）仍然会命中——那是工具级止损，不依赖路径。
 */
function relativePathOf(raw: string, roots: FileRoot[]): string | null {
  const p = toPosixPath(raw.trim());
  if (!p || p.includes(NUL)) return null;
  if (isAbsolutePath(p)) {
    for (const root of roots) {
      const rel = relFromRoot(root.path, p);
      if (rel !== null) return rel;
    }
    return null;
  }
  const folded = foldSegments(p);
  if (!folded || folded === ".." || folded.startsWith("../")) return null;
  return folded;
}

/** 一次调用的可匹配上下文（参数只解析一次）。 */
interface CallContext {
  relativePath: string | null;
  command: string | null;
}

function contextOf(call: HitlCall, roots: FileRoot[]): CallContext {
  const args = parseArgs(call.argsJson);
  const rawPath = firstPathArg(args);
  return {
    relativePath: rawPath ? relativePathOf(rawPath, roots) : null,
    command: typeof args.command === "string" && args.command.trim() ? args.command : null,
  };
}

/** 规则是否命中该调用（tool 必须命中；path/command 写了就必须命中）。 */
function ruleMatches(rule: WorkspaceRule, call: HitlCall, ctx: CallContext): boolean {
  if (!toolMatches(rule.tool, call.name)) return false;
  if (rule.path !== undefined) {
    if (ctx.relativePath === null) return false;
    if (!compileGlob(rule.path, true).test(ctx.relativePath)) return false;
  }
  if (rule.command !== undefined) {
    // `command` 只对 run_command 有意义：其它工具的参数里即使有同名字段，
    // 也不该被这条规则误伤（规则写的是「命令」，不是「任意参数里叫 command 的串」）。
    if (call.name !== "run_command") return false;
    if (ctx.command === null) return false;
    if (!compileGlob(rule.command, false).test(ctx.command)) return false;
  }
  return true;
}

/** 规则的人话描述（拒绝理由里要说清是哪一条）。 */
function describeRule(rule: WorkspaceRule): string {
  const parts = [`tool=${rule.tool}`];
  if (rule.path !== undefined) parts.push(`path=${rule.path}`);
  if (rule.command !== undefined) parts.push(`command=${rule.command}`);
  if (rule.allowDanger) parts.push("allowDanger");
  return `{ ${parts.join(", ")} }`;
}

/**
 * 判定一次调用是否命中工作区规则。
 *
 * 优先级固定 **deny > ask > allow**：
 * 团队规范里出现冲突的规则时，往「更不执行」的方向倒——
 * 同一路径既 allow 又 deny，唯一可预期的结果是 deny。
 */
export function matchWorkspaceRules(
  config: WorkspaceRulesConfig,
  call: HitlCall,
  opts: WorkspaceMatchOptions,
): WorkspaceMatchResult {
  if (config.denyAll) {
    return { verdict: "deny", reason: "denyAll 已开启（工作区权限规则紧急开关）" };
  }
  const ctx = contextOf(call, opts.roots ?? []);

  for (const rule of config.deny) {
    if (ruleMatches(rule, call, ctx)) {
      return { verdict: "deny", reason: `命中 deny 规则 ${describeRule(rule)}` };
    }
  }
  for (const rule of config.ask) {
    if (ruleMatches(rule, call, ctx)) {
      return { verdict: "ask", reason: `命中 ask 规则 ${describeRule(rule)}` };
    }
  }
  for (const rule of config.allow) {
    if (!ruleMatches(rule, call, ctx)) continue;
    /*
     * danger 的 allow 必须逐条显式开启。
     * 继续向后扫而不是直接返回 null：同一次调用可能同时命中「普通 allow」与
     * 「带 allowDanger 的 allow」，后者才是用户真正授权的形状。
     */
    if (call.risk === "danger" && rule.allowDanger !== true) continue;
    return { verdict: "allow", reason: `命中 allow 规则 ${describeRule(rule)}` };
  }
  return { verdict: null };
}

/* ------------------------------------------------------------------ */
/* 默认加载器                                                          */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  /** 缓存键：规则文件所在写根 + 信任状态（任一变化即失效）。 */
  key: string;
  at: number;
  value: WorkspaceRulesLoad | null;
}

/** 单条缓存：规则文件很小，按根切换时重新读即可，不需要 Map 堆历史根。 */
let cache: CacheEntry | null = null;

/** 清空缓存（测试用；将来的「重新加载规则」入口也可以调）。 */
export function clearWorkspaceRulesCache(): void {
  cache = null;
}

/** 规则文件的绝对路径（正斜杠、无重复斜杠）。 */
export function workspaceRulesPath(root: FileRoot): string {
  return `${toPosixPath(root.path).replace(/\/+$/, "")}/${WORKSPACE_RULES_FILE}`;
}

/** 信任标记的归一化键：与根口径一致（折 `..`、正斜杠、大小写不敏感）。 */
function trustKeyOf(rootPath: string): string {
  return compareKey(String(rootPath ?? "").trim());
}

function readTrustRaw(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(WORKSPACE_RULES_TRUST_KEY);
  } catch {
    return null;
  }
}

function writeTrustRaw(value: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(WORKSPACE_RULES_TRUST_KEY, value);
    return true;
  } catch {
    // 存不下就保持原样：宁可下次仍然未信任（需要人工再确认），
    // 也不要让「信任」只存在于本次进程，给用户一个不持久的假象。
    return false;
  }
}

function readTrustList(): string[] {
  const raw = readTrustRaw();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    // 损坏的信任表按「没有任何工作区被信任」处理——这是安全方向。
    return [];
  }
}

/**
 * 该工作区是否被用户信任其权限规则。
 *
 * 按根归一化路径存（`compareKey`）：`D:\项目\`、`D:/项目`、`d:/项目/`
 * 视为同一个工作区。任何存储异常一律返回 `false`（未信任是安全默认）。
 */
export function isWorkspaceRulesTrusted(rootPath: string): boolean {
  const key = trustKeyOf(rootPath);
  if (!key) return false;
  return readTrustList().includes(key);
}

/**
 * 设置 / 取消「信任此工作区的权限规则」。
 *
 * 只影响 allow / allowDanger：deny 与 ask 在未信任时同样生效（收紧方向不需要信任）。
 * 信任状态变化后清空加载缓存，避免最多 5 秒内仍按旧状态判定。
 */
export function setWorkspaceRulesTrusted(rootPath: string, trusted: boolean): void {
  const key = trustKeyOf(rootPath);
  if (!key) return;
  const list = new Set(readTrustList());
  if (trusted) list.add(key);
  else list.delete(key);
  if (!writeTrustRaw(JSON.stringify([...list]))) return;
  clearWorkspaceRulesCache();
}

/**
 * 读工作区根下的 `.heming/permissions.json`。
 *
 * 只读**第一条写根**：rules 是「这个工作区的规范」，读根里的同名文件不该生效
 * （否则同一台机器上共享的只读目录可以把规则塞进任何打开它的会话）。
 *
 * 返回 `null` 的情形（= 没有规则，按原有策略走）：
 * 浏览器端 / 老安装包没有桥、没有写根、文件不存在、读取失败、桥抛错。
 * 只有「读到了内容但解析失败」才返回 `{ ok:false }`（闸门据此全部拒绝）。
 *
 * 读取失败为什么也按「没有规则」而不是「全部拒绝」：网络盘掉线、权限临时不足
 * 都会让读盘失败；若因此把整个会话的所有工具全拒，用户会立刻失去工作能力。
 * 规格明确把 fail-closed 限定在「**有文件但解析失败**」——那是规则的表达出了问题，
 * 而不是规则不存在。
 */
export async function loadWorkspaceRules(): Promise<WorkspaceRulesLoad | null> {
  const bridge = getFileBridge();
  if (!bridge) return null;

  let roots: FileRoot[] = [];
  try {
    roots = currentFileRoots();
  } catch {
    return null;
  }
  const root = roots.find((r) => r.mode === "write");
  if (!root) return null;

  const source = workspaceRulesPath(root);
  const trusted = isWorkspaceRulesTrusted(root.path);
  // 信任状态也算进缓存键：用户在设置区切换信任后必须立刻按新状态判定，
  // 不能等 5 秒缓存过期（否则「我明明信任了还是弹窗」）。
  const cacheKey = `${compareKey(root.path)}|${trusted ? "trusted" : "untrusted"}`;
  const now = Date.now();
  if (cache && cache.key === cacheKey && now - cache.at < WORKSPACE_RULES_CACHE_MS) {
    return cache.value;
  }

  let value: WorkspaceRulesLoad | null;
  try {
    const res = await bridge.read({ roots, path: source });
    if (!res.ok) {
      value = null;
    } else {
      const parsed = parseWorkspaceRules(res.content);
      value = parsed.ok
        ? {
            ok: true,
            config: parsed.config,
            invalid: parsed.invalid,
            source,
            trusted,
            // 现阶段两者相同；将来若出现「用户级配置无需信任」等来源，
            // 只改这里，闸门不用动。
            allowActive: trusted,
          }
        : { ok: false, error: parsed.error, source };
    }
  } catch {
    // 桥抛错（IPC 断了 / 主进程异常）同样按「没有规则」：与读失败同一口径。
    value = null;
  }

  if (value && !value.ok) {
    console.warn(`[workspace-rules] ${value.source} 解析失败，本次调用将全部拒绝：${value.error}`);
  } else if (value?.ok && value.invalid > 0) {
    console.warn(`[workspace-rules] ${value.source} 有 ${value.invalid} 条非法规则已被丢弃`);
  }

  cache = { key: cacheKey, at: Date.now(), value };
  return value;
}
