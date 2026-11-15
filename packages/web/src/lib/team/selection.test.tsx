import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TEAM_SELECTION_KEY, useSelectedTeamId } from "./selection.js";

/**
 * 「当前团队」的会话级记忆（d.153）。
 *
 * 口径与 Tab 记忆一致：**刷新保留、关窗清空**。这里只锁行为：初始空串、写入后
 * 同一会话内读回、清空后回落空串（页面据此选第一个团队）。
 */
describe("lib/team/selection", () => {
  it("初始没有选择：返回空串（页面回落到第一个团队）", () => {
    sessionStorage.clear();
    const { result } = renderHook(() => useSelectedTeamId());
    expect(result.current[0]).toBe("");
  });

  it("选中团队后写进 sessionStorage，重新挂载能读回同一个团队", () => {
    sessionStorage.clear();
    const first = renderHook(() => useSelectedTeamId());
    act(() => first.result.current[1]("team-2"));
    expect(first.result.current[0]).toBe("team-2");
    expect(JSON.parse(sessionStorage.getItem(TEAM_SELECTION_KEY)!)).toBe("team-2");

    // 刷新 = 重新挂载：仍是同一个团队
    const second = renderHook(() => useSelectedTeamId());
    expect(second.result.current[0]).toBe("team-2");
  });

  it("切回空串表示「不指定」，不会把空串当成一个团队 id 记住", () => {
    sessionStorage.clear();
    const { result } = renderHook(() => useSelectedTeamId());
    act(() => result.current[1]("team-1"));
    act(() => result.current[1](""));
    expect(result.current[0]).toBe("");
    expect(JSON.parse(sessionStorage.getItem(TEAM_SELECTION_KEY)!)).toBe("");
  });

  it("存储里是脏值（非 JSON）时回落空串，不抛错", () => {
    sessionStorage.clear();
    sessionStorage.setItem(TEAM_SELECTION_KEY, "{oops");
    const { result } = renderHook(() => useSelectedTeamId());
    expect(result.current[0]).toBe("");
  });
});
