/**
 * 会话导出：把本机已解密的明文整理成 Markdown / JSON。
 *
 * 边界：
 * - 只导出调用方提供的消息（调用方已剔除解不开的信封），导出函数本身不读存储、不联网；
 * - 导出时间由调用方传入，保证同一份输入得到逐字相同的输出（可测试、可复现）；
 * - 附件只导出元信息，不把解析出的文档正文再抄一遍（正文可能很大，且用户本就有原文件）。
 */

export interface ExportAttachment {
  id?: string;
  name: string;
  mime: string;
  size: number;
}

/** 过程里的一步（d.356）：思考段或一次工具调用。 */
export interface ExportStep {
  kind: "think" | "tool";
  /** 一行摘要：思考取原文单行，工具取「工具名 · 参数」。 */
  label: string;
  status?: "ok" | "error" | "denied" | "running";
  /** 与 `status` 配套的说明（失败原因、被拒原因）。 */
  detail?: string;
  /** 工具耗时（毫秒）；拿不到就省略，不编 0。 */
  ms?: number;
}

export interface ExportMessage {
  id: string;
  role: "user" | "assistant" | "system";
  /** 展示名：本机用户为「我」，其余取会话/群成员快照。 */
  sender: string;
  /** ISO 时间串。 */
  at: string;
  text: string;
  attachment?: ExportAttachment;
  recalled?: boolean;
  /**
   * 过程（d.356）：思考段与工具调用。导出时收进 `<details>`——
   * 要复盘的人点开，只读正文的人不被打断。缺省不写这一段。
   */
  process?: readonly ExportStep[];
}

export interface ConversationExportInput {
  id: string;
  title: string;
  /** 导出时刻（毫秒）。 */
  exportedAt: number;
  messages: ExportMessage[];
}

export interface ConversationExportDoc extends ConversationExportInput {
  version: 1;
}

const PAD = (n: number) => String(n).padStart(2, "0");

/** 本地时区 `YYYY-MM-DD HH:mm:ss`；无效时间回退原文，避免导出整份失败。 */
export function formatExportTime(value: string | number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(
    d.getMinutes(),
  )}:${PAD(d.getSeconds())}`;
}

/** 附件大小：KB/MB，一位小数；未知大小显示「大小未知」。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "大小未知";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件名只保留安全字符，避免 Windows 非法字符与路径分隔符。 */
export function conversationFileName(title: string, exportedAt: number, ext: "md" | "json"): string {
  const d = new Date(exportedAt);
  const stamp = Number.isNaN(d.getTime())
    ? "unknown"
    : `${d.getFullYear()}${PAD(d.getMonth() + 1)}${PAD(d.getDate())}-${PAD(d.getHours())}${PAD(
        d.getMinutes(),
      )}`;
  // d.412.4.198：按码点截断，不能按 UTF-16 码元 slice——后者会把标题末尾的 emoji
  // 劈成落单代理写进文件名（下载文件名里出现半截代理，落盘后是乱码/问号）。
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  const safe = chars.length <= 60 ? clean : chars.slice(0, 60).join("");
  return `和鸣-${safe || "会话"}-${stamp}.${ext}`;
}

function attachmentLine(file: ExportAttachment): string {
  return `**附件**：${file.name}（${file.mime}，${formatBytes(file.size)}）`;
}

/** 过程最多列这么多步：导出文件是给人读的，不是一份工具日志。 */
export const MAX_EXPORT_STEPS = 40;

/** `<details>` 里是 HTML，摘要不转义会把正文吃成标签。 */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function statusMark(status: ExportStep["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "error":
      return "✗";
    case "denied":
      return "⊘";
    case "running":
      return "…";
    default:
      return "·";
  }
}

function stepLine(step: ExportStep): string {
  const took = typeof step.ms === "number" ? ` · ${step.ms < 1000 ? `${step.ms}ms` : `${(step.ms / 1000).toFixed(1)}s`}` : "";
  const mark = step.kind === "tool" ? statusMark(step.status) : "·";
  const kind = step.kind === "tool" ? "工具" : "思考";
  const note = step.detail?.trim() ? ` · ${step.detail.trim()}` : "";
  return `${mark} ${kind} · ${step.label.trim()}${took}${note}`;
}

function processBlock(steps: readonly ExportStep[]): string {
  const usable = steps.filter((step) => step.label.trim().length > 0 || step.detail?.trim());
  if (usable.length === 0) return "";
  const shown = usable.slice(0, MAX_EXPORT_STEPS).map((step) => `- ${escapeHtml(stepLine(step))}`);
  const hidden = usable.length - Math.min(usable.length, MAX_EXPORT_STEPS);
  if (hidden > 0) shown.push(`- …还有 ${hidden} 步（导出时只保留前 ${MAX_EXPORT_STEPS} 步）`);
  return [
    "<details>",
    `<summary>过程（${usable.length} 步）</summary>`,
    "",
    ...shown,
    "",
    "</details>",
  ].join("\n");
}

export function buildConversationMarkdown(input: ConversationExportInput): string {
  /* d.408：导出件也要能一眼看出「跑了多少」——否则拿到文件的人只能从头数。 */
  const rounds = input.messages.filter((m) => m.role === "user").length;
  const steps = input.messages.reduce((sum, m) => sum + (m.process?.length ?? 0), 0);
  const failed = input.messages.reduce(
    (sum, m) => sum + (m.process?.filter((s) => s.status === "error" || s.status === "denied").length ?? 0),
    0,
  );
  const lines: string[] = [
    `# 会话：${input.title}`,
    "",
    `- 会话 ID：${input.id}`,
    `- 导出时间：${formatExportTime(input.exportedAt)}`,
    `- 消息数：${input.messages.length}`,
    `- 轮次：${rounds}（用户发了几条）`,
    `- 过程：${steps} 步${failed > 0 ? ` · ${failed} 步没成` : ""}`,
    "",
    "> 由和鸣在本机生成，仅包含本机可解密的明文消息；附件正文未导出。",
    "",
  ];

  for (const m of input.messages) {
    lines.push(`## ${formatExportTime(m.at)} · ${m.sender}`, "");
    if (m.recalled) {
      lines.push("（消息已撤回）", "");
      continue;
    }
    if (m.text) lines.push(m.text, "");
    if (m.attachment) lines.push(attachmentLine(m.attachment), "");
    const process = m.process ? processBlock(m.process) : "";
    if (process) lines.push(process, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildConversationJson(input: ConversationExportInput): string {
  const doc: ConversationExportDoc = {
    version: 1,
    id: input.id,
    title: input.title,
    exportedAt: input.exportedAt,
    messages: input.messages.map((m) => ({
      id: m.id,
      role: m.role,
      sender: m.sender,
      at: m.at,
      text: m.recalled ? "" : m.text,
      ...(m.recalled ? { recalled: true } : {}),
      ...(m.attachment ? { attachment: m.attachment } : {}),
      // Markdown 已导出过程（思考/工具步），JSON 也要带同一份投影，别让两种格式各说各话。
      ...(m.process ? { process: m.process } : {}),
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

