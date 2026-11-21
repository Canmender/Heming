import type { ChatMessage } from "./types.js";

/**
 * 结构化摘要（设计 §3.3）：固定三段骨架，优先 LLM，失败/未绑定时回落零成本确定性摘要。
 * 摘要只作本次请求的临时上下文，不回写记忆层（避免自我强化）。
 */

/** 摘要骨架标题（`prepareHistory` 与提示词共用同一常量）。 */
export const SUMMARY_HEADER = "【早期对话摘要】";
/** 摘要置于历史之前时的背景声明（设计 §3.3）。 */
export const SUMMARY_NOTICE =
  "以下是更早对话的摘要，仅作背景；与最近对话冲突时，以最近对话为准。不要向用户复述本段结构。";
/** 用户意图取前 80 字。 */
export const SUMMARY_INTENT_CHARS = 80;
/** 助手结论取首句，最长 80 字。 */
export const SUMMARY_CONCLUSION_CHARS = 80;
/** 每段最多取 3 条。 */
export const SUMMARY_MAX_ITEMS = 3;
/** 提示词里转写的字符上限（超出则保留最靠近 recent 的尾部）。 */
export const SUMMARY_PROMPT_CHARS = 4000;

/** 确定性回落无处推断待办 → 固定占位，保持三段骨架完整。 */
const UNKNOWN = "（未提及）";
/** 提示词固定骨架（模型只许输出这三段）。 */
export const SUMMARY_INSTRUCTION =
  "你负责把一段较早的对话压缩成背景摘要。只输出下面三段，不要寒暄、不要解释、不要代码块，" +
  `除三段外不要输出任何内容：\n${SUMMARY_HEADER}\n意图：…\n结论：…\n待办：…\n` +
  "某一节缺少信息时写「（未提及）」，全文不超过 200 字。";
/** 提示词正文导语。 */
export const SUMMARY_TASK = "以下是同一会话中较早的一段对话，请按要求压缩为上述三段：";

const ROLE_LABEL: Record<string, string> = { user: "用户", assistant: "助手", system: "系统", tool: "工具" };
/** 转写时单条工具输出的字符上限：工具结果里常是整页 HTML/JSON，原样塞进摘要提示词会挤爆预算。 */
const TOOL_TRANSCRIPT_CHARS = 200;

/** 折叠空白：多行/连续空格合成单行，避免破坏骨架排版。 */
function squeeze(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  // 按码点截断（d.412 回归）：text.slice 按 UTF-16 单元切，边界落在 emoji/CJK 扩展区
  // 的代理对中间会留下落单代理，这段文本会进摘要提示词/系统消息喂给模型。
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** 首句：以中英文句末标点为界（不含标点）；无标点时整段（仍受长度上限约束）。 */
function firstSentence(text: string): string {
  const flat = squeeze(text);
  // 英文句点要跟空白或结尾才算句末，避免把 d.412.4 / e.g. / 3.14 之类从中间劈开。
  const end = flat.search(/[。！？!?]|\.(?=\s|$)/);
  const head = end >= 0 ? flat.slice(0, end) : flat;
  return clip(head.trim(), SUMMARY_CONCLUSION_CHARS);
}

/** 逐条转写（一行一条），供提示词使用。 */
function transcript(rows: ChatMessage[]): string {
  return rows
    .map((row) => {
      const text = squeeze(String(row?.content ?? ""));
      const body =
        row?.role === "tool" && text.length > TOOL_TRANSCRIPT_CHARS
          ? `${clip(text, TOOL_TRANSCRIPT_CHARS)}…（工具输出已截断）`
          : text;
      const label = ROLE_LABEL[row?.role ?? ""] ?? "其他";
      return `${label}：${body}`;
    })
    .join("\n");
}

/**
 * 确定性摘要（零成本、零依赖）：取 `older` 中最早的用户消息前 80 字（最多 3 条）
 * 与最早的助手回复首句（最多 3 条），拼成固定骨架；无有效内容返回空串。
 * 「待办」在确定性口径下无可靠来源，固定为「（未提及）」。
 */
export function deterministicSummary(older: ChatMessage[]): string {
  const list = Array.isArray(older) ? older : [];
  const intents: string[] = [];
  const conclusions: string[] = [];
  for (const row of list) {
    if (!row) continue;
    const text = squeeze(String(row.content ?? ""));
    if (!text) continue;
    if (row.role === "user" && intents.length < SUMMARY_MAX_ITEMS) {
      intents.push(clip(text, SUMMARY_INTENT_CHARS));
    } else if (row.role === "assistant" && conclusions.length < SUMMARY_MAX_ITEMS) {
      const sentence = firstSentence(text);
      if (sentence) conclusions.push(sentence);
    }
  }
  if (!intents.length && !conclusions.length) return "";
  return [
    SUMMARY_HEADER,
    `意图：${intents.length ? intents.join("；") : UNKNOWN}`,
    `结论：${conclusions.length ? conclusions.join("；") : UNKNOWN}`,
    `待办：${UNKNOWN}`,
  ].join("\n");
}

/**
 * 构造 LLM 摘要提示词：`[system 固定骨架指令, user 转写]`，可直接交给 `streamChat`
 * （调用方用非流式分支、`maxTokens` 上限 400）。`older` 无有效内容返回空数组。
 * `maxChars` 为转写上限（默认 4000），超出时保留**最靠近 recent 的尾部**。
 */
export function buildSummaryPrompt(older: ChatMessage[], maxChars?: number): ChatMessage[] {
  const list = (Array.isArray(older) ? older : []).filter(
    (row) => row && squeeze(String(row.content ?? "")),
  );
  if (!list.length) return [];
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars)
      ? Math.max(0, Math.floor(maxChars))
      : SUMMARY_PROMPT_CHARS;
  const text = transcript(list);
  // 尾部截断同样按码点，避免从 emoji 代理对中间开始（落单代理进 LLM 提示词）。
  const chars = [...text];
  const body = chars.length > limit ? chars.slice(chars.length - limit).join("") : text;
  return [
    { role: "system", content: SUMMARY_INSTRUCTION },
    { role: "user", content: `${SUMMARY_TASK}\n\n${body}` },
  ];
}
