/**
 * 工具 hooks 的桥编排（读配置、写 payload、跑命令、清临时文件）。
 *
 * 与 `hooks.ts` 的分工：那边是纯逻辑（可单测），这边只负责「用桌面端的文件桥/命令桥
 * 把一次 hook 真的跑起来」。桥的调用细节集中在这里，ChatPage 只接线一次。
 *
 * 口径：
 * - **只认工作区根**（`.heming/hooks.json`、payload 也写在工作区里）；
 * - 没有文件桥 / 命令桥 / 已授权写根 → 不启用，`/hooks` 如实说缺哪条通道；
 * - 配置读得到但解析失败 → fail-closed：所有被调用的工具都不执行，直到改好配置；
 * - 单条 hook 执行失败/超时 → 拒绝（fail-closed），不把「脚本挂了」当成放行。
 */

import type { FileFsBridge } from "../fileEdit/bridge.js";
import { resolveInsideRoot, toPosixPath, type FileRoot } from "../fileEdit/paths.js";
import type { StorageLike } from "../memory/types.js";
import type { ShellBridge } from "../shell/bridge.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  TOOL_HOOKS_CONFIG_REL,
  TOOL_HOOKS_TMP_REL,
  buildHookPayload,
  interpretHookResult,
  matchHooks,
  parseHooksConfig,
  type ToolHookDecision,
  type ToolHookRule,
} from "./hooks.js";

/** 配置加载状态。 */
export type ToolHooksLoadStatus = "ok" | "absent" | "error" | "unavailable";

/** 缺哪条通道（`unavailable` 时逐条说清，不笼统说「不支持」）。 */
export type ToolHooksMissing = "workspace" | "file" | "shell" | "write-root";

export interface ToolHooksState {
  /** 工作区根（绝对 posix；空串 = 未分组会话）。 */
  workspace: string;
  /** 配置文件的绝对路径（展示用；未分组时为空串）。 */
  configPath: string;
  status: ToolHooksLoadStatus;
  hooks: ToolHookRule[];
  /** `status=error` 时的原文（会直接展示在 `/hooks` 里）。 */
  error?: string;
  /** `status=unavailable` 时缺的通道。 */
  missing: ToolHooksMissing[];
  /**
   * 这个工作区是否被用户显式启用。
   *
   * 默认 **false**：`.heming/hooks.json` 是仓库内容，克隆一个恶意仓库不能让它的脚本
   * 在你打开智能体时自动执行。未启用时只加载/展示规则，一条也不跑，也不拦截工具
   * （工具照常走 HITL）——由用户在 `/hooks on` 时明确承担「允许本工区脚本在本机执行」。
   */
  enabled: boolean;
  /** 这次加载的时间（缓存失效判断用）。 */
  loadedAt: number;
}

export interface ToolHookRunnerDeps {
  getFileBridge: () => FileFsBridge | null;
  getShellBridge: () => ShellBridge | null;
  /** 会话工作区的文件根（与工具注入、`/status` 同源）。 */
  getRoots: (workspace: string) => readonly FileRoot[];
  /** 配置缓存时长；缺省 10 秒（改完 hooks.json 不该要求重启，也不该每个工具调用都读盘）。 */
  cacheTtlMs?: number;
  /**
   * 这个工作区是否已显式启用 hooks（缺省读 localStorage）。
   * 测试注入用；生产不要传——启用状态只有 `/hooks on|off` 一处写。
   */
  isEnabled?: (workspace: string) => boolean;
  /** 测试注入用。 */
  now?: () => number;
  newRunId?: () => string;
}

export interface ToolHooksRunContext {
  workspace?: string | null;
  agentId: string;
  streamId: string;
}

export interface ToolHookRunner {
  /** 读（或从缓存取）一次配置状态。`force` = 绕过缓存（`/hooks` 用）。 */
  load(workspace: string, opts?: { force?: boolean }): Promise<ToolHooksState>;
  /** 对一次工具调用执行所有命中的 hooks（按配置顺序，任一拒绝即停）。 */
  run(
    call: { name: string; arguments: string },
    ctx: ToolHooksRunContext,
  ): Promise<ToolHookDecision>;
  /** 清空缓存（工作区切换/测试用）。 */
  invalidate(): void;
}

