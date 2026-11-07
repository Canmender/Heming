import { streamChat, type ChatMessage, type UsageTotals } from "../llmClient.js";
import type { LlmProfile } from "../../store/llm.js";
import {
  MAX_LLM_DETAIL_CHARS,
  MAX_LLM_TITLE_CHARS,
  MAX_SUMMARY_CHARS,
  STAFF_LLM_TIMEOUT_MS,
  clipText,
  type StaffEvidence,
  type StaffFacts,
  type StaffFinding,
  type StaffSeverity,
} from "./model.js";

/**
 * 幕僚的可选模型总结（d.48 §5.3）。
 *
 * 隐私边界：发给模型的只有「标题 / 到期文案 / 会话名 / 发送者 / 任务状态与错误」，
 * **不发日程 detail、不发消息正文**。模型只负责组织语言，事实仍由本机规则兜底。
 */

export interface StaffFactPayload {
  agenda: {
    refId: string;
    title: string;
    dueText: string;
    bucket: string;
    convName: string;
    senderName: string;
  }[];
  tasks: {
    refId: string;
    title: string;
    issue: string;
    error: string;
  }[];
  running: number;
}

export interface BriefRef {
  evidence: StaffEvidence;
  taskId?: string;
  conversationId?: string;
}

export interface ParsedBrief {
  summary: string;
  findings: StaffFinding[];
}

export interface BriefCallResult {
  text: string;
  usage?: UsageTotals;
}

function oneLine(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/** 脱敏事实：显式列出字段，避免以后新增内部字段被顺手带出去。 */
export function buildFactPayload(facts: StaffFacts): StaffFactPayload {
  return {
    agenda: facts.agenda.map((item) => ({
      refId: item.refId,
      title: clipText(item.title, 60),
      dueText: clipText(item.dueText, 40),
      bucket: item.bucket,
      convName: clipText(item.convName, 40),
      senderName: clipText(item.senderName, 40),
    })),
    tasks: facts.tasks.map((item) => ({
      refId: item.refId,
      title: clipText(item.title, 60),
      issue: item.issue,
      error: clipText(item.error, 120),
    })),
    running: facts.running,
  };
}

/** 事实 refId → 证据与跳转信息（模型输出只允许引用这些 id）。 */
export function refsOfFacts(facts: StaffFacts): Map<string, BriefRef> {
  const map = new Map<string, BriefRef>();
  for (const item of facts.agenda) {
    map.set(item.refId, {
      evidence: {
        label: item.convName ? `本机归档 · ${item.convName}` : "本机归档",
        kind: "agenda",
        refId: item.refId,
      },
    });
  }
  for (const item of facts.tasks) {
    map.set(item.refId, {
      evidence: { label: "通用智能体", kind: "task", refId: item.refId },
      taskId: item.taskId,
      conversationId: item.conversationId,
    });
  }
  return map;
}

const SYSTEM_PROMPT = [
  "你是用户的常驻幕僚，只根据给定事实写一份简短的中文简报。",
  "要求：",
  "1. 只输出一个 JSON 对象，不要 markdown 代码块，不要额外解释。",
  '2. 格式：{"summary":"一句话总结","findings":[{"severity":"urgent|warn|info","title":"标题","detail":"细节","refs":["agenda:12","task:abc"]}]}',
  "3. summary 不超过 200 字；findings 最多 7 条；title 不超过 40 字，detail 不超过 160 字。",
  "4. 每条 finding 的 refs 必须来自输入事实的 refId，不得编造 id、日程或任务。",
  "5. 不要建议自动执行任何操作；只说明事实与需要用户留意的地方。",
].join("\n");

export function buildBriefMessages(payload: StaffFactPayload): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** 从模型输出里取出 JSON（容忍 ```json 围栏与前后闲聊）。 */
function extractJson(text: string): unknown {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格校验模型输出。
 *
 * 任何一条不合规就丢弃；**全部条目被丢弃 → 返回 null**（调用方回退规则模式）。
 * 宁可少说，也不能把模型编的「日程」放进简报。
 */
export function parseBriefJson(text: string, refs: Map<string, BriefRef>): ParsedBrief | null {
  const raw = extractJson(text);
  if (!isRecord(raw)) return null;
  const summary = clipText(oneLine(raw.summary), MAX_SUMMARY_CHARS);
  if (!Array.isArray(raw.findings)) return null;

  const findings: StaffFinding[] = [];
  for (const item of raw.findings.slice(0, 7)) {
    if (!isRecord(item)) continue;
    if (item.severity !== "urgent" && item.severity !== "warn" && item.severity !== "info") continue;
    const severity = item.severity as StaffSeverity;
    const title = clipText(oneLine(item.title), MAX_LLM_TITLE_CHARS);
    if (!title) continue;
    const refIds = Array.isArray(item.refs)
      ? [...new Set(item.refs.filter((r): r is string => typeof r === "string" && refs.has(r)))]
      : [];
    if (refIds.length === 0) continue;
    const matched = refIds.map((id) => ({ id, ref: refs.get(id) as BriefRef }));
    const taskRef = matched.find((entry) => entry.ref.taskId);
    findings.push({
      id: `llm-${findings.length + 1}-${matched[0].id.replace(/[^A-Za-z0-9]+/g, "-")}`,
      severity,
      title,
      detail: clipText(oneLine(item.detail), MAX_LLM_DETAIL_CHARS),
      evidence: matched.map((entry) => entry.ref.evidence).slice(0, 4),
      ...(taskRef
        ? {
            action: {
              kind: "open-task" as const,
              targetId: taskRef.ref.taskId,
              ...(taskRef.ref.conversationId ? { conversationId: taskRef.ref.conversationId } : {}),
            },
          }
        : { action: { kind: "open-infohub" as const } }),
    });
  }

  if (findings.length === 0) return null;
  return { summary, findings };
}

export function tokensOf(usage: UsageTotals | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  return input + output > 0 ? input + output : null;
}

/** 一次性的简报调用：25 秒超时，流式累积全文，顺带拿回 usage。 */
export async function callBriefModel(
  profile: LlmProfile,
  payload: StaffFactPayload,
  opts: { signal?: AbortSignal } = {},
): Promise<BriefCallResult & { tokens: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAFF_LLM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let text = "";
    let usage: UsageTotals | undefined;
    await streamChat(profile, buildBriefMessages(payload), {
      signal: controller.signal,
      onDelta: (delta) => {
        text += delta;
      },
      onUsage: (value) => {
        usage = value;
      },
    });
    return { text, usage, tokens: tokensOf(usage) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
