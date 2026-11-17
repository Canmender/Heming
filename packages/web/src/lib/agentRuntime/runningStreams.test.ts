import { describe, it, expect } from "vitest";
import {
  isConversationRunning,
  runningConversationIds,
  type RunningStreamLike,
} from "./runningStreams.js";

/**
 * d.212：侧栏「正在跑」的口径。三条都写在这里，是因为它们全是**会说谎**的边界：
 * 别的窗口的流、已经出错的流、残留的同会话重复流。
 */

function stream(conversationId: string, status: "streaming" | "error" = "streaming"): RunningStreamLike {
  return { conversationId, status };
}

describe("runningConversationIds（d.212）", () => {
  it("本机起的、还在 streaming 的会话才算在跑", () => {
    const ids = runningConversationIds({ s1: stream("c1") }, { s1: true });
    expect(ids).toEqual(["c1"]);
  });

  it("没有 streamOwner 的条目不认：那是别的窗口/设备派来的流", () => {
    expect(runningConversationIds({ s1: stream("c1") }, {})).toEqual([]);
    expect(runningConversationIds({ s1: stream("c1") }, { s2: true })).toEqual([]);
  });

  it("error 已经收场，不再算在跑", () => {
    expect(runningConversationIds({ s1: stream("c1", "error") }, { s1: true })).toEqual([]);
  });

  it("同会话的残留重复流只亮一次，且保持首次出现的顺序", () => {
    const ids = runningConversationIds(
      { s1: stream("c1"), s2: stream("c2"), s3: stream("c1") },
      { s1: true, s2: true, s3: true },
    );
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("没有会话 id 的条目直接丢掉（不给左栏点亮一个无名会话）", () => {
    expect(runningConversationIds({ s1: stream("  ") }, { s1: true })).toEqual([]);
    expect(runningConversationIds({ s1: { conversationId: "c1", status: "streaming" } }, { s1: true })).toEqual([
      "c1",
    ]);
  });

  it("脏数据不崩：不是对象的切片当空处理", () => {
    const weird = null as unknown as Record<string, RunningStreamLike | undefined>;
    expect(runningConversationIds(weird, { s1: true })).toEqual([]);
    expect(runningConversationIds({ s1: stream("c1") }, null as unknown as Record<string, true | undefined>)).toEqual(
      [],
    );
  });
});

describe("isConversationRunning（d.212）", () => {
  it("只对在跑的那个会话为真", () => {
    const streaming = { s1: stream("c1") };
    const owner = { s1: true } as Record<string, true | undefined>;
    expect(isConversationRunning("c1", streaming, owner)).toBe(true);
    expect(isConversationRunning("c2", streaming, owner)).toBe(false);
  });

  it("空 id 永远为假（不传会话时不误亮）", () => {
    expect(isConversationRunning("", { s1: stream("c1") }, { s1: true })).toBe(false);
  });
});
