/**
 * 会话级「目标」存储（d.201）：只测数据口径。
 *
 * 关注：按会话隔离、替换而不是堆积、空文本等于清除、落 localStorage 能读回、
 * 坏数据不崩、订阅在变更时通知。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOALS_KEY,
  GOAL_TEXT_MAX,
  MAX_STORED_GOALS,
  clearGoal,
  getGoal,
  goalForPrompt,
  resetGoalStore,
  setGoal,
  subscribeGoals,
} from "./goal.js";

beforeEach(() => {
  localStorage.clear();
  resetGoalStore();
});

describe("会话目标", () => {
  it("按会话隔离：A 的目标不会出现在 B", () => {
    setGoal("conv-a", "把登录改成扫码");
    expect(getGoal("conv-a")?.text).toBe("把登录改成扫码");
    expect(getGoal("conv-b")).toBeNull();
    expect(goalForPrompt("conv-b")).toBeNull();
  });

  it("再设一次是替换，不是堆两条", () => {
    setGoal("c1", "第一版目标");
    setGoal("c1", "第二版目标");
    expect(getGoal("c1")?.text).toBe("第二版目标");
    expect(goalForPrompt("c1")).toBe("第二版目标");
  });

  it("压平空白并截到上限", () => {
    setGoal("c1", "  把  登录\n改成扫码  ");
    expect(getGoal("c1")?.text).toBe("把 登录 改成扫码");
    setGoal("c1", "x".repeat(GOAL_TEXT_MAX + 50));
    expect(getGoal("c1")?.text).toHaveLength(GOAL_TEXT_MAX);
  });

  it("目标截断落在 emoji 中间时不劈出落单代理（进系统提示词的文本，d.412 回归）", () => {
    const stored = setGoal("emoji", "x".repeat(GOAL_TEXT_MAX - 1) + "😀" + "tail");
    const text = stored?.text ?? "";
    // 逐 UTF-16 单元检查：高代理后面必须跟低代理，低代理前面必须是高代理
    const units = text.split("").map((ch) => ch.charCodeAt(0));
    const lone = units.some((c, i) =>
      (c >= 0xd800 && c <= 0xdbff)
        ? !(i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff)
        : (c >= 0xdc00 && c <= 0xdfff)
          ? !(i > 0 && units[i - 1] >= 0xd800 && units[i - 1] <= 0xdbff)
          : false,
    );
    expect(lone).toBe(false);
    // 码点数正好到上限（emoji 是一个码点，占 2 个 UTF-16 单元）
    expect(Array.from(text)).toHaveLength(GOAL_TEXT_MAX);
  });

  it("空文本等于清除，不会留下空目标", () => {
    setGoal("c1", "先设一个");
    expect(setGoal("c1", "   ")).toBeNull();
    expect(getGoal("c1")).toBeNull();
    expect(localStorage.getItem(GOALS_KEY) ?? "").not.toContain("c1");
  });

  it("落 localStorage 后重开能读回", () => {
    setGoal("c1", "把导入流程跑通");
    resetGoalStore();
    expect(getGoal("c1")?.text).toBe("把导入流程跑通");
  });

  it("坏数据不崩：非对象/缺字段/空文本都被忽略", () => {
    localStorage.setItem(
      GOALS_KEY,
      JSON.stringify({ bad: "字符串", c1: { text: "好的" }, c2: { text: "   " }, c3: null }),
    );
    resetGoalStore();
    expect(getGoal("bad")).toBeNull();
    expect(getGoal("c2")).toBeNull();
    expect(getGoal("c3")).toBeNull();
    expect(getGoal("c1")?.text).toBe("好的");
  });

  it("只留最近写入的 N 个会话，最旧的被淘汰", () => {
    for (let i = 0; i < MAX_STORED_GOALS + 5; i += 1) {
      setGoal(`c${i}`, `目标 ${i}`);
    }
    expect(getGoal("c0")).toBeNull();
    expect(getGoal(`c${MAX_STORED_GOALS + 4}`)?.text).toBe(`目标 ${MAX_STORED_GOALS + 4}`);
    resetGoalStore();
    expect(getGoal("c0")).toBeNull();
  });

  it("重开应用后淘汰的仍是最久没用的会话（LRU 序号跨重启还原，不把刚用的那份删掉，d.412 回归）", () => {
    for (let i = 0; i < MAX_STORED_GOALS; i += 1) {
      setGoal(`c${i}`, `目标 ${i}`);
    }
    // 把 c(MAX-1) 变成最近用过：重写一次即可推进它的使用序号。
    const newest = `c${MAX_STORED_GOALS - 1}`;
    setGoal(newest, `目标 ${MAX_STORED_GOALS - 1} 刚用过`);
    // 模拟重开应用，再写入一条新的：总数超上限，应淘汰最久没用的 c0，而不是刚用过的 newest。
    resetGoalStore();
    setGoal("cNew", "新目标");
    expect(getGoal("c0")).toBeNull();
    expect(getGoal(newest)?.text).toBe(`目标 ${MAX_STORED_GOALS - 1} 刚用过`);
    expect(getGoal("cNew")?.text).toBe("新目标");
  });

  it("订阅只在变更时通知，并能退订", () => {
    const listener = vi.fn();
    const off = subscribeGoals(listener);
    setGoal("c1", "目标");
    clearGoal("c1");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith("c1");
    off();
    setGoal("c1", "又一个");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("清除不存在的目标不通知也不写盘", () => {
    const listener = vi.fn();
    subscribeGoals(listener);
    clearGoal("nobody");
    expect(listener).not.toHaveBeenCalled();
  });

  it("goalForPrompt 只给非空文本：前端不会把空目标写进提示词", () => {
    expect(goalForPrompt("c1")).toBeNull();
    setGoal("c1", "达成什么");
    expect(goalForPrompt("c1")).toBe("达成什么");
    clearGoal("c1");
    expect(goalForPrompt("c1")).toBeNull();
  });
});
