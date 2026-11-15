/**
 * 脚本化 `streamChat`：确定性评测的「假模型」。
 *
 * 每个 step 的 `script` 是**按序消费**的模型回合：第 1 次调用返回第 1 项
 * （先回调 tool_calls、再回调 text），第 2 次调用返回第 2 项……
 * 脚本耗尽后返回空文本，模拟「模型没有更多要说的」，让编排层正常收口。
 *
 * 为什么不搭一个 HTTP 假网关：`runAgentMentions` 允许注入 `streamChat`，
 * 直接注入比起端口更确定（没有端口冲突、没有超时、也没有 SSE 拼包的边界情况）。
 * `--real` 模式才换回真实的 `streamChat`。
 */

import type { ChatMessage, StreamChatOpts, UsageTotals } from "../../packages/web/src/lib/llmClient.js";
import type { LlmProfile } from "../../packages/web/src/store/llm.js";
import type { CaseUsage, ScriptTurn } from "./types.js";

/** 每回合缺省上报的用量（README 的契约）。 */
export const DEFAULT_INPUT_TOKENS = 900;
export const DEFAULT_OUTPUT_TOKENS = 120;

export interface ScriptedChat {
  /** 可直接塞进 `TriggerDeps.streamChat`。 */
  chat: (profile: LlmProfile, messages: ChatMessage[], opts: StreamChatOpts) => Promise<string>;
  /** 已消费的回合数（max_rounds grader 用它，而不是数 rollout）。 */
  rounds: () => number;
  /** 换下一段脚本（多步用例每步一份）。 */
  useScript: (turns: ScriptTurn[] | undefined) => void;
}

export function createScriptedChat(usage?: CaseUsage): ScriptedChat {
  let queue: ScriptTurn[] = [];
  let rounds = 0;

  const chat = async (_profile: LlmProfile, _messages: ChatMessage[], opts: StreamChatOpts): Promise<string> => {
    rounds += 1;
    const turn = queue.shift();
    const text = turn?.text ?? "";
    const calls = (turn?.tool_calls ?? []).map((call, index) => ({
      id: `call_${rounds}_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));

    if (text) opts.onDelta?.(text);
    if (calls.length > 0) opts.onToolCalls?.(calls);

    const totals: UsageTotals = {
      inputTokens: usage?.input ?? DEFAULT_INPUT_TOKENS,
      outputTokens: usage?.output ?? DEFAULT_OUTPUT_TOKENS,
      totalTokens: (usage?.input ?? DEFAULT_INPUT_TOKENS) + (usage?.output ?? DEFAULT_OUTPUT_TOKENS),
      // 只在用例显式声明时上报缓存：缺省不上报，才能区分「缓存为 0」与「供应商没报」。
      ...(usage?.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(usage?.cacheWrite !== undefined ? { cacheWriteTokens: usage.cacheWrite } : {}),
    };
    opts.onUsage?.(totals);
    opts.onFinish?.(calls.length > 0 ? "tool_calls" : "stop");
    return text;
  };

  return {
    chat,
    rounds: () => rounds,
    useScript: (turns) => {
      queue = [...(turns ?? [])];
    },
  };
}
