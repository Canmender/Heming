/**
 * 工具执行前的确定性 hooks（对标 Claude Code 的 PreToolUse hooks）。
 *
 * ## 为什么要有这一层
 *
 * 到这一版为止，团队规范只有两条路进模型：写进提示词（靠模型自觉），或者
 * HITL 让用户逐个点确认（靠人盯）。前者对「不许改 generated/**」「提交前必须跑
 * lint」这类硬规矩不成立——模型可能忘、也可能选择不遵守；后者在长任务里会把
 * 用户变成收费站。hooks 把规矩落成**确定性闸门**：命中的工具调用先跑一条本机命令，
 * 命令说不行就不执行。
 *
 * ## 本文件的口径
 *
 * - 纯逻辑：不读磁盘、不碰 localStorage、不依赖 window（桥的编排在 `hookRunner.ts`）。
 *   这样解析、匹配、判定都能单测，不需要渲染或桌面端。
 * - **只认工作区的 `.heming/hooks.json`**：不扫用户目录。文件桥只能读用户授权过的根，
 *   去读用户目录既做不到、也不该做——克隆来的仓库不能顺带改用户全局的执行策略。
 * - 配置错误 **fail-closed**：解析失败/字段非法时，调用方按「本轮工具不执行」处理，
 *   而不是「忽略这段配置继续跑」。
 * - 命令约定：调用方在 `command` 末尾追加 **payload JSON 文件的路径**作为第一个参数。
 *   规则作者写 `node scripts/check.js` 就能拿到 `process.argv[2]`。
 */

import { compareKey, foldSegments, isAbsolutePath, toPosixPath } from "../fileEdit/paths.js";
import { GIT_UNCHANGED } from "./text.js";

/** 工作区里的配置路径（相对工作区根，正斜杠）。 */
export const TOOL_HOOKS_CONFIG_REL = ".heming/hooks.json";

/** 临时 payload 文件的目录（相对工作区根）。 */
export const TOOL_HOOKS_TMP_REL = ".heming/hooks/.tmp";

/** 最多允许的规则条数：hooks 是同步闸门，条数一多每个工具调用都像卡住。 */
export const MAX_TOOL_HOOKS = 20;

/** 单条 hook 的默认超时。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** 单条 hook 的超时上限：再长就不该叫「执行前检查」了。 */
export const MAX_HOOK_TIMEOUT_MS = 15_000;

/** 拒绝原因的最大长度（回灌给模型的文本要短到能读完）。 */
export const MAX_HOOK_REASON_CHARS = 300;

/**
 * 一条已解析的 hook 规则。
 *
 * `tool` 一律归一化成数组（配置里允许写单个字符串）；`path` 保留用户写的形态，
 * 匹配时再归一化——展示配置时不应悄悄改掉用户写的东西。
 */
export interface ToolHookRule {
  /** 精确工具名或 `*`（不做隐式通配：`mcp__*` 只匹配字面量 `mcp__*`）。 */
  tool: string[];
  /** 可选路径 glob（相对工作区根，正斜杠）。 */
  path?: string;
  /** 本机命令；调用时末尾会追加 payload 文件路径。 */
  command: string;
  /** 超时（毫秒），已夹在 `[1, MAX_HOOK_TIMEOUT_MS]` 内的合法值。 */
  timeoutMs: number;
}

export type ParseHooksResult =
  | { ok: true; hooks: ToolHookRule[] }
  | { ok: false; error: string };

/** 工具调用里参与匹配的最小形状（与 `agentStream` 的调用一致）。 */
export interface HookCall {
  name: string;
  /** 原始参数 JSON 字符串（可能是半截/空串，解析失败只影响 path 匹配）。 */
  arguments: string;
}

/** 一次 payload 的结构（写进工作区里的临时 JSON 文件）。 */
export interface ToolHookPayload {
  event: "PreToolUse";
  tool: { name: string; arguments: string };
  /** 工作区根的绝对 posix 路径。 */
  workspace: string;
  agentId: string;
  streamId: string;
  /** ISO 时间戳。 */
  time: string;
}

/** hook 的判定结果（`reason` 只在拒绝时有意义）。 */
export interface ToolHookDecision {
  decision: "allow" | "deny";
  reason?: string;
}

