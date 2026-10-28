import { describe, it, expect, beforeEach } from "vitest";
import {
  CONV_PREFS_KEY,
  convPrefsVersion,
  isMuted,
  resetConvPrefsForTest,
  setMuted,
  subscribeConvPrefs,
} from "./convPrefs.js";

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
});

describe("convPrefs（按会话免打扰）", () => {
  it("默认不静音；开启后持久化；关闭后删键", () => {
    expect(isMuted("c1")).toBe(false);
    setMuted("c1", true);
    expect(isMuted("c1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONV_PREFS_KEY)!)).toEqual({ c1: { muted: true } });
    setMuted("c1", false);
    expect(isMuted("c1")).toBe(false);
    expect(JSON.parse(localStorage.getItem(CONV_PREFS_KEY)!)).toEqual({});
  });

  it("变更通知订阅者；坏 JSON 回退空", () => {
    const calls: number[] = [];
    const off = subscribeConvPrefs(() => calls.push(convPrefsVersion()));
    setMuted("c1", true);
    expect(calls).toHaveLength(1);
    off();
    localStorage.setItem(CONV_PREFS_KEY, "{oops");
    resetConvPrefsForTest();
    expect(isMuted("c1")).toBe(false);
  });
});
