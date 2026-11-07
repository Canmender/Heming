import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortConversation,
  registerConversationAbort,
  resetConversationAbortsForTests,
} from "./runAbort.js";

/** 「停止某个会话正在跑的流」的跨组件登记表。 */
describe("lib/runAbort", () => {
  beforeEach(() => resetConversationAbortsForTests());

  it("登记后可中断；注销后不再命中", () => {
    const abort = vi.fn();
    const off = registerConversationAbort("c1", abort);
    expect(abortConversation("c1")).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);

    off();
    expect(abortConversation("c1")).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("不同会话互不影响；未登记的会话返回 false", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerConversationAbort("c1", a);
    registerConversationAbort("c2", b);

    expect(abortConversation("c2")).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(abortConversation("c3")).toBe(false);
  });

  it("注销是幂等的，且只注销自己那一个（后登记的覆盖）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerConversationAbort("c1", first);
    registerConversationAbort("c1", second);

    // 已被覆盖：注销 first 不应把 second 摘掉
    offFirst();
    expect(abortConversation("c1")).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
