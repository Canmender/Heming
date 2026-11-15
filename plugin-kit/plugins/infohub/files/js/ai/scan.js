/**
 * AI 日程识别：网关调用、批处理、候选解析与导出
 */

import { updateHomeCard } from '../app.js';
import { infohubCall, showError } from '../core/bridge.js';
import {
  AI_BATCH_CHARS,
  AI_BATCH_MESSAGES,
  AI_KIND_LABELS,
  AI_MAX_BATCHES,
  AI_MAX_CONVS,
  AI_MAX_ITEMS,
  AI_MAX_MSGS_PER_CONV,
  CONV_PAGE,
  SOURCE_LABELS,
} from '../core/constants.js';
import { el } from '../core/dom.js';
import { errText, fmtClock, fmtTime, formatDayLabel, pad, startOfDay, toMs } from '../core/format.js';
import { state } from '../core/state.js';
import { renderAgendaPane } from '../views/agenda.js';
import { aiSaveItems, aiSaveItemsSoon } from './prefs.js';

export const AI_SOURCES = [
  ["qq", "QQ"],
  ["wechat", "微信"],
];

/* ── 提示词与模型调用 ── */

export function aiSystemPrompt() {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const weekday = "日一二三四五六"[now.getDay()];
  const profile = String(state.ai.profile || "").trim();
  const lines = [
    "你是「信息中枢」的日程识别助手：从 QQ / 微信聊天记录里找出真正需要我处理或参加的事，整理成结构化列表。",
    `今天是 ${stamp}（星期${weekday}）。`,
    "判断标准：",
    "1. 只有出现明确日期、时间或期限，或者双方约定了要做的事，才算事项；闲聊、新闻、广告、表情、寒暄一律忽略。",
    "2. 相对时间（明天、周五、下周三、月底）必须换算成绝对日期；只有日期没有时刻时把 allDay 设为 true。",
    "3. 已经做完的旧事（例如「昨天已经交了」）不要提取，除非还能推出后续待办。",
    "4. 每条给出 detail（一句依据，不超过 60 字）与 ref（来源消息开头那串数字 id）。",
    "5. 同一件事在多条消息里出现只保留一条，合并信息；时间实在不确定就留空字符串。",
    "输出要求：只输出 JSON 数组，不要 markdown 代码块，也不要解释。没有事项就输出 []。",
    '每条字段：{"title":"事项（不超过 24 字，动宾短语）","due":"YYYY-MM-DD HH:mm 或 YYYY-MM-DD 或空字符串","allDay":false,"kind":"task|meeting|activity|exam|signup|payment|other","ref":"消息 id","detail":"依据","confidence":0.0}',
  ];
  if (profile) lines.push(`我的身份与语境（用户提供，用来判断哪些事与我有关）：${profile}`);
  return lines.join("\n");
}

export function aiAbortError() {
  if (typeof DOMException === "function") return new DOMException("已停止", "AbortError");
  const err = new Error("已停止");
  err.name = "AbortError";
  return err;
}

/* 把网关的 SSE 响应拼成纯文本（少数网关忽略 stream:false） */
export function sseText(raw) {
  let out = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      const delta = choice && (choice.delta || choice.message);
      if (delta && typeof delta.content === "string") out += delta.content;
    } catch (err) {
      /* 单行坏数据不影响其它行 */
    }
  }
  return out;
}

export async function gatewayChat(messages, signal, maxTokens) {
  const ai = state.ai;
  const gateway = ai.gateway;
  if (!gateway || !gateway.baseUrl) throw new Error("还没有可用的模型网关，请先在「设置 → 模型」里配置供应商");
  const url = `${String(gateway.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    signal: signal || undefined,
    headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key || "local"}` },
    body: JSON.stringify({
      model: ai.model,
      stream: false,
      max_tokens: maxTokens || 1200,
      messages,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`模型接口 HTTP ${resp.status}${body ? `：${body.slice(0, 160)}` : ""}`);
  }
  const type = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("content-type") || "" : "";
  const text = await resp.text();
  if (type.includes("event-stream") || /^\s*data:/.test(text)) return sseText(text);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error("模型返回的不是 JSON，请确认网关提供 OpenAI 兼容接口");
  }
  if (data && data.error) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error).slice(0, 160));
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : "";
  if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回内容");
  return content;
}

