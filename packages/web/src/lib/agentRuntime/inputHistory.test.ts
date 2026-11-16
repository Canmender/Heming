import { describe, expect, it } from "vitest";
import { historyFrom, isLocalCommand, stepHistory, MAX_INPUT_HISTORY } from "./inputHistory.js";

describe("输入框历史回溯（d.194）", () => {
  it("只留非空、去相邻重复、顺序是旧→新", () => {
    expect(historyFrom(["第一句", "", "  ", "第二句", "第二句", "第三句"])).toEqual([
      "第一句",
      "第二句",
      "第三句",
    ]);
  });

  it("本地命令不进历史（调出来再发一次没有意义）", () => {
    expect(isLocalCommand("/compact")).toBe(true);
    expect(isLocalCommand(" /status ")).toBe(true);
    expect(isLocalCommand("/compact 一下")).toBe(false);
    expect(historyFrom(["/compact", "帮我改一下", "/plan"])).toEqual(["帮我改一下"]);
  });

  it("超过上限只留最近的那些", () => {
    const texts = Array.from({ length: MAX_INPUT_HISTORY + 10 }, (_, i) => `第 ${i} 条`);
    const history = historyFrom(texts);
    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    expect(history[0]).toBe("第 10 条");
    expect(history[history.length - 1]).toBe(`第 ${MAX_INPUT_HISTORY + 9} 条`);
  });

  it("空输入框按 ↑ 从最新一条开始，再按 ↑ 往前走，到顶不动", () => {
    const history = ["A", "B", "C"];
    const first = stepHistory(history, -1, "up", "");
    expect(first).toEqual({ index: 2, text: "C" });
    const second = stepHistory(history, first.index, "up", "");
    expect(second).toEqual({ index: 1, text: "B" });
    const third = stepHistory(history, second.index, "up", "");
    expect(third).toEqual({ index: 0, text: "A" });
    // 到顶再按：仍停在最早一条，不越界
    expect(stepHistory(history, 0, "up", "")).toEqual({ index: 0, text: "A" });
  });

  it("按 ↓ 走回去，走到底恢复用户原来的草稿（不是清空）", () => {
    const history = ["A", "B"];
    // 用户先打了半句，再按 ↑ 回溯
    const up = stepHistory(history, -1, "up", "我正在打的");
    expect(up).toEqual({ index: 1, text: "B" });
    const down = stepHistory(history, up.index, "down", "我正在打的");
    expect(down).toEqual({ index: -1, text: "我正在打的" });
  });

  it("没在回溯里按 ↓ 不动输入框", () => {
    expect(stepHistory(["A"], -1, "down", "草稿")).toEqual({ index: -1, text: "草稿" });
  });

  it("没有历史时 ↑↓ 都不改输入框", () => {
    expect(stepHistory([], -1, "up", "草稿")).toEqual({ index: -1, text: "草稿" });
    expect(stepHistory([], 0, "down", "草稿")).toEqual({ index: 0, text: "草稿" });
  });
});
