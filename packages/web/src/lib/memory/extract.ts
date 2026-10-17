import { tokenize } from "./tokenize.js";

/**
 * 记忆抽取（设计 §2.2/§2.3）：全部确定性规则，零 LLM 成本。
 * - `extractExplicitMemory`：把用户的显式指令（记住…／以后都…／我的X是Y）抽成主题键值；
 * - `deterministicSummary`：把一轮对话压成可编辑的情景摘要。
 */

/** 主题键上限（计划 Task 2：key ≤ 24 字）。 */
export const KEY_MAX = 24;
/** 语义值上限（设计 §2.3）。 */
export const VALUE_MAX = 500;
/** 情景摘要上限（设计 §2.2）。 */
export const SUMMARY_MAX = 400;
/** 摘要里用户首问/助手回答各自的上限。 */
const SUMMARY_QUESTION_MAX = 120;
const SUMMARY_ANSWER_MAX = 160;
/** 摘要里保留的关键词个数。 */
const SUMMARY_KEYWORDS = 6;

/** 「记住」标记；只有出现它才允许宽松的事实解析（避免误把陈述句当指令）。 */
const MARKER = "记住";
const QUESTION_TAIL = /[?？]\s*$/;
/** 「我的X是Y」：X 不含标点与空白，Y 到句末。 */
const FACT_SELF = /^我(?:的)?\s*([^，。；;,.!！?？\s]{1,12}?)\s*(?:是|叫|叫做|为|＝|=)\s*(.+)$/;
/** 「记住 X是Y」的宽松版（仅在命中「记住」时启用）。 */
const FACT_LOOSE = /^([^，。；;,.!！?？\s]{1,12}?)\s*(?:是|叫|叫做|为|＝|=)\s*(.+)$/;
/** 「以后都 X」→ 长期偏好。 */
const PREFERENCE = /^以后\s*(?:都|一律|全部|一直|总是|要|会|请)?\s*(.*)$/;
/** 偏好内容涉及语言时用更具体的主题键（与设计 §2.3 的「偏好-语言」示例一致）。 */
const LANGUAGE_HINT = /(?:中文|英文|简体|繁体|语言|English|Chinese)/i;
/** 句末标点：显式指令只取第一句，避免把后续闲聊卷进记忆。 */
const SENTENCE_BREAK = /[。！？!?\n\r]/;

/** 主题键归一化：压缩空白、去首尾标点、截到 24 字。 */
export function normalizeKey(key: string): string {
  const collapsed = String(key ?? "").replace(/\s+/g, " ").trim();
  return collapsed
    .replace(/^[\s:：,，、;；-]+/, "")
    .replace(/[\s:：,，、;；-]+$/, "")
    .slice(0, KEY_MAX);
}

function cleanValue(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。．.！!？?~～,，;；]+$/, "")
    .trim()
    .slice(0, VALUE_MAX);
}

/** 取第一句并去掉前导冒号/顿号/空白。 */
function firstSentence(text: string): string {
  const stripped = text.replace(/^[\s:：,，、;；-]+/, "");
  const hit = SENTENCE_BREAK.exec(stripped);
  return (hit ? stripped.slice(0, hit.index) : stripped).trim();
}

function parseFact(body: string, requireSelf: boolean): { key: string; value: string } | null {
  const match = (requireSelf ? FACT_SELF : FACT_LOOSE).exec(body);
  if (!match) return null;
  const key = normalizeKey(match[1]);
  const value = cleanValue(match[2]);
  if (!key || !value) return null;
  return { key, value };
}

function parsePreference(body: string): { key: string; value: string } | null {
  const match = PREFERENCE.exec(body);
  if (!match) return null;
  const value = cleanValue(match[1]);
  if (!value) return null;
  return { key: LANGUAGE_HINT.test(value) ? "偏好-语言" : "偏好", value };
}

/**
 * 显式指令抽取（设计 §2.3）：识别
 * - 「记住：X」「记住 X」「记住，X」（X 若是「我的X是Y」则拆成键值，否则整句为键值）；
 * - 「以后都 X」→ 主题键「偏好」（涉语言时为「偏好-语言」）；
 * - 「我的X是Y」（是/叫/为/＝ 同义）。
 * 只认明确指令：问句、日常陈述、无「记住」的普通句子一律返回 null。
 */
export function extractExplicitMemory(text: string): { key: string; value: string } | null {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw) return null;
  if (QUESTION_TAIL.test(raw)) return null; // 问句不是记忆指令

  const markerAt = raw.indexOf(MARKER);
  const body = firstSentence(markerAt >= 0 ? raw.slice(markerAt + MARKER.length) : raw);
  if (!body) return null;

  const fact = parseFact(body, true) ?? (markerAt >= 0 ? parseFact(body, false) : null);
  if (fact) return fact;

  const preference = parsePreference(body);
  if (preference) return preference;

  // 兜底：「记住 X」但 X 没有可拆的结构 → 整句作键值（键截到 24 字）
  if (markerAt < 0) return null;
  if (body.length < 2 || /[吗呢吧]$/.test(body)) return null;
  return { key: normalizeKey(body), value: cleanValue(body) };
}

/**
 * 确定性情景摘要（设计 §2.2）：用户首问 + 助手回答前 160 字 + 关键词，总长 ≤ 400 字。
 * 无 LLM 成本；结果可被用户在记忆页手工改写。
 */
export function deterministicSummary(userText: string, assistantText: string): string {
  const question = String(userText ?? "").replace(/\s+/g, " ").trim();
  const answer = String(assistantText ?? "").replace(/\s+/g, " ").trim();
  if (!question && !answer) return "";

  const keywords = tokenize(`${question} ${answer}`)
    .filter((token) => token.length > 1)
    .slice(0, SUMMARY_KEYWORDS);

  const parts: string[] = [];
  if (question) parts.push(`用户：${clip(question, SUMMARY_QUESTION_MAX)}`);
  if (answer) parts.push(`助手：${clip(answer, SUMMARY_ANSWER_MAX)}`);
  if (keywords.length) parts.push(`关键词：${keywords.join(" ")}`);
  return clip(parts.join("｜"), SUMMARY_MAX);
}

/** 截断到 max 字符（截断时以「…」收尾，保证结果长度 ≤ max）。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
