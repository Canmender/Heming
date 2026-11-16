/**
 * 环境自检（d.193）：`/status` 一条命令说清「现在是什么状态」。
 *
 * 为什么要做：前面十几版各自补了能力（工作区根、计划模式、清单、后台作业、可撤回、上下文用量、
 * 中断续跑），但用户要回答「它现在为什么不动手 / 为什么看不见那个目录 / 还剩多少预算」
 * 只能挨个卡片点过去。codex 有 `/status`，这里对齐它，并且**只读快照**：
 * 不发请求、不改状态、不落库——自检本身不该有副作用。
 *
 * 纯函数在这里，界面只负责把快照攒齐；这样文案与「从哪儿取数」分离，
 * 测试不需要渲染 4500 行的 ChatPage。
 */

import { SLASH_COMMANDS } from "./slashCommands.js";

export interface StatusRoot {
  name: string;
  path: string;
  mode: "read" | "write";
}

export interface StatusInput {
  /** 应用版本（`__APP_VERSION__`），拿不到就传空串。 */
  version?: string;
  /** 当前会话绑定的模型名；未绑定传空。 */
  model?: string;
  /** 模型上下文窗口（tokens），未知可省略。 */
  modelWindow?: number;
  /** 模型是否支持读图。 */
  vision?: boolean;
  /** 会话工作区路径；未分组会话省略。 */
  workspace?: string;
  /** 本会话此刻可用的文件根（含会话工作区派生根）。 */
  roots?: readonly StatusRoot[];
  /** 计划模式是否开启。 */
  planMode?: boolean;
  /** 上下文用量快照。 */
  context?: { used: number; budget: number } | null;
  /** 任务清单（只要状态即可）。 */
  todos?: readonly { status: "pending" | "in_progress" | "completed" }[];
  /** 后台作业：运行中 / 总计。 */
  jobs?: { running: number; total: number } | null;
  /** 本轮可撤回的改动数。 */
  writes?: number;
  /** 是否有「上次没跑完」的续跑点。 */
  resumePending?: boolean;
  /** 这一轮是否正在跑。 */
  busy?: boolean;
  /** 本轮注入的工具数（含核心工具数）。 */
  tools?: { count: number; core: number } | null;
  /** 桌面桥是否存在（浏览器里没有文件/命令能力）。 */
  desktop?: boolean;
}

/** 路径太长时中间省略，自检行不该被一条长路径撑爆。 */
function shortPath(path: string, max = 58): string {
  if (path.length <= max) return path;
  const keep = Math.floor((max - 1) / 2);
  return `${path.slice(0, keep)}…${path.slice(path.length - keep)}`;
}

function yesNo(value: boolean | undefined, when: string, otherwise: string): string {
  return value ? when : otherwise;
}

/**
 * 生成自检文本。刻意用「标签：值」的等宽短行，用户能整段复制给支持人员；
 * 不写「一切正常」这类无信息结论——每行都必须能被核对。
 */
export function buildStatusReport(input: StatusInput): string {
  const lines: string[] = [];
  const version = (input.version ?? "").trim();
  lines.push(`环境自检${version ? ` · 和鸣 ${version}` : ""}`);

  if (!input.desktop) {
    lines.push("桌面端：未连接（浏览器里没有本机文件与命令能力）");
  }
  if (input.model) {
    const extra: string[] = [];
    if (input.modelWindow && input.modelWindow > 0) {
      extra.push(`窗口 ${Math.round(input.modelWindow / 1000)}K`);
    }
    if (input.vision) extra.push("可读图");
    lines.push(`模型：${input.model}${extra.length ? `（${extra.join("、")}）` : ""}`);
  } else {
    lines.push("模型：未绑定（这一轮没有模型，工具也不会被调用）");
  }

  lines.push(`工作区：${input.workspace ? shortPath(input.workspace) : "未分组（用默认工作区）"}`);

  const roots = input.roots ?? [];
  const writable = roots.filter((root) => root.mode === "write");
  if (roots.length === 0) {
    lines.push("可写目录：0 个（没有可写根，写类工具不会被注入）");
  } else {
    const listed = writable
      .slice(0, 3)
      .map((root) => `${root.name} → ${shortPath(root.path, 44)}`)
      .join("；");
    const readOnly = roots.length - writable.length;
    lines.push(
      `可写目录：${writable.length} 个${listed ? `（${listed}${writable.length > 3 ? "；…" : ""}）` : ""}` +
        (readOnly > 0 ? `；另有 ${readOnly} 个只读` : `；没有只读根`),
    );
  }

  lines.push(`计划模式：${yesNo(input.planMode, "开（只读，先给方案）", "关")}`);
  if (input.context && input.context.budget > 0) {
    const pct = Math.round((input.context.used / input.context.budget) * 100);
    lines.push(
      `上下文：约 ${input.context.used} / ${input.context.budget} tokens（${pct}%）` +
        (pct >= 80 ? "——接近上限，可以发 /compact" : ""),
    );
  } else {
    lines.push("上下文：—");
  }

  const todos = input.todos ?? [];
  if (todos.length === 0) {
    lines.push("任务清单：空");
  } else {
    const done = todos.filter((item) => item.status === "completed").length;
    const doing = todos.filter((item) => item.status === "in_progress").length;
    lines.push(`任务清单：${done}/${todos.length} 已完成，${doing} 项进行中`);
  }

  if (input.jobs && input.jobs.total > 0) {
    lines.push(
      input.jobs.running > 0
        ? `后台作业：${input.jobs.running} 条在跑（共 ${input.jobs.total} 条）`
        : `后台作业：${input.jobs.total} 条都已结束`,
    );
  } else {
    lines.push("后台作业：无");
  }

  lines.push(`可撤回改动：${(input.writes ?? 0) > 0 ? `${input.writes} 个文件` : "无"}`);
  lines.push(`还有没跑完的一轮：${yesNo(input.resumePending, "有（可以点「继续」接着做）", "没有")}`);

  if (input.tools) {
    lines.push(`本轮工具：共 ${input.tools.count} 个${input.tools.core > 0 ? `（其中核心 ${input.tools.core} 个常驻）` : ""}`);
  }

  lines.push(`正在跑：${yesNo(input.busy, "是（想停就点停止，停了点「继续」能接着做）", "否")}`);
  return lines.join("\n");
}

/** `/help`：把命令面板里已有命令原样列出来，避免面板与清单两处漂移。 */
export function buildSlashHelp(): string {
  const lines = ["本地命令（都在输入框里直接打，不会发给模型）："];
  for (const item of SLASH_COMMANDS) {
    lines.push(`${item.command} — ${item.title}：${item.hint}`);
  }
  return lines.join("\n");
}
