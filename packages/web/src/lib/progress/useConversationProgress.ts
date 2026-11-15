import { useMemo } from "react";
import type { Message } from "@heming/shared";
import type { AgentStreamState, TranscriptMessage } from "../../store/chat.js";
import { useChatStore } from "../../store/chat.js";
import { useHitlStore } from "../../store/hitl.js";
import { buildConversationProgress, type ConversationProgress } from "./model.js";

/**
 * 会话进度的 **React 绑定层**（d.147.4.88）。
 *
 * 只做三件事：从既有 store 里挑出「本会话那一轮」的事实、算待确认条数、
 * 交给纯函数 `buildConversationProgress`。推导逻辑一行都不在这里，
 * 所以面板与测试看到的是同一份结果。
 *
 * 为什么订阅 `streaming` 整个 Record 再自己挑最新一条：
 * store 以 streamId 为键，没有「当前会话的流」这个索引；按 `conversationId` 过滤
 * 再取 `lastAt` 最大的一条，既不用给 store 加字段，也不会把别的会话的进度串进来。
 * 选中结果返回的是 store 里的**原对象**（不是新对象），订阅比较稳定。
 */
export function useConversationProgress(conversationId: string | null): ConversationProgress {
  const stream = useChatStore((s) => {
    if (!conversationId) return undefined;
    let latest: AgentStreamState | undefined;
    for (const item of Object.values(s.streaming)) {
      if (item.conversationId !== conversationId) continue;
      if (!latest || item.lastAt > latest.lastAt) latest = item;
    }
    return latest;
  });

  const messages = useChatStore((s) => (conversationId ? s.messages[conversationId] : undefined));

  /**
   * 待确认项数：HITL 是单槽（同一时刻只问一件事），只算属于本会话的那一批。
   * 别的会话在等确认时不该点亮这一栏——那会让用户以为「这里有东西要处理」。
   */
  const pendingCount = useHitlStore((s) => {
    const pending = s.pending;
    if (!pending || pending.kind !== "tool-call") return 0;
    if (!conversationId || pending.conversationId !== conversationId) return 0;
    return pending.calls.length;
  });

  return useMemo(() => {
    // 流式期间以流为准；收口后回落最后一条助手消息的转录（重开会话仍能看到上一轮的轨迹）。
    const transcript = stream ? undefined : lastAssistantTranscript(messages);
    return buildConversationProgress({
      ...(stream
        ? {
            stream: {
              ...(stream.text ? { text: stream.text } : {}),
              ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
              ...(stream.tools ? { tools: stream.tools } : {}),
              status: stream.status,
              ...(stream.errorMessage ? { errorMessage: stream.errorMessage } : {}),
            },
          }
        : {}),
      ...(transcript ? { transcript } : {}),
      pendingConfirms: pendingCount,
    });
  }, [stream, messages, pendingCount]);
}

/**
 * 取最后一条助手消息的转录。
 *
 * 只看最后一条助手消息而不是全部：面板讲的是「这一轮」，把十轮前的工具调用
 * 混进来就不是进度而是考古了。没有转录（旧消息/没发过工具）时返回 undefined。
 */
function lastAssistantTranscript(
  messages: readonly Message[] | undefined,
): { thinking?: string; tools?: TranscriptMessage["tools"] } | undefined {
  if (!messages || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as TranscriptMessage | undefined;
    if (!msg || msg.senderType !== "agent") continue;
    if (!msg.thinking && (!msg.tools || msg.tools.length === 0)) return undefined;
    return {
      ...(msg.thinking ? { thinking: msg.thinking } : {}),
      ...(msg.tools && msg.tools.length > 0 ? { tools: msg.tools } : {}),
    };
  }
  return undefined;
}