const DEFAULT_CACHE_TTL_MS = 10_000;

/** 归一化工作区根：正斜杠、去尾斜杠。空串表示未分组会话。 */
function normalizeWorkspace(input: string | null | undefined): string {
  return toPosixPath(String(input ?? "")).replace(/\/+$/, "");
}

/* ───────────────────────── 显式启用（安全边界） ───────────────────────── */

/**
 * 「这个工作区的 hooks 已启用」的 localStorage 键。
 *
 * 值形如 `{"d:/work/repo": true}`。按**归一化后的工作区根**记，不按会话记：
 * 同一个仓库的多个会话共用一套规则，用户开一次就够；换仓库必须重新授权。
 */
export const HOOKS_ENABLED_KEY = "heming.hooks.enabled.v1";

function defaultHooksStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // 隐私模式/沙箱：读不到 = 没启用（默认安全）。
  }
}

function enabledKey(workspace: string): string {
  // 大小写不敏感：Windows 上同一目录可能写成 D:/Repo 或 d:/repo，不能因此绕过开关。
  return normalizeWorkspace(workspace).toLowerCase();
}

/** 读启用表（损坏/非对象一律当空 = 全部未启用）。 */
export function readHooksEnabled(
  storage: StorageLike | null = defaultHooksStorage(),
): Record<string, true> {
  if (!storage) return {};
  let raw: string | null = null;
  try {
    raw = storage.getItem(HOOKS_ENABLED_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true && key) map[key] = true;
    }
    return map;
  } catch {
    return {};
  }
}

/** 这个工作区是否被用户显式启用（默认 false）。 */
export function isToolHooksEnabled(
  workspace: string,
  storage: StorageLike | null = defaultHooksStorage(),
): boolean {
  const key = enabledKey(workspace);
  if (!key) return false;
  return readHooksEnabled(storage)[key] === true;
}

/**
 * 写入启用开关。返回是否真的持久化成功：
 * localStorage 不可用（隐私模式）时不能假装已启用——调用方要把失败说出来。
 */
