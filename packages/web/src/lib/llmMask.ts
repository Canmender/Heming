/**
 * 出站脱敏（d.48）：把对话里夹带的凭据/证件号换成占位符再发给服务商。
 *
 * 规则来源：magpie（github.com/yetone/magpie，MIT）的 Privacy masking
 * （内置插件 `redact`、`redactWords`、以及 `redact.key` —— 占位符背后那把本机钥匙，
 * 见 docs/reference.md:1172、:2993、:3453）。
 *
 * 三条设计约束：
 * 1. **只改出站副本**：本机历史、E2E 明文、界面文本一律不动。
 *    脱敏的目的是「别把 Key 寄给服务商」，不是「让用户看不见自己的 Key」——
 *    改本地副本会让下一轮、重试、以及归档全部失真。
 * 2. **不还原回复**：模型若照抄占位符，回复里就出现占位符。
 *    magpie 是网关，能在出口整段还原；我们是流式客户端，占位符可能**跨 chunk 断开**，
 *    半截占位符既还原不了也显示得难看。更重要的是：还原等于把原文再送回网络一次，
 *    与脱敏的初衷相反。所以这里让它出现，并留本机对照表（图例）让人知道隐去了什么。
 * 3. **不猜**：认不出的形状不动。宁可漏掉一个奇怪的 Token，也不要把用户正常说话的内容
 *    打码——漏掉的形状可以往 `redactWords` 里补，误伤的语义补不回来。
 *
 * 与 magpie 的差异：magpie 在全局 Settings › Privacy 开关；这里**按连接**开
 * （`LlmProfile.mask`），因为「这个端点会不会存我数据」是逐家判断的，
 * 而且本仓没有全局隐私设置面板。默认关闭。
 */

import type { ChatMessage } from "./llmClient.js";

const KEY_INSTALL = "heming.llmMask.key.v1";
const KEY_WORDS = "heming.llmMask.words.v1";
const KEY_LEDGER = "heming.llmMask.ledger.v1";

/** 对照表最多留多少条（再多也不会被回头看；超了丢最早的）。 */
const MAX_LEDGER = 200;

export type MaskReason = "credential" | "idCard" | "word";

/** 对照表里的一条：占位符 ↔ 原文（只存本机，绝不进任何请求体）。 */
export interface MaskEntry {
  placeholder: string;
  original: string;
  reason: MaskReason;
  at: string;
}

/**
 * 内置形状：只认「几乎不可能是正常说话」的凭据长相。
 * 每条都要带 `\b` 边界，避免在长文本里吃掉半个词。
 */
const SHAPES: { re: RegExp; reason: MaskReason }[] = [
  // OpenAI/DeepSeek 那一系的 Key（含 sk-proj- 变体）
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, reason: "credential" },
  // GitHub 令牌
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, reason: "credential" },
  // 裸 JWT（三段式，第四段没有——多了就不是 JWT）
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, reason: "credential" },
  // Authorization 头的整段值（粘进对话里的 curl 常见）
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi, reason: "credential" },
  // 18 位身份证号（末位可为 X）
  { re: /\b\d{17}[\dXx]\b/g, reason: "idCard" },
];

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback; // 损坏数据回退默认（与各本机档同策略）
  }
}

/**
 * 本机钥匙（magpie `redact.key` 的对应物）：随机 6 位，进占位符里。
 * 作用是让占位符**不可被服务商猜出规律**（`〔隐去-1〕` 谁都能编一个冒充）。
 */
function installTag(): string {
  const stored = read<string>(KEY_INSTALL, "");
  if (/^[a-z0-9]{6}$/.test(stored)) return stored;
  const made = Array.from({ length: 6 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36)),
  ).join("");
  try {
    localStorage.setItem(KEY_INSTALL, JSON.stringify(made));
  } catch {
    /* 写不进去就用本次生成的，占位符照样唯一 */
  }
  return made;
}

/** 用户自定义要隐去的词（magpie `redactWords`）：大小写不敏感的整串替换。 */
export function maskWords(): string[] {
  return read<string[]>(KEY_WORDS, []).filter((w) => typeof w === "string" && w.trim() !== "");
}

