/**
 * 去 AI 味工具（tone.*）：让智能体按统计依据清理文本里的 AI 痕迹。
 *
 * 与 self.* / chart.* 同一套工具桥，agentStream 的工具循环零改动。
 *
 * 形态说明：这里**只有一个工具**（tone_detect），不做「自动改写」。
 * 原因在检测器里说清了——上游的核心约束是「白名单式改写」：
 * 只能改规则清单内的 11 项，没命中任何规则的句子必须逐字保留。
 * 改写这一步交给模型（它能判断语义、句法骨架是否真的同款），
 * 而「哪里命中了哪条规则」交给算子（它能精确定位）。
 * 让工具直接产出改写文本，反而会诱导它按字面机械替换——那正是上游要避免的。
 *
 * 另一个刻意的选择：工具**默认不注入**。它会占 token，
 * 且只在「改写/润色」类请求里才有用。所以做成与 self.* 一样的按需注入：
 * 用户显式开过该智能体的「去 AI 味」才给。
 */

import type { ToolBridge } from "../agentStream.js";
import { TONE_DETECT_TOOL, runToneDetect } from "./detector.js";

/** tone.* 工具的命名前缀（分流与展示共用）。 */
export const TONE_TOOL_PREFIX = "tone_";

/**
 * 构建去 AI 味工具桥。
 *
 * 只有一个工具，所以不做参数化的工厂——直接给出即可。
 */
export function buildToneToolBridge(): ToolBridge {
  return {
    tools: [
      {
        type: "function" as const,
        function: {
          name: TONE_DETECT_TOOL.name,
          description: TONE_DETECT_TOOL.description,
          parameters: TONE_DETECT_TOOL.parameters,
        },
      },
    ],
    execute: async (call) => {
      if (call.name !== TONE_DETECT_TOOL.name) {
        return { text: `未知工具 ${call.name}`, ok: false };
      }
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments || "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        return { text: "参数不是合法 JSON，请检查后重试。", ok: false };
      }
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) {
        return { text: "缺少 text 参数（待检测的文本）。", ok: false };
      }
      return { text: runToneDetect(text), ok: true };
    },
  };
}
