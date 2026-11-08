/**
 * 本机智能体（d.113）：解析 `magpie ls` 的输出，供「智能体」分区展示与改模型。
 *
 * 只解析人类可读输出（该命令没有 JSON）：列之间是多个空格，最后一列是配置文件路径。
 * 解析不出来的行直接跳过，不猜。
 */

export interface LocalAgent {
  /** 展示名（Claude Code / Codex …）。 */
  name: string;
  /** magpie 命令里用的 id；没映射到就为 null（只读展示，不允许改写）。 */
  id: string | null;
  /** 当前模型（没有时为 —）。 */
  model: string;
  /** 推理强度/档位等附加信息（原样）。 */
  detail: string;
  /** 配置文件路径。 */
  configPath: string;
}

/** 展示名 → magpie agent id（只收录官方内置、且命令形态稳定的）。 */
const NAME_TO_ID: Record<string, string> = {
  "Claude Code": "claude",
  "Claude Desktop": "claude-desktop",
  Codex: "codex",
  "Gemini CLI": "gemini",
  OpenCode: "opencode",
  "MiMo Code": "mimo",
  Cursor: "cursor",
  "Cursor CLI": "cursor",
  "Copilot CLI": "copilot",
  Copilot: "copilot",
  Antigravity: "antigravity",
  "DeepSeek Harness": "dsh",
  WorkBuddy: "workbuddy",
  Qoder: "qoder",
  "Qoder CN": "qoder",
  Crush: "crush",
  Goose: "goose",
  Cline: "cline",
  Droid: "droid",
  Devin: "devin",
  Pi: "pi",
  Raft: "raft",
  AtomCode: "atomcode",
  "Command Code": "commandcode",
  CodeBuddy: "codebuddy",
  "Kimi Code": "kimi",
  Kiro: "kiro",
};

const PATH_LIKE = /^(~|[A-Za-z]:\\|\/).*/;

/** 解析 `magpie ls`：只保留有名字、有配置路径的行。 */
export function parseAgents(raw: string): LocalAgent[] {
  const agents: LocalAgent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(usage|magpie)\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const name = cols[0]!;
    const configPath = cols.length > 1 && PATH_LIKE.test(cols[cols.length - 1]!) ? cols[cols.length - 1]! : "";
    if (!configPath) continue;
    const middle = cols.slice(1, -1).join(" ");
    const [modelPart, ...detailParts] = middle.split("·");
    const model = (modelPart ?? "").trim() || "—";
    const detail = detailParts.join(" · ").trim();
    agents.push({
      name,
      id: NAME_TO_ID[name] ?? null,
      model,
      detail,
      configPath,
    });
  }
  return agents;
}

/** 给「应用」用的安全模型 id 校验（与主进程白名单同一口径）。 */
export function isModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,200}$/.test(value.trim());
}
