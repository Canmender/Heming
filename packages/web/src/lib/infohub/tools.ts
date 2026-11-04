import type { ToolBridge, ToolSource } from "../agentStream.js";
import {
  callInfohub,
  describeInfohubError,
  formatInfohubTime,
  isInfohubAvailable,
  readInfohubConfig,
  type InfohubAgendaResult,
  type InfohubConfig,
  type InfohubConversation,
  type InfohubConversationsResult,
  type InfohubMessage,
  type InfohubMessagesResult,
  type InfohubSearchHit,
  type InfohubSearchResult,
} from "./client.js";
import { canUseInfohub, useInfohubStore } from "./store.js";
import { isModuleOn } from "../modules/store.js";

/**
 * 本机归档工具（d.46）：让智能体直接检索/阅读 InfoHub 的 QQ/微信归档。
 *
 * 边界与 d.45 一致：
 * - 只在桌面端且进程已连接时注入；**不自动 spawn**，未连接就这轮不给工具；
 * - 读取走只读归档；唯一写操作是重扫日程，显式声明 `write` 交给 HITL；
 * - 同步（sync）不暴露为工具——它写归档、耗时最长，继续只留在信息中枢页。
 */

export const INFOHUB_TOOL_PREFIX = "infohub_";

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 20;
const CONVERSATION_LIMIT_DEFAULT = 30;
const CONVERSATION_LIMIT_MAX = 100;
const AGENDA_ITEMS_MAX = 40;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

const CONVERSATION_PROP = {
  type: "string",
  description: "归档里的会话名（如「叶老师」）或数字会话 id。",
};

export const INFOHUB_TOOLS = [
  tool(
    "infohub_search",
    "在本机 QQ/微信历史归档（和鸣之外）中全文检索消息。只用于回答「以前在群里/私聊里说过什么、找历史记录」这类问题；不要用它查和鸣当前会话。返回消息片段、会话名、发送者与时间。",
    {
      query: { type: "string", description: "检索关键词；中文短语可直接输入。" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
        description: `返回条数上限，默认 ${SEARCH_LIMIT_DEFAULT}。`,
      },
    },
    ["query"],
  ),
  tool(
    "infohub_read_conversation",
    "读取本机归档中某个 QQ/微信会话的最近消息（按时间正序）。适合在 infohub_search 命中后看上下文；会话名有歧义时会返回候选列表。",
    {
      conversation: CONVERSATION_PROP,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: CONVERSATION_LIMIT_MAX,
        description: `返回最近多少条，默认 ${CONVERSATION_LIMIT_DEFAULT}。`,
      },
      beforeTs: { type: "integer", minimum: 1, description: "只取早于此 Unix 秒时间戳的消息（翻页用）。" },
    },
    ["conversation"],
  ),
  tool(
    "infohub_agenda",
    "查看从本机归档消息中抽取的日程/待办（截止时间、逾期、今天、本周）。只读。",
    {
      days: { type: "integer", minimum: 0, maximum: 90, description: "往后看多少天，默认 14。" },
      overdue: { type: "integer", minimum: 0, maximum: 90, description: "往前看多少天的逾期项，默认 30。" },
    },
  ),
  tool(
    "infohub_agenda_rebuild",
    "重新扫描本机归档消息并抽取出日程（写操作，需用户确认）。仅在用户明确说「重扫/刷新日程」时使用。",
    {
      days: { type: "integer", minimum: 0, maximum: 90, description: "重扫后往后看多少天，默认 14。" },
      overdue: { type: "integer", minimum: 0, maximum: 90, description: "重扫后往前看多少天的逾期项，默认 30。" },
    },
  ),
];

const DISPLAY_NAMES: Record<string, string> = {
  infohub_search: "检索本机归档",
  infohub_read_conversation: "读取本机归档会话",
  infohub_agenda: "查看本机日程",
  infohub_agenda_rebuild: "重扫本机日程",
};

function parseArgs(raw: string): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function oneLine(text: unknown, max = 220): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  return source || "归档";
}

function config(): InfohubConfig {
  return readInfohubConfig();
}