export function setToolHooksEnabled(
  workspace: string,
  enabled: boolean,
  storage: StorageLike | null = defaultHooksStorage(),
): boolean {
  const key = enabledKey(workspace);
  if (!key || !storage) return false;
  const map = readHooksEnabled(storage);
  if (enabled) map[key] = true;
  else delete map[key];
  try {
    storage.setItem(HOOKS_ENABLED_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

let fallbackSeq = 0;
function defaultRunId(): string {
  fallbackSeq += 1;
  return `hook-${Date.now().toString(36)}-${fallbackSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 把判定包上规则信息：回灌给模型时要能看出「是哪条命令拦的」。 */
function withRule(rule: ToolHookRule, index: number, verdict: ToolHookDecision): ToolHookDecision {
  if (verdict.decision !== "deny") return verdict;
  const detail = verdict.reason ? `${verdict.reason}` : "拒绝";
  return { decision: "deny", reason: `第 ${index} 条 hook「${rule.command}」：${detail}` };
}

/**
 * 创建 hooks 运行器。缓存是单槽的（按工作区 + TTL 失效）：
 * 同一会话的工具调用频繁，每次读盘 + 解析都很浪费；而换工作区时必须重新读。
 */
export function createToolHookRunner(deps: ToolHookRunnerDeps): ToolHookRunner {
  const now = deps.now ?? Date.now;
  const newRunId = deps.newRunId ?? defaultRunId;
  const isEnabled = deps.isEnabled ?? ((workspace: string) => isToolHooksEnabled(workspace));
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached: ToolHooksState | null = null;

  async function readState(workspace: string): Promise<ToolHooksState> {
    const loadedAt = now();
    const base: ToolHooksState = {
      workspace,
      configPath: workspace ? `${workspace}/${TOOL_HOOKS_CONFIG_REL}` : "",
      status: "ok",
      hooks: [],
      missing: [],
      // 占位；`load` 每次都覆盖成最新开关状态，缓存不会让「/hooks off」迟生效。
      enabled: false,
      loadedAt,
    };
    if (!workspace) return { ...base, status: "unavailable", missing: ["workspace"] };

    const fileBridge = deps.getFileBridge();
    const shellBridge = deps.getShellBridge();
    const roots = [...deps.getRoots(workspace)];
    const missing: ToolHooksMissing[] = [];
    if (!fileBridge) missing.push("file");
    if (!shellBridge) missing.push("shell");
    if (!roots.some((root) => root.mode === "write")) missing.push("write-root");
    if (missing.length > 0) return { ...base, status: "unavailable", missing };

    const configAbs = resolveInsideRoot(workspace, TOOL_HOOKS_CONFIG_REL);
    if (!configAbs) {
      return {
        ...base,
        status: "error",
        error: `工作区路径无法解析出 ${TOOL_HOOKS_CONFIG_REL}：${workspace}`,
      };
    }

    let content: string;
    try {
      const res = await fileBridge!.read({ roots, path: configAbs });
      if (!res.ok) {
        if (res.code === "not-found") return { ...base, status: "absent" };
        return {
          ...base,
          status: "error",
          error: `读取 ${TOOL_HOOKS_CONFIG_REL} 失败（${res.code ?? "io"}）：${res.error}`,
        };
      }
      content = typeof res.content === "string" ? res.content : "";
    } catch (err) {
      return {
        ...base,
        status: "error",
        error: `读取 ${TOOL_HOOKS_CONFIG_REL} 失败：${(err as Error)?.message ?? String(err)}`,
      };
    }

    const parsed = parseHooksConfig(content);
    if (!parsed.ok) return { ...base, status: "error", error: parsed.error };
    return { ...base, status: "ok", hooks: parsed.hooks };
  }

  async function load(workspaceInput: string, opts?: { force?: boolean }): Promise<ToolHooksState> {
    const workspace = normalizeWorkspace(workspaceInput);
    if (
      !opts?.force &&
      cached &&
      cached.workspace === workspace &&
      now() - cached.loadedAt < ttl
    ) {
      // 配置可以缓存，开关不能：用户刚发 `/hooks off`，下一次工具调用必须立刻不再执行。
      return { ...cached, enabled: isEnabled(workspace) };
    }
    const state = await readState(workspace);
    cached = state;
    return { ...state, enabled: isEnabled(workspace) };
  }

  /**
   * 跑一条 hook。payload 文件在一次判定结束后删除；删除失败只留调试日志，
   * 不改变判定（判定必须与工具是否执行一致，不能因为清理失败又反过来放行）。
   */
  async function runRule(
    rule: ToolHookRule,
    index: number,
    call: { name: string; arguments: string },
    ctx: ToolHooksRunContext,
    workspace: string,
  ): Promise<ToolHookDecision> {
    const fileBridge = deps.getFileBridge();
    const shellBridge = deps.getShellBridge();
    if (!fileBridge || !shellBridge) {
      return {
        decision: "deny",
        reason: `hook「${rule.command}」无法执行：运行时缺少${!fileBridge ? "文件桥" : ""}${
          !fileBridge && !shellBridge ? "与" : ""
        }${!shellBridge ? "命令桥" : ""}`,
      };
    }
    const roots = [...deps.getRoots(workspace)];
    const runId = newRunId();
    const payloadAbs = resolveInsideRoot(
      workspace,
      `${TOOL_HOOKS_TMP_REL}/${runId}.json`,
    );
    if (!payloadAbs) {
      return {
        decision: "deny",
        reason: `hook「${rule.command}」无法执行：payload 路径不合法（工作区 ${workspace}）`,
      };
    }

    const payload = buildHookPayload({
      name: call.name,
      arguments: call.arguments,
      workspace,
      agentId: ctx.agentId,
      streamId: ctx.streamId,
      time: new Date(now()),
    });

    let wrote = false;
    try {
      const write = await fileBridge.write({
        roots,
        ops: [{ kind: "write", path: payloadAbs, content: JSON.stringify(payload, null, 2) }],
        createParents: true,
      });
      const first = write.results?.[0];
      if (!write.ok || first?.ok === false) {
        return {
          decision: "deny",
          reason: `hook「${rule.command}」无法执行：payload 临时文件写入失败（${
            first?.error ?? write.error ?? "未知原因"
          }）`,
        };
      }
      wrote = true;

      let res;
      try {
        res = await shellBridge.run({
          runId,
          roots,
          // 命令在工作区根执行；桌面端要求绝对路径（不接受「自己猜一个根」）。
          cwd: workspace,
          // 契约：命令末尾追加 payload 文件路径作为第一个参数。
          command: `${rule.command} "${payloadAbs}"`,
          timeoutMs: rule.timeoutMs,
        });
      } catch (err) {
        return {
          decision: "deny",
          reason: `hook「${rule.command}」执行失败（起不来）：${(err as Error)?.message ?? String(err)}`,
        };
      }

      if (!res.ok) {
        if (res.code === "timeout") {
          return {
            decision: "deny",
            reason: `hook「${rule.command}」执行失败（超时，上限 ${rule.timeoutMs}ms）`,
          };
        }
        if (res.code === "aborted") {
          return {
            decision: "deny",
            reason: `hook「${rule.command}」执行被中止：${res.error}`,
          };
        }
        return {
          decision: "deny",
          reason: `hook「${rule.command}」执行失败（${res.code}）：${res.error}`,
        };
      }

      return withRule(
        rule,
        index,
        interpretHookResult(res.exitCode, res.stdout, res.stderr, false),
      );
    } catch (err) {
      return {
        decision: "deny",
        reason: `hook「${rule.command}」执行失败：${(err as Error)?.message ?? String(err)}`,
      };
    } finally {
      if (wrote) {
        try {
          const cleanup = await fileBridge.write({
            roots,
            ops: [{ kind: "delete", path: payloadAbs }],
          });
          if (!cleanup.ok) {
            // 删不掉不影响判定，但要知道临时目录在变脏。
            console.warn("[hooks] payload 临时文件删除失败", payloadAbs, cleanup.error);
          }
        } catch (err) {
          console.warn("[hooks] payload 临时文件删除失败", payloadAbs, err);
        }
      }
    }
  }

  async function run(
    call: { name: string; arguments: string },
    ctx: ToolHooksRunContext,
  ): Promise<ToolHookDecision> {
    const workspace = normalizeWorkspace(ctx.workspace);
    /**
     * 未显式启用：**一条也不跑，也不拦截**。
     *
     * `.heming/hooks.json` 跟着仓库走，克隆一个恶意仓库不能让它在你打开智能体时
     * 自动执行命令。未启用时工具照常走 HITL；`/hooks` 仍可加载并展示规则，
     * 让用户看清「启用后会跑什么」再决定。
     */
    if (!isEnabled(workspace)) return { decision: "allow" };
    let state: ToolHooksState;
    try {
      state = await load(workspace);
    } catch (err) {
      // 读配置本身炸了：fail-closed，但不能说成用户拒绝。
      return {
        decision: "deny",
        reason: `hooks 配置加载失败：${(err as Error)?.message ?? String(err)}`,
      };
    }

    if (state.status === "unavailable" || state.status === "absent") {
      return { decision: "allow" };
    }
    if (state.status === "error") {
      return {
        decision: "deny",
        reason: `hooks 配置有误（在改好 ${TOOL_HOOKS_CONFIG_REL} 之前，所有工具调用都会被拒绝）：${
          state.error ?? "未知错误"
        }`,
      };
    }
    if (state.hooks.length === 0) return { decision: "allow" };

    const matched = matchHooks(state.hooks, call, workspace);
    if (matched.length === 0) return { decision: "allow" };

    // 顺序即配置顺序；任一拒绝立即停下——后面的 hook 不再跑（与设计契约一致）。
    for (const rule of matched) {
      const index = state.hooks.indexOf(rule) + 1;
      const verdict = await runRule(rule, index, call, ctx, workspace);
      if (verdict.decision === "deny") return verdict;
    }
    return { decision: "allow" };
  }

  return {
    load,
    run,
    invalidate: () => {
      cached = null;
    },
  };
}

const MISSING_LABEL: Record<ToolHooksMissing, string> = {
  workspace: "工作区",
  file: "文件桥",
  shell: "命令桥",
  "write-root": "工作区写根（只读根无法放 payload）",
};

/**
 * `/hooks` 的输出：启用状态、配置路径、加载到几条、每条规则一行、桥是否可用、配置错误原文。
 *
 * 只报事实：缺通道时明说「未启用」，开关没开时也绝不能写成「已生效」。
 */
export function describeToolHooksState(state: ToolHooksState): string {
  const lines: string[] = [];
  lines.push(`Hooks 配置：${state.configPath || "（未分组会话没有工作区，不加载 hooks）"}`);
  lines.push(
    state.enabled
      ? "状态：已启用（匹配的工具调用会先跑下面的本机命令；任一拒绝即不执行工具）。"
      : "状态：未启用（默认）——只展示规则，不执行任何 hook，也不拦截工具（工具照常走人工确认）。",
  );

  if (state.status === "unavailable") {
    lines.push(
      `缺少${state.missing.map((item) => MISSING_LABEL[item]).join("、")}。`,
      "（浏览器或旧桌面端没有这些通道；hooks 不会假装已启用。）",
    );
    return lines.join("\n");
  }

  if (state.status === "absent") {
    lines.push(
      "工作区里还没有 .heming/hooks.json。",
      "新建它之后，匹配的工具调用会先执行本机命令；命令末尾会追加 payload JSON 文件路径作为第一个参数。",
    );
    if (!state.enabled) {
      lines.push("要真正执行规则，先发 `/hooks on`（这会允许本工区的钩子脚本在你的机器上执行）。");
    }
    return lines.join("\n");
  }

  if (state.status === "error") {
    lines.push(
      state.enabled
        ? "配置错误（fail-closed）：在改好之前，所有工具调用都不会执行。"
        : "配置有误（当前未启用，所以不会拦截；但启用后所有工具调用都会被拒绝，建议先改好再开）。",
      `错误：${state.error ?? "未知错误"}`,
    );
    return lines.join("\n");
  }

  if (state.hooks.length === 0) {
    lines.push(`已加载 0 条规则（${TOOL_HOOKS_CONFIG_REL} 存在，但没有规则）。`);
  } else {
    lines.push(`已加载 ${state.hooks.length} 条规则（按配置顺序执行）：`);
    state.hooks.forEach((rule, index) => {
      const path = rule.path ? `路径 ${rule.path}` : "任意路径";
      const command = rule.command.length > 100 ? `${rule.command.slice(0, 99)}…` : rule.command;
      lines.push(
        `  ${index + 1}. 工具 ${rule.tool.join("、")} · ${path} · 命令 ${command} · 超时 ${
          rule.timeoutMs || DEFAULT_HOOK_TIMEOUT_MS
        }ms`,
      );
    });
  }
  if (!state.enabled) {
    lines.push(
      "要真正执行规则，发 `/hooks on`。注意：这会允许本工区的钩子脚本在你的机器上执行；`/hooks off` 随时收回。",
    );
  }
  lines.push(
    "判定：退出码 0 放行；2 拒绝（原因取 stdout/stderr 第一行）；其它非零或超时一律按拒绝。stdout 为 {\"decision\":\"allow|deny\",\"reason\":\"...\"} 时优先按它。",
  );
  return lines.join("\n");
}