/* ── 候选消息收集 ── */

export function aiMessageText(message) {
  const raw = message && message.content != null ? message.content : "";
  return String(raw).replace(/\s+/g, " ").trim();
}

export function aiSkipMessage(message) {
  const text = aiMessageText(message);
  if (!text) return true;
  if (/^\[(媒体|图片|视频|语音|文件|表情|动画表情)/.test(text)) return true;
  if (message.is_self && text.length < 6) return true;
  return false;
}

export function aiConvLabel(conv) {
  const name = (conv && (conv.name || conv.id)) || "未知会话";
  const source = (conv && (SOURCE_LABELS[conv.source] || conv.source)) || "未知来源";
  return `${name}｜${source}`;
}

export async function fetchConvMessages(conversationId, sinceMs, signal) {
  const out = [];
  let beforeTs = 0;
  for (let page = 0; page < 3; page += 1) {
    if (signal && signal.aborted) throw aiAbortError();
    const params = { conversationId, limit: 400 };
    if (beforeTs) params.beforeTs = beforeTs;
    const payload = await infohubCall("messages", params, 120000);
    const rows = (payload && payload.items) || [];
    for (const row of rows) {
      const ts = toMs(row.ts);
      if (ts && ts < sinceMs) continue;
      if (aiSkipMessage(row)) continue;
      out.push(row);
    }
    if (!payload || !payload.hasMore || !rows.length) break;
    beforeTs = Number(payload.beforeTs) || toMs(rows[0].ts);
    if (!beforeTs) break;
    if (out.length >= AI_MAX_MSGS_PER_CONV) break;
  }
  out.sort((a, b) => toMs(a.ts) - toMs(b.ts));
  return out.slice(-AI_MAX_MSGS_PER_CONV);
}

export async function collectAiCandidates(sinceMs, sources, signal) {
  const picked = [];
  const seen = new Set();
  for (const [source] of AI_SOURCES) {
    if (!sources[source]) continue;
    if (signal && signal.aborted) throw aiAbortError();
    const page = await infohubCall("conversations", { source, limit: CONV_PAGE }, 120000);
    const rows = (page && page.items) || [];
    const fresh = rows
      .filter((row) => row && String(row.id || "").trim() && toMs(row.last_ts) >= sinceMs && !seen.has(row.id))
      .sort((a, b) => toMs(b.last_ts) - toMs(a.last_ts));
    for (const row of fresh) {
      if (picked.length >= AI_MAX_CONVS) break;
      seen.add(row.id);
      picked.push(row);
    }
  }
  picked.sort((a, b) => toMs(b.last_ts) - toMs(a.last_ts));
  const batch = [];
  const lookup = new Map();
  let messageCount = 0;
  for (const conv of picked) {
    if (signal && signal.aborted) throw aiAbortError();
    const messages = await fetchConvMessages(conv.id, sinceMs, signal);
    if (!messages.length) continue;
    for (const message of messages) lookup.set(String(message.id), aiConvLabel(conv));
    messageCount += messages.length;
    batch.push({ conv, messages });
  }
  return { batch, lookup, messageCount, convCount: batch.length };
}

export function aiConversationText(batch) {
  const lines = [];
  for (const entry of batch) {
    lines.push(`【${aiConvLabel(entry.conv)}】`);
    for (const message of entry.messages) {
      const sender = message.sender_name || message.senderName || "?";
      lines.push(`${message.id}|${fmtTime(message.ts, true)}|${sender}|${aiMessageText(message)}`);
    }
  }
  return lines;
}

/* 把「群名 + 消息行」按体积与条数切成若干批，保证每批都带上下文标题 */
export function buildAiBatches(batch) {
  const flat = [];
  for (const line of aiConversationText(batch)) {
    flat.push({ header: line.startsWith("【"), text: line });
  }
  const batches = [];
  let lines = [];
  let chars = 0;
  let count = 0;
  let pendingHeader = "";
  const flush = () => {
    if (!count) return;
    batches.push({ text: lines.join("\n"), messages: count });
    lines = [];
    chars = 0;
    count = 0;
  };
  for (const row of flat) {
    if (row.header) {
      pendingHeader = row.text;
      continue;
    }
    if (count >= AI_BATCH_MESSAGES || (chars + row.text.length > AI_BATCH_CHARS && count > 0)) {
      flush();
      if (pendingHeader) {
        lines.push(pendingHeader);
        chars += pendingHeader.length;
      }
    }
    if (!lines.length && pendingHeader) {
      lines.push(pendingHeader);
      chars += pendingHeader.length;
    }
    lines.push(row.text);
    chars += row.text.length;
    count += 1;
  }
  flush();
  return batches.slice(0, AI_MAX_BATCHES);
}

/* ── 模型输出解析与归一 ── */

export function aiParseJsonArray(content) {
  let text = String(content || "").trim();
  if (!text) return [];
  if (text.startsWith("```")) text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  } else if (text.startsWith("{")) {
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) text = text.slice(objStart, objEnd + 1);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    try {
      parsed = JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
    } catch (err2) {
      throw new Error("模型返回的内容不是合法 JSON 数组，可换一个模型再试");
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;
  if (parsed && Array.isArray(parsed.events)) return parsed.events;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  return [];
}

export function normalizeAiItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || raw.name || raw.summary || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  if (!title) return null;
  let dueMs = NaN;
  let dateOnly = false;
  const due = raw.due != null ? raw.due : raw.time != null ? raw.time : raw.when;
  if (typeof due === "number") {
    dueMs = toMs(due);
  } else if (typeof due === "string" && due.trim()) {
    const text = due.trim();
    // 只有日期（没有时刻）时按本地零点解析，别落成 UTC 零点而整体偏 8 小时
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const parts = text.split("-").map(Number);
      const day = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
      if (!Number.isNaN(day.getTime())) {
        dueMs = day.getTime();
        dateOnly = true;
      }
    } else {
      const clock = text.match(/(\d{1,2}):(\d{2})/);
      if (clock && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(text)) {
        const day = new Date(text.replace(/\//g, "-").slice(0, 10) + `T${pad(Number(clock[1]) || 0)}:${clock[2]}:00`);
        if (!Number.isNaN(day.getTime())) dueMs = day.getTime();
      }
    }
    if (!Number.isFinite(dueMs)) {
      const parsed = Date.parse(text.replace(/\//g, "-"));
      if (Number.isFinite(parsed)) dueMs = parsed;
    }
  }
  if (!(Number.isFinite(dueMs) && dueMs > 0)) dueMs = NaN;
  const allDay = raw.allDay === true || raw.all_day === true || (dateOnly && Number.isFinite(dueMs));
  const kindRaw = String(raw.kind || raw.type || "").toLowerCase();
  const kind = AI_KIND_LABELS[kindRaw] ? kindRaw : "other";
  const detail = String(raw.detail || raw.evidence || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const ref = String(raw.ref || raw.id || "").trim().slice(0, 24);
  const confidence = Number(raw.confidence);
  return {
    title,
    dueMs,
    allDay: allDay && Number.isFinite(dueMs),
    kind,
    detail,
    ref,
    source: "",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

export function aiItemKey(item) {
  const due = Number.isFinite(item.dueMs) ? String(Math.round(item.dueMs / 60000)) : "0";
  return `${String(item.title).replace(/\s+/g, "")}|${due}`;
}

export function sortAiItems(items) {
  return items.slice().sort((a, b) => {
    const left = Number.isFinite(a.dueMs) ? a.dueMs : Infinity;
    const right = Number.isFinite(b.dueMs) ? b.dueMs : Infinity;
    if (left !== right) return left - right;
    return String(a.title).localeCompare(String(b.title), "zh-Hans-CN");
  });
}

export function mergeAiItems(existing, incoming) {
  const map = new Map();
  for (const item of existing) map.set(aiItemKey(item), item);
  for (const item of incoming) {
    const key = aiItemKey(item);
    const prev = map.get(key);
    map.set(
      key,
      prev
        ? {
            ...prev,
            ...item,
            detail: item.detail || prev.detail,
            ref: item.ref || prev.ref,
            source: prev.source || item.source,
          }
        : item,
    );
  }
  return sortAiItems([...map.values()]).slice(0, AI_MAX_ITEMS);
}

/* ── 本地存取（插件私有目录，不写回日程库） ── */

export function aiPlainItem(item) {
  return {
    title: String(item.title || "").slice(0, 24),
    dueMs: Number.isFinite(item.dueMs) ? item.dueMs : 0,
    allDay: Boolean(item.allDay),
    kind: AI_KIND_LABELS[item.kind] ? item.kind : "other",
    detail: String(item.detail || "").slice(0, 120),
    ref: String(item.ref || "").slice(0, 24),
    source: String(item.source || "").slice(0, 60),
    confidence: Number(item.confidence) || 0,
  };
}

export async function runAiScan() {
  const ai = state.ai;
  if (ai.running) return;
  if (!state.status) {
    ai.error = "归档引擎还没就绪，先完成一次采集。";
    renderAgendaPane();
    return;
  }
  if (!ai.gateway) {
    ai.error = "没有可用的模型网关：请先在主窗口「设置 → 模型」里配置供应商。";
    renderAgendaPane();
    return;
  }
  if (!ai.model) {
    ai.error = "还没有选择模型。";
    renderAgendaPane();
    return;
  }
  if (!ai.allowSend) {
    ai.error = "先勾选「允许把最近聊天的原文发送给模型供应商」，再开始识别。";
    renderAgendaPane();
    return;
  }
  const seq = ai.seq + 1;
  ai.seq = seq;
  ai.controller = typeof AbortController === "function" ? new AbortController() : null;
  ai.running = true;
  ai.error = "";
  ai.note = "";
  ai.done = 0;
  ai.total = 0;
  ai.stage = "读取归档";
  renderAgendaPane();
  const signal = ai.controller ? ai.controller.signal : null;
  const sinceMs = Date.now() - ai.days * 24 * 60 * 60 * 1000;
  let scanned = 0;
  const beforeCount = ai.items.length;
  try {
    const collected = await collectAiCandidates(sinceMs, ai.sources, signal);
    if (ai.seq !== seq) return;
    scanned = collected.messageCount;
    if (!collected.batch.length) {
      ai.note = `最近 ${ai.days} 天没有可识别的消息。`;
      return;
    }
    const batches = buildAiBatches(collected.batch);
    if (!batches.length) {
      ai.note = "没有能塞进一次请求的消息。";
      return;
    }
    ai.total = batches.length;
    ai.stage = "请模型识别";
    renderAgendaPane();
    for (let index = 0; index < batches.length; index += 1) {
      if (ai.seq !== seq) return;
      ai.stage = `识别第 ${index + 1}/${batches.length} 批`;
      updateAiProgress();
      const content = await gatewayChat(
        [
          { role: "system", content: aiSystemPrompt() },
          {
            role: "user",
            content: `以下是 QQ / 微信聊天记录，每行格式为「消息 id|时间|发送者|内容」。请找出最近 ${ai.days} 天内需要我处理或参加的事，按约定输出 JSON 数组。\n\n${batches[index].text}`,
          },
        ],
        signal,
        1200,
      );
      if (ai.seq !== seq) return;
      const rows = aiParseJsonArray(content);
      const parsed = [];
      for (const row of rows) {
        const item = normalizeAiItem(row);
        if (!item) continue;
        if (item.ref && collected.lookup.has(item.ref)) item.source = collected.lookup.get(item.ref);
        parsed.push(item);
      }
      if (parsed.length) {
        ai.items = mergeAiItems(ai.items, parsed);
        ai.savedAt = Date.now();
        aiSaveItemsSoon();
      }
      ai.done = index + 1;
      updateAiProgress();
    }
    ai.items = sortAiItems(ai.items).slice(0, AI_MAX_ITEMS);
    ai.savedAt = Date.now();
    await aiSaveItems();
    ai.stage = "";
    ai.note = `扫了 ${collected.convCount} 个会话 / ${scanned} 条消息，本次新增 ${Math.max(0, ai.items.length - beforeCount)} 条，表格共 ${ai.items.length} 条。结果只在本机，可编辑后导出。`;
    updateHomeCard();
  } catch (err) {
    if (err && err.name === "AbortError") {
      ai.note = "已停止识别，已完成的部分保留。";
    } else {
      ai.error = `识别失败：${errText(err)}`;
    }
  } finally {
    if (ai.seq === seq) {
      ai.running = false;
      ai.controller = null;
      ai.stage = "";
      ai.done = 0;
      ai.total = 0;
      renderAgendaPane();
    }
  }
}

export function stopAiScan() {
  const ai = state.ai;
  if (!ai.running) return;
  ai.seq += 1;
  if (ai.controller) {
    try {
      ai.controller.abort();
    } catch (err) {
      /* 忽略 */
    }
  }
  ai.controller = null;
  ai.running = false;
  ai.stage = "";
  ai.done = 0;
  ai.total = 0;
  ai.note = "已停止识别，已完成的部分保留。";
  renderAgendaPane();
}

export function updateAiProgress() {
  const ai = state.ai;
  const fill = el("ai-progress-fill");
  const text = el("ai-progress-text");
  if (fill) fill.style.width = `${ai.total ? Math.round((ai.done / ai.total) * 100) : 0}%`;
  if (text) text.textContent = `${ai.stage} · ${ai.done}/${ai.total || "?"} 批 · 已识别 ${ai.items.length} 条`;
}

/* ── 渲染 ── */

export function aiKindLabel(kind) {
  return AI_KIND_LABELS[kind] || "其他";
}

export function aiInputValue(ms) {
  if (!Number.isFinite(ms)) return "";
  const day = new Date(ms);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(day.getHours())}:${pad(day.getMinutes())}`;
}

export function aiParseLocal(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : NaN;
}

/* 首页卡只取前三条（按时间排序后的结果），比纯规则抽取更贴近用户关心的事 */
export function aiHighlights() {
  const lines = [];
  for (const item of state.ai.items) {
    if (!item || !item.title) continue;
    const when = Number.isFinite(item.dueMs)
      ? item.allDay
        ? formatDayLabel(item.dueMs)
        : `${formatDayLabel(item.dueMs)} ${fmtClock(item.dueMs)}`.trim()
      : "";
    const line = when ? `${when} · ${item.title}` : String(item.title);
    lines.push(line.length > 40 ? `${line.slice(0, 39)}…` : line);
    if (lines.length >= 3) break;
  }
  return lines;
}

export function aiResultsMeta(items) {
  const todayStart = startOfDay(Date.now());
  const tomorrow = todayStart + 24 * 60 * 60 * 1000;
  let overdue = 0;
  let today = 0;
  for (const item of items) {
    if (!Number.isFinite(item.dueMs)) continue;
    if (item.dueMs < todayStart) overdue += 1;
    else if (item.dueMs < tomorrow) today += 1;
  }
  return { overdue, today };
}

export function aiCsvCell(value) {
  const text = String(value == null ? "" : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function aiTsv(items) {
  const rows = [["时间", "事项", "类型", "依据"]];
  for (const item of items) {
    rows.push([
      Number.isFinite(item.dueMs) ? (item.allDay ? formatDayLabel(item.dueMs) : `${formatDayLabel(item.dueMs)} ${fmtClock(item.dueMs)}`) : "未定",
      item.title,
      aiKindLabel(item.kind),
      item.detail || "",
    ]);
  }
  return rows.map((row) => row.map((cell) => String(cell).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

export function aiCsv(items) {
  const rows = [["时间", "事项", "类型", "依据"]];
  for (const item of items) {
    rows.push([
      Number.isFinite(item.dueMs) ? fmtTime(item.dueMs, true) : "未定",
      item.title,
      aiKindLabel(item.kind),
      item.detail || "",
    ]);
  }
  return `\ufeff${rows.map((row) => row.map(aiCsvCell).join(",")).join("\r\n")}`;
}

export function exportAiCsv(items) {
  if (!items.length) return;
  try {
    const blob = new Blob([aiCsv(items)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `日程-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    showError(`导出失败：${errText(err)}；可以改用「复制表格」。`);
  }
}

export function clearAiItems() {
  const ai = state.ai;
  if (!ai.items.length) return;
  ai.items = [];
  ai.savedAt = 0;
  ai.note = "已清空识别结果。";
  aiSaveItems();
  updateHomeCard();
  renderAgendaPane();
}
