/**
 * 评测用的工具桥：真实 `fileEdit` 工具 + 真实 `todo_write` + 用例声明的假工具。
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
import { mergeToolBridges } from "../../packages/web/src/lib/selfEdit/merge.js";
import { buildTodoToolBridge } from "../../packages/web/src/lib/todo/tool.js";
import { buildToolOutputBridge } from "../../packages/web/src/lib/spill/tool.js";
import { buildShellToolBridgeIfAvailable } from "../../packages/web/src/lib/shell/tool.js";
import { createEvalShellBridge } from "./shellBridge.js";
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
  /**
   * 给了会话 id 才挂真实的 `todo_write`（d.163）。
   *
   * 为什么：清单终态只能从真实 store 读出来断言；用 `fake_tools` 代替的话，
   * `todo_state` 断言的永远是假工具的返回，测不到「清单到底写没写进去」。
   */
  conversationId?: string;
  /**
   * 为 true 时挂真实的 `run_command`（d.165）。
   *
   * 为什么默认不挂：`run_command` 的风险是 `danger`，确定性闸门默认拒绝它；
   * 给所有用例都挂上会改变工具清单与提示词（基线被无关改动带偏），
   * 也让「本来不该跑命令的用例」多一个可能被模型误用的入口。
   * 声明 `shell: true` 的用例还要配合 `allow_danger: true` 才会被闸门放行。
   */
  shell?: boolean;
}

/** 组合出本轮可用的工具桥。 */
export function createEvalToolBridge(options: EvalToolBridgeOptions): ToolBridge {
  const files = buildFileToolBridge({ bridge: options.bridge, roots: options.roots, outOfRoot: options.outOfRoot });
  const fakes = options.fakeTools ?? [];
  const fakeMap = new Map(fakes.map((tool) => [tool.name, tool]));

  // 真实文件工具**按桥实际声明了哪些**分发，而不是硬编码名字。
  // 为什么：d.153 把两个工具扩到六个，这里若还写着 file_patch/file_read，
  // 新工具在评测里只会回「评测工具未配置」，等于新能力完全度量不到（还会被误判成用例写错）。
  const fileToolNames = new Set(
    (files.tools as Array<{ type?: string; function?: { name?: string } }>)
      .map((spec) => spec.function?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  const base: ToolBridge = {
    tools: [...(files.tools as unknown[]), ...fakes.map(fakeSpec)],
    async execute(call) {
      const fake = fakeMap.get(call.name);
      if (fake) {
        const text = fake.result?.text ?? "";
        const ok = fake.result?.ok ?? true;
        return { text, ok };
      }
      if (fileToolNames.has(call.name)) {
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

  // `todo_write` 只在用例声明了会话 id 时才挂（没挂的用例工具清单保持原样，
  // 不会因为「评测顺带多一件工具」而改变既有用例的提示词与轮次）。
  const todo = options.conversationId ? buildTodoToolBridge({ conversationId: options.conversationId }) : null;
  // d.181：长输出截断后的「再读」工具在真实运行里始终注入，评测也必须一致，
  // 否则「spill handle + tool_output_read」这条链在评测里根本不存在。
  const output = buildToolOutputBridge();

  // `run_command` 只在用例声明 `shell: true` 时挂（同上：不改变既有用例的工具清单）。
  const shell = options.shell
    ? buildShellToolBridgeIfAvailable({
        bridge: createEvalShellBridge({ roots: options.roots }),
        roots: options.roots,
      })
    : null;

  return mergeToolBridges(mergeToolBridges(mergeToolBridges(base, shell) ?? base, todo) ?? base, output) ?? base;
}
