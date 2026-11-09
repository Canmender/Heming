/**
 * 和鸣能力节点：大模型、本机归档（检索/日程/同步）、站内通知。
 *
 * 为什么放在集成节点里而不是核心节点：它们都依赖「和鸣自己的本机能力」
 * （模型连接、InfoHub 边车、通知中心），不是通用数据处理；放在一起便于说明
 * 这条边界——工作流不把数据发给和鸣之外的服务器，除非用户自己配了 HTTP/模型连接。
 */

import { streamChat, type ChatMessage } from "../../../llmClient.js";
import {
  callInfohub,
  describeInfohubError,
  isInfohubAvailable,
  readInfohubConfig,
  type InfohubAgendaResult,
  type InfohubSearchResult,
  type InfohubSyncResult,
} from "../../../infohub/client.js";
import { canUseInfohub } from "../../../infohub/store.js";
import { useLlmStore } from "../../../../store/llm.js";
import { useNotificationStore } from "../../../../store/notifications.js";
import type { INodeType, Item } from "../../types.js";
import { errorText, inputItems, readNumber, readString, withField } from "./helpers.js";

/** 归档能力不可用时的可读原因（不自动拉起边车，与 d.45/d.47 红线一致）。 */
function infohubBlockedReason(): string {
  if (!isInfohubAvailable()) return "信息中枢只在桌面端可用；请用桌面版打开这条工作流";
  if (!canUseInfohub()) return "信息中枢还没有连接；先到「信息中枢」页连接本机归档";
  return "";
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

const llmNode: INodeType = {
  description: {
    type: "llm",
    displayName: "大模型",
    group: "ai",
    description: "用本机保存的模型连接发一次补全请求；结果作为 text 字段输出。",
    icon: "sparkles",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "connection",
        displayName: "模型连接",
        type: "string",
        default: "",
        description: "填设置区里模型连接的 id；留空则用第一条可用连接。",
        placeholder: "留空用第一条连接",
      },
      {
        name: "systemPrompt",
        displayName: "系统提示",
        type: "multiline",
        default: "",
        description: "给模型的角色/规则；可留空。",
        rows: 3,
      },
      {
        name: "userPrompt",
        displayName: "用户提示",
        type: "multiline",
        default: "{{ $json }}",
        description: "要发送的内容，支持 {{ }} 表达式。",
        rows: 5,
      },
      {
        name: "outputJson",
        displayName: "输出 JSON",
        type: "boolean",
        default: false,
        description: "开启后尝试把模型输出解析成 JSON，解析失败仍保留原文。",
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "text",
        description: "把模型输出写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const profiles = useLlmStore.getState().profiles;
    const wanted = readString(context, "connection", "").trim();
    const profile = wanted ? profiles.find((item) => item.id === wanted) : profiles[0];
    if (!profile) {
      throw new Error(
        wanted
          ? `找不到模型连接：${wanted}（可能已被删除）`
          : "还没有可用的模型连接；先到设置区添加一条模型连接",
      );
    }
    const userPrompt = readString(context, "userPrompt", "{{ $json }}").trim();
    if (!userPrompt) throw new Error("用户提示不能为空");
    const systemPrompt = readString(context, "systemPrompt", "").trim();
    const outputField = readString(context, "outputField", "text") || "text";

    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    let text = "";
    try {
      text = await streamChat(profile, messages, {
        signal: context.abortSignal,
        onDelta: () => {
          /* 这里不需要流式展示；引擎在节点结束后一次性给结果 */
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("大模型请求已取消");
      throw new Error(`模型调用失败：${errorText(err)}`);
    }

    if (!text.trim()) throw new Error("模型没有返回内容");

    let value: unknown = text;
    if (readString(context, "outputJson", "") === "true" || context.getNodeParameter<boolean>("outputJson", false)) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = text;
      }
    }
    return withField(inputItems(context), outputField, value);
  },
};

const infohubSearchNode: INodeType = {
  description: {
    type: "infohubSearch",
    displayName: "归档检索",
    group: "action",
    description: "在本机 QQ / 微信历史归档里全文检索消息（只读，不出本机）。",
    icon: "search",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "query",
        displayName: "检索词",
        type: "string",
        default: "",
        required: true,
        description: "要查找的关键词/短语，支持 {{ }} 表达式。",
      },
      {
        name: "limit",
        displayName: "返回条数",
        type: "number",
        default: 20,
        description: "最多返回多少条命中（1–100）。",
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "hits",
        description: "把命中数组写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const blocked = infohubBlockedReason();
    if (blocked) throw new Error(blocked);
    const query = readString(context, "query", "").trim();
    if (!query) throw new Error("检索词不能为空");
    const limit = Math.max(1, Math.min(100, Math.trunc(readNumber(context, "limit", 20))));
    const outputField = readString(context, "outputField", "hits") || "hits";
    try {
      const data = await callInfohub<InfohubSearchResult>("search", { query, limit }, readInfohubConfig());
      const hits = (Array.isArray(data.items) ? data.items : []).map((hit) => ({
        source: hit.source,
        conversation: hit.convName,
        sender: hit.senderName,
        ts: hit.ts,
        content: hit.content,
      }));
      return withField(inputItems(context), outputField, hits);
    } catch (err) {
      throw new Error(`检索本机归档失败：${describeInfohubError(err)}`);
    }
  },
};

const infohubAgendaNode: INodeType = {
  description: {
    type: "infohubAgenda",
    displayName: "归档日程",
    group: "action",
    description: "读取从本机归档里抽取的日程/待办摘要（只读）。",
    icon: "calendar",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "days",
        displayName: "往后看几天",
        type: "number",
        default: 14,
        description: "未来多少天内的日程（0–90）。",
      },
      {
        name: "overdue",
        displayName: "往前看几天",
        type: "number",
        default: 30,
        description: "逾期多少天内的日程（0–90）。",
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "agenda",
        description: "把日程摘要写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const blocked = infohubBlockedReason();
    if (blocked) throw new Error(blocked);
    const days = Math.max(0, Math.min(90, Math.trunc(readNumber(context, "days", 14))));
    const overdue = Math.max(0, Math.min(90, Math.trunc(readNumber(context, "overdue", 30))));
    const outputField = readString(context, "outputField", "agenda") || "agenda";
    try {
      const data = await callInfohub<InfohubAgendaResult>("agenda", { days, overdue }, readInfohubConfig());
      const items = (Array.isArray(data.items) ? data.items : []).map((item) => ({
        id: item.id,
        title: item.title,
        dueTs: item.dueTs,
        dueText: item.dueText,
        conversation: item.convName,
        detail: item.detail,
      }));
      return withField(inputItems(context), outputField, {
        summary: data.summary ?? { overdue: 0, today: 0, week: 0, total: items.length },
        items,
      });
    } catch (err) {
      throw new Error(`读取本机日程失败：${describeInfohubError(err)}`);
    }
  },
};

const infohubSyncNode: INodeType = {
  description: {
    type: "infohubSync",
    displayName: "归档同步",
    group: "action",
    description: "把 QQ / 微信的新消息同步到本机归档（写操作；来源必须显式选择）。",
    icon: "archive",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "sources",
        displayName: "来源",
        type: "multiOptions",
        default: ["qq", "wechat"],
        required: true,
        options: [
          { name: "QQ", value: "qq" },
          { name: "微信", value: "wechat" },
        ],
        description: "只同步勾选的来源；不勾选不会放宽成「全部」。",
      },
      {
        name: "full",
        displayName: "全量重扫",
        type: "boolean",
        default: false,
        description: "开启后从头扫描，耗时明显更长。",
      },
      {
        name: "archive",
        displayName: "导出知识库",
        type: "boolean",
        default: false,
        description: "同步后把归档导出到知识库（与信息中枢页的开关同义）。",
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "sync",
        description: "把同步摘要写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const blocked = infohubBlockedReason();
    if (blocked) throw new Error(blocked);
    const rawSources = context.getNodeParameter<unknown>("sources", []);
    const sources = (Array.isArray(rawSources) ? rawSources : []).filter(
      (item): item is string => item === "qq" || item === "wechat",
    );
    if (sources.length === 0) throw new Error("至少要选择一个来源");
    const full = context.getNodeParameter<boolean>("full", false) === true;
    const archive = context.getNodeParameter<boolean>("archive", false) === true;
    const outputField = readString(context, "outputField", "sync") || "sync";
    try {
      const data = await callInfohub<InfohubSyncResult>(
        "sync",
        { sources, full, archive },
        readInfohubConfig(),
      );
      const reports = Array.isArray(data.reports) ? data.reports : [];
      return withField(inputItems(context), outputField, {
        added: reports.reduce((sum, report) => sum + (report.added ?? 0), 0),
        updated: reports.reduce((sum, report) => sum + (report.updated ?? 0), 0),
        errors: reports.flatMap((report) => report.errors ?? []),
        reports,
      });
    } catch (err) {
      throw new Error(`同步本机归档失败：${describeInfohubError(err)}`);
    }
  },
};

const notificationNode: INodeType = {
  description: {
    type: "notification",
    displayName: "站内通知",
    group: "output",
    description: "往和鸣的通知中心推一条消息；可接在流程末尾做结果提醒。",
    icon: "bell",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "title",
        displayName: "标题",
        type: "string",
        default: "工作流通知",
        required: true,
        description: "通知标题，支持 {{ }} 表达式。",
      },
      {
        name: "body",
        displayName: "正文",
        type: "multiline",
        default: "",
        description: "通知正文，支持 {{ }} 表达式；留空只显示标题。",
        rows: 3,
      },
      {
        name: "passThrough",
        displayName: "继续传递输入",
        type: "boolean",
        default: true,
        description: "关闭后该节点只产出一条通知结果，不再把输入往下传。",
      },
    ],
  },

  async execute(context) {
    const title = readString(context, "title", "工作流通知").trim();
    if (!title) throw new Error("通知标题不能为空");
    const body = clip(readString(context, "body", ""), 200);
    const executionId = context.executionId;
    // key 带执行 id 与节点 id：同一次执行重试时不刷屏，不同执行各留一条。
    const key = `workflow:${executionId}:${context.node.id}`;
    const pushed = useNotificationStore.getState().push({
      kind: "automation",
      key,
      title,
      body,
    });
    const items: Item[] = context.getNodeParameter<boolean>("passThrough", true)
      ? inputItems(context)
      : [];
    if (items.length > 0) return items;
    return [{ json: { notified: pushed !== null, title } }];
  },
};

export const integrationNodes: INodeType[] = [
  llmNode,
  infohubSearchNode,
  infohubAgendaNode,
  infohubSyncNode,
  notificationNode,
];
