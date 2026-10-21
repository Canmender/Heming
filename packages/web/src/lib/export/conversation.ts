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
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `和鸣-${safe || "会话"}-${stamp}.${ext}`;
}

function attachmentLine(file: ExportAttachment): string {
  return `**附件**：${file.name}（${file.mime}，${formatBytes(file.size)}）`;
}

export function buildConversationMarkdown(input: ConversationExportInput): string {
  const lines: string[] = [
    `# 会话：${input.title}`,
    "",
    `- 会话 ID：${input.id}`,
    `- 导出时间：${formatExportTime(input.exportedAt)}`,
    `- 消息数：${input.messages.length}`,
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
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
