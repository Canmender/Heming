/**
 * `tool_output_read`：把被截断的完整输出按字符窗口读回来。
 *
 * 为什么做成工具而不是「自动塞回去」：完整输出可能几十万字符，塞回去等于把
 * 上下文预算一次烧光——那正是截断要防的事。给模型一个「可以再读」的 handle，
 * 让它自己决定读哪一段、读多少，这与 DSH 的 `spill` 语义一致。
 */
import type { ToolBridge } from "../agentStream.js";
import { failureResult, type ToolFailureResult } from "../toolError.js";
import { SPILL_READ_DEFAULT, SPILL_READ_MAX, readSpill } from "./store.js";

export const TOOL_OUTPUT_TOOL = "tool_output_read";

const TOOLS = [
  {
    name: TOOL_OUTPUT_TOOL,
    description:
      "读取被截断的工具完整输出。工具结果过长时，返回文本里会给一个 spill-<数字> 的 handle；用这个工具按字符窗口分段读回。offset 从 0 开始，limit 是本次读多少字符（缺省 8000，上限 40000）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "工具结果里给出的 handle，形如 spill-3" },
        offset: { type: "number", description: "从第几个字符开始读，缺省 0" },
        limit: { type: "number", description: `本次读多少字符，缺省 ${SPILL_READ_DEFAULT}，上限 ${SPILL_READ_MAX}` },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export interface ToolOutputDeps {
  /** 仅用于测试注入；生产不传即用真实存储。 */
  read?: typeof readSpill;
}

function parseArgs(raw: string): { ok: true; id: string; offset?: number; limit?: number } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, message: "参数不是合法 JSON。" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "参数必须是对象。" };
  }
  const args = parsed as Record<string, unknown>;
  if (typeof args.id !== "string" || !args.id.trim()) {
    return { ok: false, message: "缺 id：用工具结果里给出的 spill-<数字>。" };
  }
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  return { ok: true, id: args.id.trim(), ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
}

/** 结果文本：写清「这是第几段 / 还有没有下一段 / 下一段从哪读」，模型才知道下一步。 */
function formatSlice(result: Extract<ReturnType<typeof readSpill>, { ok: true }>): string {
  const start = result.offset + 1;
  const end = result.offset + result.text.length;
  const head = `完整输出 ${result.id}：共 ${result.total} 字符，这里是第 ${start}–${end} 字符。`;
  const next = result.hasMore
    ? `\n还有后面 ${result.total - end} 字符；要继续读，把 offset 设成 ${end}。`
    : "\n已经读到结尾。";
  return `${head}\n\n${result.text}${next}`;
}

export function buildToolOutputBridge(deps: ToolOutputDeps = {}): ToolBridge {
  const read = deps.read ?? readSpill;
  return {
    tools: TOOLS.map((spec) => ({
      type: "function" as const,
      function: { name: spec.name, description: spec.description, parameters: spec.parameters },
    })),
    // d.207：丢了细节又要不回来时，这条是唯一出路，声明成核心工具。
    meta: () => ({ risk: "read", displayName: "读取完整输出", core: true }),
    async execute(call) {
      if (call.name !== TOOL_OUTPUT_TOOL) {
        const failure: ToolFailureResult = failureResult("未知工具", `这个工具桥只提供 ${TOOL_OUTPUT_TOOL}。`, {
          error_code: "unknown-tool",
        });
        return { text: failure.text, ok: false, error: failure.error };
      }
      const parsed = parseArgs(call.arguments);
      if (!parsed.ok) {
        const failure: ToolFailureResult = failureResult("读取完整输出失败", parsed.message, {
          error_code: "invalid-args",
          hint: "按工具描述里的字段名重写参数（id 必填，offset/limit 可选）。",
        });
        return { text: failure.text, ok: false, error: failure.error };
      }
      const result = read(parsed.id, parsed.offset, parsed.limit);
      if (!result.ok) {
        const failure: ToolFailureResult = failureResult("读取完整输出失败", result.text, {
          error_code: result.error_code,
          hint: result.hint,
        });
        return { text: failure.text, ok: false, error: failure.error };
      }
      return { text: formatSlice(result), ok: true, sources: [{ id: `spill:${result.id}`, title: `完整输出 ${result.id}` }] };
    },
  };
}
