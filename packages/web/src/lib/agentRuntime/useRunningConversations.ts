import { useMemo } from "react";
import { useChatStore } from "../../store/chat.js";
import { runningConversationIds } from "./runningStreams.js";

/**
 * 订阅「哪些会话正在跑」（d.212）。
 *
 * 用两个切片 + `useMemo` 算一个 Set：`streaming` 里每来一个增量都会换引用，所以直接
 * 在渲染里算会白跑；`useMemo` 只在两个切片真的换引用时重算。返回 Set 而不是数组，是因为
 * 左栏每一行都要问一次「这条在不在里面」，Set 的 `has` 才是 O(1)。
 *
 * 不在会话页也会被挂（左栏一直在），所以这里**不做**任何请求，只读 store。
 */
export function useRunningConversations(): ReadonlySet<string> {
  const streaming = useChatStore((s) => s.streaming);
  const streamOwner = useChatStore((s) => s.streamOwner);
  return useMemo(() => new Set(runningConversationIds(streaming, streamOwner)), [streaming, streamOwner]);
}
