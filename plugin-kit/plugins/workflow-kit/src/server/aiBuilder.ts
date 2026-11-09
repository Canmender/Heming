/**
 * 自然语言 → 工作流（AI Builder 端点）。
 *
 * 为什么放在服务端而不是编辑器里：生成需要「当前版本有哪些节点、参数 schema 是什么」，
 * 这些事实由服务端注册表提供；模型连接也只在本机配置里。生成结果**默认不保存**，
 * 由调用方先校验/试跑再决定是否 create —— 和智能体用 MCP 手工搭流程是同一条安全路径。
 *
 * 边界：
 * - 只调用用户本机配置的 OpenAI 兼容模型连接（env WF_LLM_*，由设置区/配置文件同步）；
 * - 提示词里只放节点目录与 JSON 规范，**不放任何凭据、执行记录、消息内容**；
 * - 输出必须能过 `normalizeWorkflow` + `validateWorkflow`，否则返回可读错误而不是半成品。
 */

import { listNodeTypes } from "../registry.js";
import { normalizeWorkflow, validateWorkflow } from "../model.js";
import { sdkReference } from "./sdkReference.js";
import { ToolError } from "./toolErrors.js";
import type { Workflow } from "../types.js";

export interface GenerateWorkflowOptions {
  request: string;
  name?: string;
  /** 生成后是否直接保存（默认 false，先给调用方校验/试跑）。 */
  save?: boolean;
}

export interface GenerateWorkflowResult {
  workflow: Workflow;
  plan: string[];
  notes: string[];
  issues: ReturnType<typeof validateWorkflow>;
  model: string;
}

const MAX_REQUEST_CHARS = 2_000;
const MAX_TOKENS = 4_096;

function readLlmSettings(): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = String(process.env.WF_LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.WF_LLM_API_KEY ?? "").trim();
  const model = String(process.env.WF_LLM_MODEL ?? "").trim();
  return baseUrl && model ? { baseUrl, apiKey, model } : null;
}

/** 压缩节点目录：只给「type/显示名/分组/触发/参数名与类型/必填/选项」，控制提示词体积。 */
function nodeCatalog(): string {
  const lines: string[] = [];
  for (const nodeType of listNodeTypes()) {
    const description = nodeType.description;
    const params = description.properties
      .map((property) => {
        const bits = [`${property.name}:${property.type}`];
        if (property.required) bits.push("必填");
        if (property.default !== undefined && ["string", "number", "boolean"].includes(typeof property.default)) {
          bits.push(`默认=${JSON.stringify(property.default)}`);
        }
        if (property.options?.length) {
          bits.push(`选项=[${property.options.map((option) => String(option.value)).slice(0, 12).join("|")}]`);
        }
        return bits.join(" ");
      })
      .join("; ");
    lines.push(
      `- ${description.type}（${description.displayName}，${description.group}${description.isTrigger ? "，触发器" : ""}）${params ? `：${params}` : ""}`,
    );
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = `你是「和鸣工作流引擎」的工作流生成器。把用户目标转成一条可运行的工作流 JSON。

硬性要求：
1. 只输出一个 JSON 对象，不要 Markdown、不要解释文字。结构：
   {"plan":["步骤1","步骤2"],"notes":["需要用户补充的事"],"workflow":{"name":"...","description":"...","tags":[],"nodes":[...],"connections":{...},"settings":{"timezone":"local","saveDataSuccessExecution":"all","saveDataErrorExecution":"all","saveManualExecutions":true,"callerPolicy":"any"},"active":false}}
2. 每条工作流必须以一个触发器节点开头：manualTrigger / scheduleTrigger / webhookTrigger / errorTrigger / executeWorkflowTrigger。
3. 节点对象：{"id":"n1","name":"中文唯一名","type":"上面目录里的 type","position":{"x":80,"y":120},"parameters":{...}}。
   参数名必须来自节点目录，不要编造；节点间用 connections 按「源节点 id」连接：
   {"n1":{"main":[[{"node":"n2","type":"main","index":0}]]}}；IF 输出 0=true/1=false。
4. 有副作用或需要凭据的节点（httpRequest、mcpTool、executeWorkflow）仅在有把握时使用；
   需要凭据时在 notes 里写「需要用户选择凭据」，不要编造凭据 id。
5. 表达式用 {{ }}，可用 $json/$items/$node["名称"].json/$now/$today/$vars。
6. 不要引用不存在的节点类型；坐标从左到右 x+240、从上到下 y+120。

可用节点目录：
${"__NODE_CATALOG__"}

工作流 JSON 规范参考：
${"__SDK_JSON__"}`;

function buildMessages(request: string): Array<{ role: string; content: string }> {
  const system = SYSTEM_PROMPT.replace("__NODE_CATALOG__", nodeCatalog()).replace(
    "__SDK_JSON__",
    sdkReference("workflow-json").content,
  );
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `用户目标：${request}\n\n请生成一条最小但可运行的工作流；能用 3–6 个节点完成就不要堆更多。`,
    },
  ];
}

/** 从模型输出里抽 JSON（容忍 ```json 围栏与前后废话）。 */
export function extractJsonObject(text: string): unknown {
  const trimmed = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function chatCompletion(
  settings: { baseUrl: string; apiKey: string; model: string },
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: settings.model, messages, max_tokens: MAX_TOKENS, stream: false }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ToolError(`模型调用失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
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

/** 生成一条工作流（默认不保存）。失败抛 ToolError（中文、可纠正）。 */
export async function generateWorkflow(
  options: GenerateWorkflowOptions,
): Promise<GenerateWorkflowResult> {
  const request = String(options.request ?? "").trim();
  if (!request) throw new ToolError("缺少参数：request（用自然语言描述你想自动化的目标）");
  if (request.length > MAX_REQUEST_CHARS) {
    throw new ToolError(`request 太长（最多 ${MAX_REQUEST_CHARS} 字），请先概括目标`);
  }
  const settings = readLlmSettings();
  if (!settings) {
    throw new ToolError(
      "还没有配置模型连接：设置 WF_LLM_BASE_URL / WF_LLM_API_KEY / WF_LLM_MODEL，或在 Web 编辑器「设置」里保存模型连接后重试",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let text: string;
  try {
    text = await chatCompletion(settings, buildMessages(request), controller.signal);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ToolError("模型调用超时（120 秒）");
    throw new ToolError(`模型调用失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(`模型没有返回合法 JSON（片段：${text.slice(0, 200)}）`);
  }
  const payload = parsed as Record<string, unknown>;
  const rawWorkflow = payload.workflow ?? payload;
  const workflow = normalizeWorkflow(rawWorkflow);
  if (!workflow) {
    throw new ToolError("模型生成的工作流结构不完整（缺少 nodes/connections），请补充目标后重试");
  }
  if (options.name?.trim()) workflow.name = options.name.trim().slice(0, 60);
  const issues = validateWorkflow(workflow);

  return {
    workflow,
    plan: Array.isArray(payload.plan) ? payload.plan.filter((item): item is string => typeof item === "string") : [],
    notes: Array.isArray(payload.notes) ? payload.notes.filter((item): item is string => typeof item === "string") : [],
    issues,
    model: settings.model,
  };
}
