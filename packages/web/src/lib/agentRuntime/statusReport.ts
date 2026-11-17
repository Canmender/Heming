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

import { formatFoldAgeMinutes } from "../agentContext/contextFold.js";
import type { McpStatusSnapshot } from "../mcp/summary.js";
import { SLASH_COMMANDS } from "./slashCommands.js";

export interface StatusRoot {
  name: string;
  path: string;
  mode: "read" | "write";
}

/** 本会话累计用量快照（d.230），字段与 `totalsOf()` 的返回一一对应。 */
export interface UsageSnapshot {
  total: number;
  input: number;
  output: number;
  runs: number;
  unreported: number;
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
  /** 是否已授权子代理写盘（d.202）；省略／false＝只读。 */
  subagentWritable?: boolean;
  /** 系统通知是否开着（d.208）；省略＝按开处理（默认开）。 */
  notifyEnabled?: boolean;
  /** 本会话改过的文件数（d.210）；省略或 0 不出这一行。 */
  sessionChanges?: number;
  /** 上下文用量快照。 */
  context?: { used: number; budget: number; calibrated?: boolean } | null;
  /**
   * 最近一次「更早的对话被折成摘要」（d.217）：折叠条数与距今分钟数。
   * 省略或 null 表示这个会话还没折过——那时模型看到的就是完整历史。
   */
  contextFold?: { foldedCount: number; ageMinutes: number } | null;
  /**
   * 本会话累计用量（d.230），来自 `totalsOf(recordsForConversation(...))`。
   * 省略 / null / runs 为 0 = 这个会话还没跑过（不写这一行）。
   * `unreported` 是供应商没上报用量的轮数——不能当 0 算，要如实说。
   */
  usage?: UsageSnapshot | null;
  /**
   * 上一轮读到的项目约定文件（d.219），来自 `summarizeProjectRules`。
   * 省略 = 还没跑过一轮（无从得知）；空数组 = 跑过了但工作区里没有约定文件。
   */
  projectRules?: { files: readonly { rel: string; chars: number; truncated: boolean }[]; omitted: number } | null;
  /**
   * 工具失败归因（d.221），来自 `getToolFailureStats`。
   * null / 省略 = 这个会话还没失败过（不写这一行）。
   */
  toolFailures?: {
    total: number;
    codes: readonly { code: string; count: number }[];
    tools: readonly { code: string; count: number }[];
    dropped: number;
  } | null;
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
  /**
   * 本轮工具目录（d.191 / d.224）。
   *
   * `discovery` 为真表示工具总数已超过阈值、本轮改走「按需发现」（对应 Codex 的 tool_search）：
   * 模型只看得到约 `visible` 个 + `tool_search`，其余要先检索才能调。这条信息很重要——
   * 用户常问「我装的那个工具它怎么不用」，答案往往不是能力缺失，而是被按需发现挡在后面。
   */
  tools?: {
    count: number;
    core: number;
    discovery?: boolean;
    /** 发现模式下第一轮大约给模型几个工具（来自 `MAX_VISIBLE_TOOLS`）。 */
    visible?: number;
    /** 触发发现模式的目录数阈值（来自 `TOOL_SEARCH_THRESHOLD`）。 */
    threshold?: number;
  } | null;
  /**
   * MCP 连接状况（d.223），来自 `summarizeMcpStatus`。
   * null / 省略 = 浏览器环境拿不到注册表；有值时即使 0 个服务也会说明「没有配置服务」。
   */
  mcp?: McpStatusSnapshot | null;
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

/** 字数说人话：`812 字` / `4.0K 字`——自检行里精确到个位没有意义。 */
function shortChars(chars: number): string {
  return chars < 1000 ? `${chars} 字` : `${(chars / 1000).toFixed(1)}K 字`;
}

/**
 * token 数说人话（d.230）：`812` / `34.2K` / `1.2M`。
 *
 * 为什么不直接印精确数：这一行回答的是「这个会话大概花了多少」，
 * 精确到个位的 `34,218` 只会让整行更难读；要看准确值有「用量」页。
 */
function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * 本会话用量行（d.230）。
 *
 * 三种情况分开说：
 * - 没跑过（runs 为 0 / 没给快照）→ 不写这一行（自检已经够长，空话省掉）；
 * - 跑过但供应商一次都没上报 → 明写「无法统计」，不能显示成 0；
 * - 有数字 → 轮数 + 输入/输出 + 合计，未上报的轮数如实附在后面。
 *
 * 为什么值得单独一行：单价按输入/输出分档计费，只看「合计」看不出贵在哪；
 * 而且「这一句话为什么这么贵」的答案往往就是输入（历史 + 工具 schema 全在输入里）。
 */
export function describeUsageLine(usage: UsageSnapshot | null | undefined): string | null {
  if (!usage || usage.runs <= 0) return null;
  const unreportedNote = usage.unreported > 0 ? `；另有 ${usage.unreported} 轮供应商没上报用量` : "";
  if (usage.total <= 0) {
    return `本会话用量：${usage.runs} 轮（供应商没有上报用量，无法统计）`;
  }
  return (
    `本会话用量：${usage.runs} 轮 · 输入 ${formatTokens(usage.input)} / 输出 ${formatTokens(usage.output)} tokens` +
    `（合计 ${formatTokens(usage.total)}）${unreportedNote}`
  );
}


/**
 * 项目约定行（d.219）。
 *
 * 三种情况必须分开说，因为处理办法完全不同：
 * - 还没有跑过一轮（`undefined`）→ 不知道，别假装没读到；
 * - 跑过了但工作区里没有约定文件 → 告诉用户「发 /init 可以让它写一份」；
 * - 读到了 → 列出文件与字数，被截断/被省略的如实标注（这正是「它为什么不按规矩来」的答案）。
 */
export function describeProjectRulesLine(
  rules: StatusInput["projectRules"],
): string {
  if (rules === undefined) return "项目约定：尚未统计（跑过一轮后这里会写读到了哪几份）";
  if (rules === null || rules.files.length === 0) {
    return "项目约定：无（工作区里没有 AGENTS.md；发 /init 可以让它摸清仓库后写一份）";
  }
  const listed = rules.files
    .map((file) => `${file.rel}（${shortChars(file.chars)}${file.truncated ? "，已截断" : ""}）`)
    .join("、");
  const tail = rules.omitted > 0 ? `；还有 ${rules.omitted} 份没展开（字数上限）` : "";
  return `项目约定：${listed}${tail}`;
}

/**
 * 工具失败归因（d.221）：这个会话失败了几次、都卡在哪些错误码上。
 *
 * 只列前 3 个错误码——再多就不像自检、像日志了；被截断的种类如实说「还有 N 种没列」。
 * 没有任何失败返回 null（调用方不写这一行，而不是写「0 次」占一行）。
 */
export function describeToolFailureLine(
  stats: StatusInput["toolFailures"],
): string | null {
  if (!stats || stats.total <= 0) return null;
  const top = stats.codes
    .slice(0, 3)
    .map((item) => `${item.code} ×${item.count}`)
    .join("、");
  const restKinds = stats.codes.length - 3;
  const rest = restKinds > 0 ? `，还有 ${restKinds} 种没列` : "";
  const dropped = stats.dropped > 0 ? `；另有 ${stats.dropped} 次超出统计上限` : "";
  const tool = stats.tools[0];
  const toolPart = tool ? `；出错最多的是 ${tool.code}（${tool.count} 次）` : "";
  return `工具失败：本会话 ${stats.total} 次（${top}${rest}）${toolPart}${dropped}`;
}

/**
 * 生成自检文本。刻意用「标签：值」的等宽短行，用户能整段复制给支持人员；
 * 不写「一切正常」这类无信息结论——每行都必须能被核对。
 */
/**
 * MCP 连接行（d.223）。
 *
 * 工具清单里有 MCP 工具 ≠ 那台服务连得上：进程没起来、配置写错、或者连过一次之后掉线，
 * 模型都会照常调用并失败。失败统计只会说「这个会话失败了 N 次」，说不清原因，
 * 于是用户去改模型、改提示词——这里把「谁没连上、为什么」摊开。
 */
export function describeMcpLine(mcp: McpStatusSnapshot): string {
  if (mcp.total === 0) return "MCP：没有配置服务（装了服务，它的工具才会出现在工具清单里）";
  if (mcp.enabled === 0) {
    return `MCP：${mcp.total} 个服务都已停用（要用的话到「能力 → MCP」打开）`;
  }
  const toolsPart = mcp.tools > 0 ? `（共 ${mcp.tools} 个 MCP 工具可用）` : "";
  if (mcp.failed.length === 0 && mcp.pending === 0) {
    return `MCP：${mcp.enabled} 个服务都已连接${toolsPart}。`;
  }
  const detail: string[] = [];
  if (mcp.pending > 0) detail.push(`${mcp.pending} 个还没连过`);
  if (mcp.failed.length > 0) {
    const names = mcp.failed
      .slice(0, 2)
      .map((item) => `${item.name}${item.error ? `（${clipFailureReason(item.error)}）` : ""}`)
      .join("、");
    const more = mcp.failed.length > 2 ? " 等" : "";
    detail.push(`${mcp.failed.length} 个没连上：${names}${more}`);
  }
  const hint =
    mcp.failed.length > 0
      ? "这些服务上的工具现在调了会失败，去「能力 → MCP」重连或先关掉。"
      : "还没连过的服务，它的工具暂时不会出现在清单里。";
  const head = `MCP：${mcp.enabled} 个服务里 ${mcp.connected} 个已连接${toolsPart}`;
  return `${head}；${detail.join("；")}。${hint}`;
}

/** 运行时给的失败原因可能很长，自检行只留前一段。 */
function clipFailureReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/**
 * 工具目录行（d.224）。
 *
 * 以前只说「共 N 个（其中核心 C 个常驻）」。工具一多（装两三个 MCP 就过 20）就切到按需发现，
 * 模型第一轮只看见一部分，剩下的要 `tool_search` 检索——用户看不到这层，就会把
 * 「它没调用我那个工具」理解成「它不支持」。所以这里把阈值、大约给几个、怎么恢复都说出来。
 */
export function describeToolsLine(tools: {
  count: number;
  core: number;
  discovery?: boolean;
  visible?: number;
  threshold?: number;
}): string {
  const corePart = tools.core > 0 ? `（其中核心 ${tools.core} 个常驻）` : "";
  const base = `本轮工具：共 ${tools.count} 个${corePart}`;
  if (tools.discovery !== true) return base;
  const threshold = tools.threshold && tools.threshold > 0 ? tools.threshold : 20;
  const visible = tools.visible && tools.visible > 0 ? tools.visible : threshold;
  return (
    `${base}；超过 ${threshold} 个，已改「按需发现」——每轮先给约 ${visible} 个 + tool_search，` +
    "其余工具模型要先检索才调得动（所以它有时要先查一下才动手）。想让它直接可用：" +
    "去「能力 → MCP」停用不用的服务，或把不常用的工具收起来。"
  );
}

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
  lines.push(describeProjectRulesLine(input.projectRules));
  const failureLine = describeToolFailureLine(input.toolFailures);
  if (failureLine !== null) lines.push(failureLine);

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
  lines.push(
    `子代理：${
      input.subagentWritable
        ? "可写（只能用 file_write / file_edit，改动进「本轮可撤回」）"
        : "只读（默认；要它改文件发 /subagent write on）"
    }`,
  );
  lines.push(
    `系统通知：${yesNo(
      input.notifyEnabled === false ? false : true,
      "开（窗口不在前台时，跑完 / 出错 / 等你确认会提醒，点通知回到会话）",
      "关（发 /notify on 打开）",
    )}`,
  );
  // 会话级改动台账（d.210）：只在真改过文件时说，且只报「几个文件」这个能确认的事实。
  if (typeof input.sessionChanges === "number" && input.sessionChanges > 0) {
    lines.push(`本会话改动：${input.sessionChanges} 个文件（点输入框上方的「查看改动」逐行对照）`);
  }
  if (input.context && input.context.budget > 0) {
    const pct = Math.round((input.context.used / input.context.budget) * 100);
    lines.push(
      `上下文：约 ${input.context.used} / ${input.context.budget} tokens（${pct}%）` +
        (input.context.calibrated ? "（已按实测校准）" : "") +
        (pct >= 80 ? "——接近上限，可以发 /compact" : ""),
    );
  } else {
    lines.push("上下文：—");
  }
  // 压缩这件事得说出来（d.217）：会话原文没删，但模型看到的是摘要。
  if (input.contextFold && input.contextFold.foldedCount > 0) {
    const age = formatFoldAgeMinutes(input.contextFold.ageMinutes);
    lines.push(
      `上次压缩：折叠 ${input.contextFold.foldedCount} 条（${age}）——会话原文一条没删，模型看到的是摘要；` +
        "要是它忘了要求，把关键约束再说一遍。",
    );
  }
  // 「这个会话大概花了多少」也是自检该回答的（d.230）：有数据才说，没上报就明说没上报。
  const usageLine = describeUsageLine(input.usage);
  if (usageLine !== null) lines.push(usageLine);

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
    lines.push(describeToolsLine(input.tools));
  }
  if (input.mcp) lines.push(describeMcpLine(input.mcp));

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