/** 取第一个非空行并截断：退出码 2 的 stdout/stderr 往往带堆栈，模型只需要第一句。 */
function firstLine(text: string, max = MAX_HOOK_REASON_CHARS): string {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

/** 去首尾空白、折叠内部空白（配置里的命令/路径按一行展示）。 */
function oneLine(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 解析 `.heming/hooks.json` 的正文。
 *
 * 只接受 `{"hooks": [...]}` 这一种形状（与设计契约一致）。任何结构/字段问题都返回
 * `{ok:false}` 并说明**第几条、哪个字段、怎么改**——调用方会把原文展示到 `/hooks`
 * 里，用户不该靠猜来修 JSON。
 *
 * 空文件/纯空白视为「零条规则」：新建但还没填的文件不该让所有工具不可用。
 */
export function parseHooksConfig(text: string): ParseHooksResult {
  const raw = String(text ?? "");
  if (!raw.trim()) return { ok: true, hooks: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `hooks.json 不是合法 JSON：${(err as Error).message}。请检查逗号、引号和括号（JSON 不支持注释）。`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "hooks.json 的根必须是对象，形如 {\"hooks\": [...]}。" };
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.hooks)) {
    return {
      ok: false,
      error: "hooks.json 缺少 hooks 数组：形如 {\"hooks\": [{\"match\": {...}, \"command\": \"...\"}]}。",
    };
  }
  if (root.hooks.length > MAX_TOOL_HOOKS) {
    return {
      ok: false,
      error: `hooks 最多允许 ${MAX_TOOL_HOOKS} 条规则，当前有 ${root.hooks.length} 条（每个工具调用都会依次跑它们，太多就不该叫「执行前检查」了）。`,
    };
  }

  const hooks: ToolHookRule[] = [];
  for (let i = 0; i < root.hooks.length; i += 1) {
    const where = `第 ${i + 1} 条规则`;
    const entry = root.hooks[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `${where}必须是对象（至少包含 match 与 command）。` };
    }
    const rule = entry as Record<string, unknown>;

    const match = rule.match;
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      return {
        ok: false,
        error: `${where}缺少 match 对象：形如 "match": {"tool": "file_write", "path": "src/**"}。`,
      };
    }
    const matchObj = match as Record<string, unknown>;

    let tool: string[];
    if (typeof matchObj.tool === "string") {
      const name = matchObj.tool.trim();
      if (!name) return { ok: false, error: `${where}的 match.tool 不能是空字符串。` };
      tool = [name];
    } else if (Array.isArray(matchObj.tool)) {
      if (matchObj.tool.length === 0) {
        return { ok: false, error: `${where}的 match.tool 数组不能为空（至少要写一个工具名或 "*"）。` };
      }
      tool = matchObj.tool.map((item) => (typeof item === "string" ? item.trim() : ""));
      if (tool.some((name) => !name)) {
        return { ok: false, error: `${where}的 match.tool 数组里每一项都必须是非空字符串。` };
      }
    } else {
      return {
        ok: false,
        error: `${where}缺少 match.tool：写工具名、工具名数组，或 "*" 表示所有工具。`,
      };
    }

    let path: string | undefined;
    if (matchObj.path !== undefined) {
      if (typeof matchObj.path !== "string" || !matchObj.path.trim()) {
        return { ok: false, error: `${where}的 match.path 必须是非空字符串（相对工作区根，如 "src/**"）。` };
      }
      path = oneLine(matchObj.path);
    }

    if (typeof rule.command !== "string" || !rule.command.trim()) {
      return {
        ok: false,
        error: `${where}缺少 command：写一条要在工作区根执行的本机命令（会追加 payload 文件路径作为第一个参数）。`,
      };
    }
    const command = rule.command.trim();

    let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
    if (rule.timeoutMs !== undefined) {
      if (typeof rule.timeoutMs !== "number" || !Number.isFinite(rule.timeoutMs) || rule.timeoutMs <= 0) {
        return {
          ok: false,
          error: `${where}的 timeoutMs 必须是正数（毫秒），缺省 ${DEFAULT_HOOK_TIMEOUT_MS}。`,
        };
      }
      if (rule.timeoutMs > MAX_HOOK_TIMEOUT_MS) {
        return {
          ok: false,
          error: `${where}的 timeoutMs 不能超过 ${MAX_HOOK_TIMEOUT_MS} 毫秒（执行前检查不该比工具本身还久）。`,
        };
      }
      timeoutMs = Math.round(rule.timeoutMs);
    }

    hooks.push({
      tool,
      ...(path !== undefined ? { path } : {}),
      command,
      timeoutMs,
    });
  }

  return { ok: true, hooks };
}

