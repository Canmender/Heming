/**
 * 集成节点（去宿主化）：大模型、本机通知、通用 MCP 工具调用。
 *
 * 与旧宿主版的区别：
 * - 不再 import 和鸣的 store / llmClient / InfoHub 客户端；
 * - 大模型走任何 OpenAI 兼容端点（`{WF_LLM_BASE_URL}/chat/completions`），配置来自环境变量；
 * - 通知写本机 `data/notifications.jsonl`（可选再 POST 一个 webhook）；
 * - InfoHub 专属节点改成通用 `mcpTool`：任何本机 HTTP MCP 服务都能调，不绑死某个产品。
 *
 * 边界：这些节点是工作流主动出网的入口（加上 HTTP 节点）；代码节点没有网络能力。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { INodeType, Item } from "../../types.js";
import { errorText, inputItems, readNumber, readString, withField } from "./helpers.js";

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function dataDir(): string {
  return process.env.WF_DATA_DIR || resolve(process.cwd(), "data");
}

interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function readLlmSettings(): LlmSettings | null {
  const baseUrl = String(process.env.WF_LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.WF_LLM_API_KEY ?? "").trim();
  const model = String(process.env.WF_LLM_MODEL ?? "").trim();
  return baseUrl && model ? { baseUrl, apiKey, model } : null;
}

/** OpenAI 兼容的非流式补全；失败给可读中文（带状态码与响应片段）。 */
async function chatCompletion(options: {
  settings: LlmSettings;
  system?: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: options.user });
  const response = await fetch(`${options.settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.settings.apiKey ? { authorization: `Bearer ${options.settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.settings.model,
      messages,
      max_tokens: options.maxTokens,
      stream: false,
    }),
  });
  if (!response.ok) {
    const detail = clip((await response.text().catch(() => "")) || "", 300);
    throw new Error(`模型调用失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text ?? "") : "",
      )
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// 大模型
// ---------------------------------------------------------------------------

const llmNode: INodeType = {
  description: {
    type: "llm",
    displayName: "大模型",
    group: "ai",
    description: "用本机配置的 OpenAI 兼容模型发一次补全请求；结果写到字段里。",
    icon: "sparkles",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
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
        name: "maxTokens",
        displayName: "最大输出",
        type: "number",
        default: 1024,
        description: "最多生成多少 token。",
      },
      {
        name: "outputJson",
        displayName: "输出 JSON",
        type: "boolean",
        default: false,
        description: "开启后尝试把模型输出解析成 JSON，失败时保留原文。",
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
    const settings = readLlmSettings();
    if (!settings) {
      throw new Error(
        "还没有配置模型连接：设置 WF_LLM_BASE_URL / WF_LLM_API_KEY / WF_LLM_MODEL 环境变量，或写 data/config.json 的 llm 字段",
      );
    }
    const userPrompt = readString(context, "userPrompt", "{{ $json }}").trim();
    if (!userPrompt) throw new Error("用户提示不能为空");
    const systemPrompt = readString(context, "systemPrompt", "").trim();
    const maxTokens = Math.max(1, Math.min(32768, Math.trunc(readNumber(context, "maxTokens", 1024))));
    const outputField = readString(context, "outputField", "text") || "text";

    let text: string;
    try {
      text = await chatCompletion({ settings, system: systemPrompt, user: userPrompt, maxTokens });
    } catch (error) {
      throw new Error(`大模型请求失败：${errorText(error)}`);
    }
    if (!text.trim()) throw new Error("模型没有返回内容");

    let value: unknown = text;
    if (context.getNodeParameter<boolean>("outputJson", false) === true) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = text;
      }
    }
    return withField(inputItems(context), outputField, value);
  },
};

// ---------------------------------------------------------------------------
// 本机通知
// ---------------------------------------------------------------------------

const notificationNode: INodeType = {
  description: {
    type: "notification",
    displayName: "本机通知",
    group: "output",
    description: "往本机通知日志写一条（可选再 POST 一个 webhook）；可接在流程末尾做结果提醒。",
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
        description: "通知正文，支持 {{ }} 表达式；留空只写标题。",
        rows: 3,
      },
      {
        name: "webhookUrl",
        displayName: "Webhook（可选）",
        type: "string",
        default: "",
        placeholder: "https://example.com/hook",
        description: "填写后额外 POST 一份 {title,body,workflowId} 到这个地址。",
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
    const body = clip(readString(context, "body", ""), 500);
    const record = { title, body, workflowId: context.workflow.id, at: Date.now() };
    try {
      mkdirSync(dataDir(), { recursive: true });
      appendFileSync(resolve(dataDir(), "notifications.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      throw new Error(`通知写入失败：${errorText(error)}`);
    }

    const webhookUrl = readString(context, "webhookUrl", "").trim();
    if (webhookUrl) {
      if (!/^https?:\/\//i.test(webhookUrl)) throw new Error("Webhook 地址必须是 http/https");
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        throw new Error(`Webhook 推送失败：${errorText(error)}`);
      }
    }

    const items: Item[] = context.getNodeParameter<boolean>("passThrough", true) ? inputItems(context) : [];
    if (items.length > 0) return items;
    return [{ json: { notified: true, title } }];
  },
};

// ---------------------------------------------------------------------------
// 通用 MCP 工具调用
// ---------------------------------------------------------------------------

/** 解析 MCP HTTP 响应：可能是 JSON，也可能是 SSE（`data:` 行）。 */
async function readMcpPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!contentType.includes("text/event-stream")) {
    return text ? (JSON.parse(text) as unknown) : null;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      /* 继续下一行 */
    }
  }
  return null;
}

const mcpToolNode: INodeType = {
  description: {
    type: "mcpTool",
    displayName: "MCP 工具",
    group: "action",
    description: "调用任意本机 HTTP MCP 服务的某个工具（JSON-RPC tools/call），把结果写进数据。",
    icon: "workflow",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "url",
        displayName: "MCP 地址",
        type: "string",
        default: "http://127.0.0.1:8776/mcp",
        required: true,
        description: "MCP 服务的 HTTP 端点，例如本机 InfoHub 的 http://127.0.0.1:8776/mcp。",
      },
      {
        name: "tool",
        displayName: "工具名",
        type: "string",
        default: "",
        required: true,
        placeholder: "infohub_status",
        description: "要调用的工具名（先在该服务的 tools/list 里确认）。",
      },
      {
        name: "arguments",
        displayName: "参数",
        type: "json",
        default: {},
        description: "传给工具的参数对象，值支持 {{ }} 表达式。",
      },
      {
        name: "timeoutMs",
        displayName: "超时（毫秒）",
        type: "number",
        default: 20000,
        description: "单次调用超时；建议不超过 20000（和鸣 MCP 客户端单次调用 20 秒）。",
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "mcp",
        description: "把结果写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const url = readString(context, "url", "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("MCP 地址必须是 http/https");
    const tool = readString(context, "tool", "").trim();
    if (!tool) throw new Error("工具名不能为空");
    const rawArguments = context.getNodeParameter<unknown>("arguments", {});
    const args =
      rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? (rawArguments as Record<string, unknown>)
        : {};
    const timeoutMs = Math.max(1_000, Math.min(120_000, Math.trunc(readNumber(context, "timeoutMs", 20_000))));
    const outputField = readString(context, "outputField", "mcp") || "mcp";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await readMcpPayload(response)) as
        | {
            result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
            error?: { message?: string };
          }
        | null;
      if (!payload) throw new Error("MCP 服务返回了空响应");
      if (payload.error) throw new Error(payload.error.message ?? "MCP 服务返回错误");
      const content = payload.result?.content ?? [];
      const text = content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (payload.result?.isError) throw new Error(text || "MCP 工具执行失败");
      return withField(inputItems(context), outputField, { tool, text, content });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`MCP 调用超时（${timeoutMs} 毫秒）`);
      }
      throw new Error(`MCP 调用失败：${errorText(error)}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

export const integrationNodes: INodeType[] = [llmNode, notificationNode, mcpToolNode];
