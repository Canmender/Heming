/**
 * 评测用的工具桥：真实 `fileEdit` 工具 + 用例声明的假工具。
 *
 * 为什么要「真文件工具 + 假外部工具」：
 * - 文件链路是 P0 要度量的对象（补丁、越界、自恢复），必须跑真实实现；
 * - MCP / 记忆 / 技能在确定性模式下连真实服务不可行，用 `fake_tools` 声明返回值，
 *   只验证「编排层有没有把工具调起来、结果有没有进上下文」。
 */

import type { ToolBridge } from "../../packages/web/src/lib/agentStream.js";
import type { FileRoot } from "../../packages/web/src/lib/fileEdit/paths.js";
import type { FileFsBridge } from "../../packages/web/src/lib/fileEdit/bridge.js";
import { buildFileToolBridge } from "../../packages/web/src/lib/fileEdit/tools.js";
import type { FakeTool } from "./types.js";

/** OpenAI tools 数组里的一项（与 `FILE_TOOLS` 的声明同形）。 */
function openAiSpec(name: string, description: string, parameters: Record<string, unknown>) {
  return { type: "function", function: { name, description, parameters } };
}

/** 假工具的默认描述（让人看 rollout 时知道这是替身）。 */
function fakeSpec(tool: FakeTool) {
  return openAiSpec(tool.name, `评测替身工具 ${tool.name}（返回值由用例的 fake_tools 固定给出）`, {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
}

export interface EvalToolBridgeOptions {
  bridge: FileFsBridge;
  roots: () => FileRoot[];
  outOfRoot: () => "ask" | "reject";
  fakeTools?: FakeTool[];
}

/** 组合出本轮可用的工具桥。 */
export function createEvalToolBridge(options: EvalToolBridgeOptions): ToolBridge {
  const files = buildFileToolBridge({ bridge: options.bridge, roots: options.roots, outOfRoot: options.outOfRoot });
  const fakes = options.fakeTools ?? [];
  const fakeMap = new Map(fakes.map((tool) => [tool.name, tool]));

  return {
    tools: [...(files.tools as unknown[]), ...fakes.map(fakeSpec)],
    async execute(call) {
      const fake = fakeMap.get(call.name);
      if (fake) {
        const text = fake.result?.text ?? "";
        const ok = fake.result?.ok ?? true;
        return { text, ok };
      }
      if (call.name === "file_patch" || call.name === "file_read") {
        return files.execute(call);
      }
      // 用例里写了脚本却没声明 fake_tools：不静默成功，让 grader 看见失败原因。
      return { text: `评测工具未配置：${call.name}（请在用例 fake_tools 里声明）`, ok: false };
    },
    meta(name: string) {
      const fake = fakeMap.get(name);
      if (fake) {
        // 外部工具按「读」处理：确定性闸门不干预，安全用例只覆盖文件写。
        return { risk: "read" as const, displayName: name, origin: "mcp" as const };
      }
      return files.meta?.(name);
    },
  };
}
