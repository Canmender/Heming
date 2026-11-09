/**
 * 模型页 ↔ 内核命令桥的渲染层封装（d.99）。
 *
 * 「模型」页把 magpie 的管理能力（供应商 / 订阅账号 / 分组 / 用量 / 库 / 备份 / 同步）
 * 直接交给内核 CLI 执行：能力的实现只有一份，页面只负责输入与展示。
 * 浏览器端没有这个桥 → 页面显示「仅桌面端可用」，但网关状态/模型目录仍可看。
 */

export interface MagpieCliResult {
  ok: boolean;
  code?: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type MagpieCliEventType = "start" | "stdout" | "stderr";

export interface MagpieCliEvent {
  runId: string;
  type: MagpieCliEventType;
  text?: string;
  args?: string[];
}

export interface CloudBackupFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export interface MagpieCliBridge {
  cli(args: string[]): Promise<MagpieCliResult>;
  cliStart(args: string[]): Promise<{ ok: boolean; error?: string }>;
  /** 立刻返回 runId（交互式命令用），输出经 onCli 事件回流。 */
  cliBegin(args: string[]): Promise<{ ok: boolean; runId?: string; error?: string }>;
  cliInput(runId: string, text: string): Promise<boolean>;
  cliKill(runId: string): Promise<boolean>;
  openTerminal(args: string[]): Promise<{ ok: boolean; error?: string }>;
  /** 应用自己的备份目录与已有备份文件。 */
  backupInfo(): Promise<{ dir: string; files: CloudBackupFile[] }>;
  /** 选一个备份文件（系统文件选择器）；取消返回 null。 */
  backupPick(): Promise<string | null>;
  onCli(callback: (event: MagpieCliEvent) => void): () => void;
}

type BridgeWindow = {
  __heming_magpie?: {
    cli?: unknown;
    cliStart?: unknown;
    cliBegin?: unknown;
    backupInfo?: unknown;
    backupPick?: unknown;
    cliInput?: unknown;
    cliKill?: unknown;
    openTerminal?: unknown;
    onCli?: unknown;
  };
};

/** 读取内核命令桥；浏览器/旧桌面端返回 null。 */
export function getMagpieCliBridge(): MagpieCliBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as BridgeWindow).__heming_magpie;
  if (!bridge) return null;
  if (
    typeof bridge.cli !== "function" ||
    typeof bridge.cliStart !== "function" ||
    typeof bridge.cliBegin !== "function" ||
    typeof bridge.cliInput !== "function" ||
    typeof bridge.cliKill !== "function" ||
    typeof bridge.openTerminal !== "function" ||
    typeof bridge.backupInfo !== "function" ||
    typeof bridge.backupPick !== "function" ||
    typeof bridge.onCli !== "function"
  ) {
    return null;
  }
  return bridge as unknown as MagpieCliBridge;
}

/** 一条 `magpie providers` 的行（列之间是两个以上空格）。 */
export interface ProviderRow {
  id: string;
  kind: string;
  host: string;
  models: number | null;
  raw: string;
}

/** 解析 `magpie providers` 的人类可读输出；解析不了的保持 raw 展示，不猜。 */
export function parseProviders(raw: string): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[!✓·]/.test(trimmed)) continue;
    if (/no providers|add one/i.test(trimmed)) continue;
    // 上游按列对齐输出：id 与类型之间可能只有一个空格，列与列之间是多个空格。
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) continue;
    const id = tokens[0]!;
    const kind = tokens[1]!;
    const hostToken = tokens.find(
      (token) =>
        token !== id && (/^([a-z0-9-]+\.)+[a-z0-9-]+(:\d+)?$/i.test(token) || /^[a-z0-9-]+:\d+$/i.test(token)),
    );
    const modelIndex = tokens.findIndex((token) => /^\d+$/.test(token));
    const models = modelIndex >= 0 && /^models?$/.test(tokens[modelIndex + 1] ?? "") ? Number.parseInt(tokens[modelIndex]!, 10) : null;
    rows.push({ id, kind, host: hostToken ?? "", models, raw: trimmed });
  }
  return rows;
}

/** 订阅账号：`magpie accounts --json` 是数组；字段随版本可能增加，这里只收敛通用字段。 */
export interface AccountRow {
  agent: string;
  label: string;
  allowance?: string;
  raw: Record<string, unknown>;
}

export function parseAccounts(stdout: string): AccountRow[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const str = (key: string): string =>
        typeof item[key] === "string" ? (item[key] as string) : "";
      const agent = str("agent") || str("kind") || str("provider") || "账号";
      const label =
        str("name") || str("email") || str("label") || str("account") || str("id") || "(未命名)";
      const allowance = str("allowance") || str("used") || str("quota") || str("reset");
      return { agent, label, allowance: allowance || undefined, raw: item };
    });
}

/**
 * 读一个来源的详细地址：`provider show <id>`。
 *
 * 早先的内核没有 show 动词（传 `show` 会被当成 id 去查），所以拿不到输出时
 * 退回 `provider <id>` —— 同样打印 chat / responses / anthropic 三行。
 * 两条都失败就返回空串，调用方按「普通地址」展示，不打扰用户。
 */
export async function readProviderShow(cli: MagpieCliBridge, id: string): Promise<string> {
  for (const args of [
    ["provider", "show", id],
    ["provider", id],
  ]) {
    try {
      const result = await cli.cli(args);
      const text = stripAnsi(result.stdout || "").trim();
      if (result.ok && text) return text;
    } catch {
      // 换下一种写法再试
    }
  }
  return "";
}

/** 把参数数组拼成可读命令（仅展示用，不执行）。 */
export function formatCommand(args: readonly string[]): string {
  return `magpie-core ${args.join(" ")}`;
}

/** 输出里的 ANSI 颜色/光标控制去掉，页面按纯文本展示。 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** 截断超长输出（页面只需要最近一段），保留尾部。 */
export function tailText(text: string, max = 20_000): string {
  return text.length <= max ? text : `…（前 ${text.length - max} 字符已省略）\n${text.slice(-max)}`;
}