/** 未就绪时给模型一句可执行的指引；就绪返回 null。 */
function notReady(): string | null {
  if (!isInfohubAvailable()) return "信息中枢仅桌面端可用，无法读取本机归档。";
  if (!useInfohubStore.getState().running) {
    return "信息中枢尚未连接。请先在「信息中枢」页连接本机归档，再让我检索。";
  }
  return null;
}

function hitSource(hit: InfohubSearchHit): ToolSource {
  return {
    id: `infohub:message:${hit.id}`,
    title: `${hit.convName} · ${hit.senderName} · ${formatInfohubTime(hit.ts, true)}`,
    detail: `${sourceLabel(hit.source)} · 本机归档`,
    kind: "archive",
  };
}

function messageText(message: InfohubMessage): string {
  const text = (message.content ?? "").trim();
  if (text) return text;
  if (message.media) {
    if (message.media.kind === "image") return "[图片]";
    if (message.media.kind === "voice") return "[语音]";
    return `[${message.media.name || message.media.kind}]`;
  }
  return message.type_label || "(空消息)";
}

function candidateList(items: InfohubConversation[]): string {
  return items
    .slice(0, 10)
    .map((c) => `- ${c.name}（${sourceLabel(c.source)}，id=${c.id}）`)
    .join("\n");
}

