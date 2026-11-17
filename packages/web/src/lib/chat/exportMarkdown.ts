/**
 * 把一条会话导出成 Markdown（d.236）。
 *
 * 为什么要有它：长任务跑到几十轮，真正有用的东西（结论、改了哪些文件、卡在哪）都散在
 * 几百条消息与上千次工具调用里；想归档、贴给同事、或者拿去开 issue，只能一条条复制。
 * codex 那类工具有「复制整段记录」，这里补一个能落成文件的版本。
 *
 * 口径三条：
 * 1. **只写已经发生的事**：消息原文、工具名与参数摘要、成功/失败状态，不替模型润色、
 *    不补它没说过的话；
 * 2. **失败与拒绝要带上**：导出的价值一半在「当时为什么没成」，把红字抹掉等于把坑藏起来；
 * 3. **纯函数**：不读 store、不碰 DOM，便于单测（下载动作留给界面）。
 */

export interface ExportToolLine {
  name: string;
  /** 人话参数摘要（复用 `summarizeToolArgs`，空串时只写工具名）。 */
  summary: string;
  status: "running" | "ok" | "error" | "denied";
}

export interface ExportTurn {
  /** user = 你说的；assistant = 和鸣说的。 */
  role: "user" | "assistant";
  /** 展示名（「你」/「和小鸣」之类）。 */
  name: string;
  /** ISO 时间串（消息的 createdAt）。 */
  at: string;
  text: string;
  tools?: ExportToolLine[];
  /** 附件原始文件名（有就列一行）。 */
  files?: string[];
}

export interface ExportTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ConversationExportInput {
  title: string;
  conversationId: string;
  /** 导出时刻（ISO）；不传就不写这一行，便于测试固定输出。 */
  exportedAt?: string;
  turns: readonly ExportTurn[];
  goal?: string | null;
  todos?: readonly ExportTodo[];
  version?: string | null;
}

const STATUS_MARK = {
  running: "…",
  ok: "",
  error: "（失败）",
  denied: "（被你拒绝）",
} as const;

const TODO_MARK: Record<ExportTodo["status"], string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
};

/** `2026-11-17T08:41:02.000Z` → `2026-11-17 08:41`（本地时区，导出给人看不看 UTC）。 */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function countByRole(turns: readonly ExportTurn[]): { user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  for (const turn of turns) {
    if (turn.role === "user") user += 1;
    else assistant += 1;
  }
  return { user, assistant };
}

/** 正文里如果自带 `### ` 之类的 Markdown 结构，也不需要特殊处理：原样保留，人读得懂。 */
function body(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  return trimmed === "" ? "（这条消息没有正文）" : trimmed;
}

export function conversationMarkdown(input: ConversationExportInput): string {
  const { user, assistant } = countByRole(input.turns);
  const lines: string[] = [];

  lines.push(`# ${input.title.trim() || "未命名会话"}`, "");

  const meta: string[] = [];
  meta.push(`- 会话：\`${input.conversationId}\``);
  if (input.exportedAt) meta.push(`- 导出时间：${stamp(input.exportedAt)}`);
  meta.push(`- 消息：${input.turns.length} 条（你说的 ${user} 条，和鸣说的 ${assistant} 条）`);
  if (input.version) meta.push(`- 和鸣版本：\`${input.version}\``);
  lines.push(...meta, "");

  if (input.goal && input.goal.trim() !== "") {
    lines.push("## 目标", "", input.goal.trim(), "");
  }

  if (input.todos && input.todos.length > 0) {
    lines.push("## 任务清单", "");
    for (const todo of input.todos) lines.push(`- ${TODO_MARK[todo.status]} ${todo.content}`);
    lines.push("");
  }

  lines.push("## 对话", "");
  if (input.turns.length === 0) {
    lines.push("（这条会话还没有消息）", "");
  } else {
    for (const turn of input.turns) {
      const when = stamp(turn.at);
      lines.push(`### ${turn.name}${when ? ` · ${when}` : ""}`, "");
      lines.push(body(turn.text), "");
      if (turn.files && turn.files.length > 0) {
        lines.push(`附件：${turn.files.join("、")}`, "");
      }
      if (turn.tools && turn.tools.length > 0) {
        lines.push(`工具调用（${turn.tools.length} 次）：`, "");
        for (const tool of turn.tools) {
          const detail = tool.summary.trim() === "" ? "" : ` — ${tool.summary.trim()}`;
          lines.push(`- \`${tool.name}\`${detail}${STATUS_MARK[tool.status]}`);
        }
        lines.push("");
      }
    }
  }

  // 结尾统一一个换行：某些编辑器打开没有尾换行的文件会自动补，补了再存就产生 diff。
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** 文件名：会话标题去掉路径与冒号这类不能进文件名的字符，再拼日期。 */
export function exportFileName(title: string, at: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const day = at.slice(0, 10).replace(/-/g, "");
  return `${safe || "和鸣会话"}-${day || "export"}.md`;
}