export function setMaskWords(words: string[]): void {
  const clean = [...new Set(words.map((w) => w.trim()).filter((w) => w !== ""))];
  localStorage.setItem(KEY_WORDS, JSON.stringify(clean));
}

interface LedgerFile {
  seq: number;
  items: MaskEntry[];
}

function loadLedger(): LedgerFile {
  const f = read<Partial<LedgerFile>>(KEY_LEDGER, {});
  return {
    seq: typeof f.seq === "number" ? f.seq : 0,
    items: Array.isArray(f.items) ? f.items.filter((x) => x && typeof x.placeholder === "string") : [],
  };
}

/** 对照表（占位符 → 原文/理由/时刻）。界面图例用；原文只在本机。 */
export function maskLedger(): MaskEntry[] {
  return loadLedger().items;
}

export function clearMaskLedger(): void {
  localStorage.setItem(KEY_LEDGER, JSON.stringify({ seq: loadLedger().seq, items: [] }));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 打码一段文本。命中数为 0 时**原样返回同一个字符串**（不复制、不写盘），
 * 让「没隐去任何东西」这条路径与不开脱敏逐字等价。
 */
export function maskText(text: string): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  const ledger = loadLedger();
  const byOriginal = new Map<string, string>();
  for (const it of ledger.items) byOriginal.set(it.original, it.placeholder);
  const tag = installTag();
  const added: MaskEntry[] = [];
  let out = text;
  let hits = 0;

  const hold = (original: string, reason: MaskReason): string => {
    const known = byOriginal.get(original);
    if (known) return known;
    ledger.seq += 1;
    const placeholder = `〔隐去-${tag}-${ledger.seq}〕`;
    byOriginal.set(original, placeholder);
    added.push({ placeholder, original, reason, at: new Date().toISOString() });
    return placeholder;
  };

  for (const shape of SHAPES) {
    out = out.replace(shape.re, (m) => {
      hits++;
      return hold(m, shape.reason);
    });
  }
  for (const word of maskWords()) {
    out = out.replace(new RegExp(escapeRe(word), "gi"), (m) => {
      hits++;
      return hold(m, "word");
    });
  }

  if (added.length > 0) {
    const items = [...ledger.items, ...added].slice(-MAX_LEDGER);
    try {
      localStorage.setItem(KEY_LEDGER, JSON.stringify({ seq: ledger.seq, items }));
    } catch {
      /* 对照表写不进去（隐私模式/超额）不影响脱敏本身：占位符照样发出去 */
    }
  }
  return { text: out, hits };
}

/**
 * 打码整段出站消息：正文、内容片里的文本、工具调用参数。
 *
 * 只复制**真的被改过**的那几行（其余沿用原对象引用），
 * 因为调用方拿到的 messages 还要用于本机历史与用量估算。
 * 图片片不动：字节里没有可认的凭据形状，动了只会破坏图像。
 */
export function maskMessages(messages: ChatMessage[]): { messages: ChatMessage[]; hits: number } {
  let hits = 0;
  const out = messages.map((m) => {
    let changed = false;
    let next: ChatMessage | null = null;
    const commit = () => (next ??= { ...m });
    if (typeof m.content === "string" && m.content) {
      const r = maskText(m.content);
      if (r.hits > 0) {
        hits += r.hits;
        commit().content = r.text;
        changed = true;
      }
    }
    if (m.contentParts) {
      const parts = m.contentParts.map((part) => {
        if (part.type !== "text") return part;
        const r = maskText(part.text);
        if (r.hits === 0) return part;
        hits += r.hits;
        changed = true;
        return { ...part, text: r.text };
      });
      if (changed) commit().contentParts = parts;
    }
    if (m.tool_calls) {
      const calls = m.tool_calls.map((c) => {
        const args = c.function.arguments;
        if (typeof args !== "string" || !args) return c;
        const r = maskText(args);
        if (r.hits === 0) return c;
        hits += r.hits;
        changed = true;
        return { ...c, function: { ...c.function, arguments: r.text } };
      });
      if (changed) commit().tool_calls = calls;
    }
    return changed ? (next ?? m) : m;
  });
  return { messages: out, hits };
}