async function browseTool(name: string, args: Record<string, unknown>) {
  const cfg = config();

  switch (name) {
    case "infohub_search": {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
      if (!query) return { text: "query 不能为空。", ok: false };
      const limit = intArg(args.limit, SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX);
      const data = await callInfohub<InfohubSearchResult>("search", { query, limit }, cfg);
      if (data.dbMissing) {
        return { text: "本机归档库还不存在：请先在信息中枢页完成一次同步。", ok: true };
      }
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        return { text: `本机归档里没有匹配「${query}」的消息。`, ok: true };
      }
      const lines = items.map(
        (h, i) =>
          `${i + 1}. [${sourceLabel(h.source)}] ${h.convName} · ${formatInfohubTime(h.ts, true)} · ${h.senderName}：${oneLine(h.content)}`,
      );
      return {
        text: [
          `在本机归档找到 ${items.length} 条匹配「${query}」的消息：`,
          ...lines,
          "这些是用户本机的历史聊天记录；回答时请注明来自本机归档，不要当成和鸣当前会话的消息。",
        ].join("\n"),
        ok: true,
        sources: items.slice(0, 8).map(hitSource),
      };
    }

    case "infohub_read_conversation": {
      const ref = String(args.conversation ?? "").trim().slice(0, 100);
      if (!ref) return { text: "conversation 不能为空（会话名或 id）。", ok: false };
      const limit = intArg(args.limit, CONVERSATION_LIMIT_DEFAULT, 1, CONVERSATION_LIMIT_MAX);
      const beforeTs = intArg(args.beforeTs, 0, 0, 2 ** 31 - 1);

      let conversationId = /^\d+$/.test(ref) ? Number(ref) : 0;
      let note = "";
      if (!conversationId) {
        const found = await callInfohub<InfohubConversationsResult>(
          "conversations",
          { keyword: ref, limit: 20 },
          cfg,
        );
        if (found.dbMissing) {
          return { text: "本机归档库还不存在：请先在信息中枢页完成一次同步。", ok: true };
        }
        const items = Array.isArray(found.items) ? found.items : [];
        if (items.length === 0) {
          return { text: `本机归档里没有名字包含「${ref}」的会话。`, ok: true };
        }
        const exact = items.filter((c) => c.name === ref);
        const pool = exact.length > 0 ? exact : items;
        if (exact.length === 0 && pool.length > 1) {
          return {
            text: `「${ref}」匹配到多个会话，请用更精确的名称或 id：\n${candidateList(pool)}`,
            ok: true,
          };
        }
        conversationId = pool[0].id;
        if (pool.length > 1) note = `（同名会话 ${pool.length} 个，取最近活跃的一个）`;
      }

      const data = await callInfohub<InfohubMessagesResult>(
        "messages",
        { conversationId, limit, ...(beforeTs > 0 ? { beforeTs } : {}) },
        cfg,
      );
      if (data.dbMissing) {
        return { text: "本机归档库还不存在：请先在信息中枢页完成一次同步。", ok: true };
      }
      const conv = data.conversation;
      const items = Array.isArray(data.items) ? data.items : [];
      if (!conv) return { text: `归档里找不到会话 id=${conversationId}。`, ok: false };
      if (items.length === 0) {
        return { text: `会话「${conv.name}」存在，但归档里没有消息。`, ok: true };
      }
      const lines = items.map(
        (m) =>
          `${formatInfohubTime(m.ts, true)} ${m.is_self ? "我" : m.sender_name}：${oneLine(messageText(m), 200)}`,
      );
      return {
        text: [
          `会话「${conv.name}」（${sourceLabel(conv.source)}）最近 ${items.length} 条消息${note}，按时间正序：`,
          ...lines,
          data.hasMore ? "（更早的消息可用 beforeTs 继续翻页。）" : "",
        ]
          .filter(Boolean)
          .join("\n"),
        ok: true,
        sources: [
          {
            id: `infohub:conversation:${conv.id}`,
            title: `${conv.name} · 最近 ${items.length} 条`,
            detail: `${sourceLabel(conv.source)} · 本机归档`,
            kind: "archive" as const,
          },
        ],
      };
    }

    case "infohub_agenda":
    case "infohub_agenda_rebuild": {
      const days = intArg(args.days, 14, 0, 90);
      const overdue = intArg(args.overdue, 30, 0, 90);
      const rebuild = name === "infohub_agenda_rebuild";
      const data = await callInfohub<InfohubAgendaResult>(
        "agenda",
        { days, overdue, ...(rebuild ? { rebuild: true } : {}) },
        cfg,
      );
      if (data.dbMissing) {
        return { text: "本机归档库还不存在：请先在信息中枢页完成一次同步。", ok: true };
      }
      const items = Array.isArray(data.items) ? data.items : [];
      const summary = data.summary ?? { overdue: 0, today: 0, week: 0, total: 0 };
      const header = `${rebuild ? "已重扫本机归档日程。" : "本机归档日程"}逾期 ${summary.overdue} · 今天 ${summary.today} · 本周 ${summary.week} · 共 ${summary.total}。`;
      if (items.length === 0) return { text: `${header}\n没有待办事项。`, ok: true };
      const lines = items.slice(0, AGENDA_ITEMS_MAX).map(
        (item, i) =>
          `${i + 1}. ${item.title} · 截止 ${item.dueText || formatInfohubTime(item.dueTs, true) || "未标注"} · ${item.convName || sourceLabel(item.source)}${item.detail ? ` · ${oneLine(item.detail, 120)}` : ""}`,
      );
      return {
        text: [header, ...lines, items.length > AGENDA_ITEMS_MAX ? `（仅列出前 ${AGENDA_ITEMS_MAX} 条。）` : ""]
          .filter(Boolean)
          .join("\n"),
        ok: true,
        sources: items.slice(0, 8).map((item) => ({
          id: `infohub:agenda:${item.id}`,
          title: `${item.title} · ${item.dueText || formatInfohubTime(item.dueTs, true)}`,
          detail: `${item.convName || sourceLabel(item.source)} · 本机日程`,
          kind: "archive" as const,
        })),
      };
    }

    default:
      return { text: `未知工具 ${name}`, ok: false };
  }
}

export function buildInfohubToolBridge(): ToolBridge {
  return {
    tools: INFOHUB_TOOLS,
    meta: (name) => {
      const displayName = DISPLAY_NAMES[name];
      if (!displayName) return undefined;
      return { risk: name === "infohub_agenda_rebuild" ? "write" : "read", displayName };
    },
    execute: async (call) => {
      const ready = notReady();
      if (ready) return { text: ready, ok: false };
      try {
        return await browseTool(call.name, parseArgs(call.arguments));
      } catch (err) {
        return { text: `读取本机归档失败：${describeInfohubError(err)}`, ok: false };
      }
    },
  };
}

/** 只在桌面端且已连接时提供归档工具。 */
export function buildInfohubToolsIfConnected(): ToolBridge | null {
  // d.70：信息中枢模块停用后，工具与页面一起下线——否则模型仍能检索用户以为「已关掉」的归档
  if (!isModuleOn("infohub")) return null;
  return canUseInfohub() ? buildInfohubToolBridge() : null;
}
