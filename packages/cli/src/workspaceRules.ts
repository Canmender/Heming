/**
 * CLI 侧读取工作区的权限规则（`.heming/permissions.json`）。
 *
 * 为什么 CLI 要认这份文件：Web 端早就把仓库里的规则接进闸门了（deny / ask 一定生效，
 * allow 需要用户信任过这个工作区），可 `heming run` 之前完全不看它——同一份
 * `{"deny":[{"tool":"run_command","command":"git push*"}]}`，在桌面里被拦住，
 * 在终端里却照跑。团队把规范写进仓库，结果只有一半入口遵守，这比没有规范更糟。
 *
 * 三条与 Web 端**逐字对齐**的口径：
 * - **deny 永远生效**：仓库自带，不需要信任；
 * - **ask 在 CLI 里落成拒绝**：这里没有人可以确认，「问」只能按不执行处理；
 * - **allow 需要显式信任**（`--trust-workspace`）：克隆一个陌生仓库时，
 *   它写的 `{"allow":[{"tool":"*"}]}` 不能自动放宽本机权限。
 *
 * 读不到文件（不存在 / 无权限）当「没有规则」；**读到了但内容坏了**是另一回事：
 * 返回 `ok:false`，调用方据此全部拒绝——只有在「能确定规则是什么」时才允许少拦。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  WORKSPACE_RULES_FILE,
  parseWorkspaceRules,
  type WorkspaceRulesConfig,
} from "../../../packages/web/src/lib/hitl/workspaceRules.js";

/** 规则文件大小上限：一份权限规则不该有几百 KB。 */
export const CLI_WORKSPACE_RULES_MAX_BYTES = 256 * 1024;

/** 加载成功后的规则集：配置 + 来源 + allow 是否生效。 */
export interface CliWorkspaceRuleSet {
  config: WorkspaceRulesConfig;
  /** 给人看的来源（相对工作区的路径）。 */
  source: string;
  /** 用户是否显式信任了这份规则（`--trust-workspace`）。 */
  trusted: boolean;
  /** allow 规则当前是否生效（现阶段等于 `trusted`）。 */
  allowActive: boolean;
}

/**
 * 加载结果。
 *
 * - `ok:true`：文件存在且解析成功（规则可以为空）；
 * - `ok:false`：文件存在但读不了 / 太大 / 解析失败 → 调用方必须全部拒绝；
 * - `null`：没有规则来源（文件不存在）。
 */
export type CliWorkspaceRulesLoad =
  | { ok: true; rules: CliWorkspaceRuleSet }
  | { ok: false; error: string; source: string }
  | null;

/** 规则文件的绝对路径（正斜杠）。 */
export function cliWorkspaceRulesPath(cwd: string): string {
  const root = path.resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  return `${root}/${WORKSPACE_RULES_FILE}`;
}

/** 读一份工作区权限规则；语义见文件头。 */
export async function loadCliWorkspaceRules(
  cwd: string,
  trusted: boolean,
): Promise<CliWorkspaceRulesLoad> {
  const file = cliWorkspaceRulesPath(cwd);
  const source = WORKSPACE_RULES_FILE;

  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    // 不存在 = 没有规则，这是常态（大多数仓库没有这份文件）。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, error: `读不到权限规则：${messageOf(error)}`, source };
  }
  if (!stat.isFile()) return { ok: false, error: "权限规则路径不是文件", source };
  if (stat.size > CLI_WORKSPACE_RULES_MAX_BYTES) {
    return {
      ok: false,
      error: `权限规则文件太大（${stat.size} 字节 > ${CLI_WORKSPACE_RULES_MAX_BYTES} 字节上限）`,
      source,
    };
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(file, "utf8");
  } catch (error) {
    return { ok: false, error: `读不到权限规则：${messageOf(error)}`, source };
  }

  /*
   * Windows 上很常见的一脚：记事本 / PowerShell 5 的 `Set-Content -Encoding utf8`
   * 会在文件开头写 UTF-8 BOM，`JSON.parse` 直接报 `Unexpected token ''`。
   * 规则是给人手写的，不该因为一个看不见的字节就让 CLI 拒绝启动。
   */
  const text = rawText.replace(/^\uFEFF/, "");

  const parsed = parseWorkspaceRules(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, source };

  return {
    ok: true,
    rules: {
      config: parsed.config,
      source,
      trusted,
      allowActive: trusted,
    },
  };
}

/** 一行说明：启动时打到 stderr，让用户知道这次跑受哪些规则约束。 */
export function describeCliWorkspaceRules(rules: CliWorkspaceRuleSet): string {
  const { allow, deny, ask, denyAll } = rules.config;
  const counts = `deny ${deny.length} / ask ${ask.length} / allow ${allow.length}`;
  const emergency = denyAll ? "；denyAll 已开启（所有工具调用都会被拒）" : "";
  const allowNote = rules.allowActive
    ? "；allow 已生效（--trust-workspace）"
    : "；allow 未生效（加 --trust-workspace 才放宽）";
  const source = rules.source;
  return `工作区权限规则：${counts}${emergency}${allowNote}（来自 ${source}）`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
