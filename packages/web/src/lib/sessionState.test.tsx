import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { readSessionValue, useSessionTab, writeSessionValue } from "./sessionState.js";

/** sessionStorage 快照：刷新保留、关窗清空；写入/读取都要挡脏值。 */
describe("lib/sessionState", () => {
  it("readSessionValue 只认白名单里的值；缺失/脏值/非 JSON 回落 fallback", () => {
    sessionStorage.clear();
    expect(readSessionValue("k", "a", ["a", "b"] as const)).toBe("a");

    writeSessionValue("k", "b");
    expect(readSessionValue("k", "a", ["a", "b"] as const)).toBe("b");

    sessionStorage.setItem("k", JSON.stringify("c")); // 不在白名单
    expect(readSessionValue("k", "a", ["a", "b"] as const)).toBe("a");

    sessionStorage.setItem("k", JSON.stringify(2)); // 类型不对
    expect(readSessionValue("k", "a", ["a", "b"] as const)).toBe("a");

    sessionStorage.setItem("k", "{oops");
    expect(readSessionValue("k", "a", ["a", "b"] as const)).toBe("a");
    expect(readSessionValue("k", "a", ["a", "b"] as const, null)).toBe("a");
  });

  it("writeSessionValue 存储不可用时不抛（只在本次内存里切 Tab）", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writeSessionValue("k", "a", broken)).not.toThrow();
    expect(writeSessionValue("k", "a", null)).toBeUndefined();
    expect(readSessionValue("k", "a", ["a"], broken)).toBe("a");
  });

  it("useSessionTab：初始读回上次 Tab，切换后写盘，刷新（重新挂载）能恢复", () => {
    sessionStorage.clear();
    const first = renderHook(() => useSessionTab("heming.tab.test.v1", "one", ["one", "two"] as const));
    expect(first.result.current[0]).toBe("one");
    act(() => first.result.current[1]("two"));
    expect(first.result.current[0]).toBe("two");
    expect(JSON.parse(sessionStorage.getItem("heming.tab.test.v1")!)).toBe("two");
    first.unmount();

    // 重新挂载 = 刷新：状态从 sessionStorage 恢复
    const second = renderHook(() => useSessionTab("heming.tab.test.v1", "one", ["one", "two"] as const));
    expect(second.result.current[0]).toBe("two");
    second.unmount();
  });
});