/**
 * 把 glob 转成正则。
 *
 * 支持 `*`（不跨 `/`）、`**`（跨段）、`?`（单个非 `/` 字符）。刻意不引第三方依赖：
 * 这是安全边界上的匹配，依赖的语义变化不该悄悄改变「哪些调用会被拦」。
 *
 * `src/**` 同时匹配 `src` 本身（目录参数常见）；`**` 后跟 `/` 匹配任意深度。
 * 匹配大小写不敏感：Windows 路径本身不区分大小写，规则不该因为盘符/目录大小写而失效。
 */
export function globToRegExp(pattern: string): RegExp {
  const p = toPosixPath(pattern)
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const atSegmentStart = i === 0 || p[i - 1] === "/";
        const followedBySlash = p[i + 2] === "/";
        if (atSegmentStart && followedBySlash) {
          // `**/`：零个或多个目录段（`**/x` 也能匹配根下的 x）。
          re += "(?:[^/]+/)*";
          i += 2;
        } else if (atSegmentStart && i + 2 === p.length) {
          // 结尾的 `**`：`src/**` 同时匹配 `src` 与 `src/...`。
          if (re.endsWith("/")) re = re.slice(0, -1);
          re += "(?:/.*)?";
          i += 1;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/** 一个候选路径是否命中规则里的 glob。 */
export function matchPathGlob(pattern: string, candidate: string): boolean {
  if (!pattern || !candidate) return false;
  return globToRegExp(pattern).test(
    toPosixPath(candidate).replace(/^\.\//, "").replace(/^\/+/, ""),
  );
}

/**
 * 从工具参数里取路径 / 目录。
 *
 * 按设计契约只看 `path`、`dir`、`file` 三个字段（各工具的参数形状不同；
 * 命令类工具的 `cwd` 是工作目录不是目标路径，不在此列）。
 * 没有路径参数的调用（例如 `run_command`）不会命中带 path 的规则。
 */
export function extractToolPath(argsJson: string): string | null {
  const raw = typeof argsJson === "string" ? argsJson.trim() : "";
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 模型给了半截 JSON：path 规则不匹配，无 path 的规则仍可命中。
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const args = parsed as Record<string, unknown>;
  for (const key of ["path", "dir", "file"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * 把工具参数里的路径换算成「相对工作区根」的正斜杠路径。
 *
 * - 反斜杠统一成正斜杠（Windows 上模型两种写法都有）；
 * - 绝对路径必须落在工作区内，否则返回 null（根外路径不参与任何 path 规则匹配；
 *   它本来也会被文件桥拦掉）；
 * - 相对路径折掉 `.`/`..`；折完仍在工作区外（`../x`）同样返回 null。
 */
export function workspaceRelativePath(candidate: string, workspace: string): string | null {
  const value = toPosixPath(candidate).trim();
  if (!value) return null;
  if (isAbsolutePath(value)) {
    const ws = toPosixPath(workspace).replace(/\/+$/, "");
    if (!ws) return null;
    const wsKey = compareKey(ws);
    const valueKey = compareKey(value);
    if (valueKey === wsKey) return "";
    if (!valueKey.startsWith(`${wsKey}/`)) return null;
    return foldSegments(value).slice(ws.length + 1);
  }
  const folded = foldSegments(value).replace(/^\.\//, "");
  if (!folded || folded === "." || folded === ".." || folded.startsWith("../")) return null;
  return folded;
}

/**
 * 找出命中的规则（按配置顺序；调用方按这个顺序依次执行）。
 *
 * 工具名是**精确匹配**或 `*`：`mcp__*` 不会隐式匹配 `mcp__foo`——隐式通配会让
 * 用户以为只拦了前缀，实际拦了一片；要拦前缀就写多条或明确列出。
 */
export function matchHooks(
  hooks: readonly ToolHookRule[],
  call: HookCall,
  workspace: string,
): ToolHookRule[] {
  const toolName = typeof call?.name === "string" ? call.name : "";
  const candidate = extractToolPath(call?.arguments ?? "");
  const rel = candidate ? workspaceRelativePath(candidate, workspace) : null;
  return hooks.filter((rule) => {
    const toolHit = rule.tool.includes("*") || rule.tool.includes(toolName);
    if (!toolHit) return false;
    if (!rule.path) return true;
    // 有 path 规则但这次调用没有路径参数（或路径在工作区外）：不匹配。
    return rel !== null && rel !== "" && matchPathGlob(rule.path, rel);
  });
}

/**
 * 组装 payload（写进临时 JSON 文件的内容）。
 *
 * `arguments` 保留模型给的**原始字符串**而不是再序列化一遍：hook 脚本要能检查
 * 「模型实际发了什么」，二次序列化会把字段顺序、空白、数字格式都改掉。
 */
export function buildHookPayload(input: {
  name: string;
  arguments: string;
  workspace: string;
  agentId: string;
  streamId: string;
  time?: Date;
}): ToolHookPayload {
  const time = input.time instanceof Date ? input.time : new Date();
  return {
    event: "PreToolUse",
    tool: {
      name: String(input.name ?? ""),
      arguments: typeof input.arguments === "string" ? input.arguments : "",
    },
    workspace: toPosixPath(input.workspace ?? "").replace(/\/+$/, ""),
    agentId: String(input.agentId ?? ""),
    streamId: String(input.streamId ?? ""),
    time: Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString(),
  };
}

/**
 * stdout 里的机器可读判定：`{"decision":"allow|deny","reason":"..."}`。
 *
 * 只有整个 stdout 是一个合法 JSON 对象、且 `decision` 是这两个值之一才算数；
 * 其它内容（普通日志、半截 JSON）一律忽略，回落到退出码语义——hook 脚本打日志
 * 是常态，不能因为打了日志就被当成分歧。
 */
function parseStdoutDecision(stdout: string): ToolHookDecision | null {
  const raw = String(stdout ?? "").trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.decision !== "allow" && obj.decision !== "deny") return null;
  if (obj.decision === "allow") return { decision: "allow" };
  const reason = typeof obj.reason === "string" ? firstLine(obj.reason) : "";
  return {
    decision: "deny",
    ...(reason ? { reason } : {}),
  };
}

/**
 * 解释一次 hook 执行的结果。
 *
 * 优先级：**超时 > stdout JSON > 退出码**。
 *
 * - 超时永远拒绝（fail-closed）：进程没跑完，它前面打的 `allow` 不能当数；
 * - 退出码 0 放行；
 * - 退出码 2 拒绝，原因取 stdout/stderr 第一条非空行（截断 300 字）；
 * - 其它非零 / 被信号杀掉 → 拒绝：**执行失败不是放行理由**，尤其不能让一个
 *   「脚本路径写错了」的配置变成静默全放行。
 */
export function interpretHookResult(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean,
): ToolHookDecision {
  if (timedOut) {
    return { decision: "deny", reason: "hook 执行失败（超时，未在时限内结束）" };
  }
  const machine = parseStdoutDecision(stdout);
  if (machine) return machine;
  if (exitCode === 0) return { decision: "allow" };
  if (exitCode === 2) {
    const reason = firstLine(stdout) || firstLine(stderr);
    return {
      decision: "deny",
      reason: reason || "hook 命令以退出码 2 拒绝了本次调用（没有给出原因）",
    };
  }
  if (exitCode === null) {
    return { decision: "deny", reason: "hook 执行失败（进程被信号终止）" };
  }
  const detail = firstLine(stderr) || firstLine(stdout);
  return {
    decision: "deny",
    reason: `hook 执行失败（退出码 ${exitCode}）${detail ? `：${detail}` : ""}`,
  };
}

/**
 * 被 hook 拒绝时回给模型的文案。
 *
 * 与用户拒绝/规则拒绝的区别必须写清：模型不能把「仓库里的检查没过」理解成
 *「用户不让我做」，否则下一轮会去劝用户而不是改参数。同时必须带上
 *「未修改」硬声明（与 HITL 同一口径），否则模型会以为写了一半。
 */
export function hookDeniedText(info: {
  toolName: string;
  command?: string;
  ruleIndex?: number;
  reason?: string;
}): string {
  const lines = [
    `本次工具调用被工作区的 hooks 拒绝，未执行：${info.toolName || "（未命名工具）"}`,
    GIT_UNCHANGED,
    "不存在部分写入或中间状态，该调用没有产生任何副作用。",
    "这不是用户的选择，而是 `.heming/hooks.json` 里声明的本机检查拒绝了它。",
    "不要原样重试；先按下面的原因调整参数或改法，必要时再请用户修改 hooks 配置。",
  ];
  if (info.ruleIndex !== undefined && info.ruleIndex > 0) {
    lines.push(`命中的规则：第 ${info.ruleIndex} 条`);
  }
  if (info.command) lines.push(`hook 命令：${oneLine(info.command)}`);
  if (info.reason) lines.push(`拒绝原因：${oneLine(info.reason)}`);
  return lines.join("\n");
}
