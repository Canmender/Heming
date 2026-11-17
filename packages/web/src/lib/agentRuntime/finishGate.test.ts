/**
 * 收尾自检（d.232）的判据与话术。
 *
 * 这里只测「该不该催 / 催什么」——真去调 `startRun` 是 ChatPage 的事（见 I4d 用例）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resetTodoStore, setTodos } from "../todo/store.js";
import {
  FINISH_GATE_MAX_LISTED,
  FINISH_GATE_MAX_NUDGES,
  finishGatePrompt,
  finishGateVerdict,
  unfinishedTodos,
} from "./finishGate.js";

beforeEach(() => {
  resetTodoStore();
});

describe("清单里还剩什么（d.232）", () => {
  it("没有会话 id 或没有清单时返回空数组（判据不明就不催）", () => {
    expect(unfinishedTodos("c1")).toEqual([]);
    expect(unfinishedTodos(null)).toEqual([]);
    expect(unfinishedTodos(undefined)).toEqual([]);
    expect(unfinishedTodos("")).toEqual([]);
  });

  it("只挑没打勾的项，保留原有顺序与状态", () => {
    setTodos("c1", [
      { content: "改 A", status: "pending" },
      { content: "改 B", status: "completed" },
      { content: "跑测试", status: "in_progress" },
      { content: "写文档", status: "pending" },
    ]);
    expect(unfinishedTodos("c1")).toEqual([
      { content: "改 A", status: "pending" },
      { content: "跑测试", status: "in_progress" },
      { content: "写文档", status: "pending" },
    ]);
  });

  it("全打勾时是空数组：不能把「已经做完」当成没做完", () => {
    setTodos("c1", [
      { content: "改 A", status: "completed" },
      { content: "改 B", status: "completed" },
    ]);
    expect(unfinishedTodos("c1")).toEqual([]);
  });

  it("按会话隔离：另一个会话的清单不算这一轮的未完成", () => {
    setTodos("c1", [{ content: "改 A", status: "pending" }]);
    setTodos("c2", [{ content: "改 B", status: "completed" }]);
    expect(unfinishedTodos("c1")).toHaveLength(1);
    expect(unfinishedTodos("c2")).toEqual([]);
  });
});

describe("什么时候该催收尾（d.232）", () => {
  it("只有「正常收口 + 清单有未完成 + 没催过 + 没有插话」才催", () => {
    expect(finishGateVerdict({ status: "ok", open: 2, nudges: 0 })).toEqual({
      nudge: true,
      reason: "nudge",
    });
  });

  it("用户点停止或这一轮出错都不催（用户已经介入了）", () => {
    expect(finishGateVerdict({ status: "aborted", open: 3, nudges: 0 }).reason).toBe("not-ok");
    expect(finishGateVerdict({ status: "error", open: 3, nudges: 0 }).reason).toBe("not-ok");
    expect(finishGateVerdict({ status: "aborted", open: 3, nudges: 0 }).nudge).toBe(false);
  });

  it("清单全都打勾了就不催（没有可核对的东西）", () => {
    expect(finishGateVerdict({ status: "ok", open: 0, nudges: 0 }).reason).toBe("no-open");
  });

  it("一次用户输入最多催一次：催过就停，避免停不下来的自动循环", () => {
    expect(FINISH_GATE_MAX_NUDGES).toBe(1);
    expect(finishGateVerdict({ status: "ok", open: 2, nudges: 1 }).reason).toBe("already-nudged");
    expect(finishGateVerdict({ status: "ok", open: 2, nudges: 5 }).nudge).toBe(false);
  });

  it("有排队插话时先让插话：用户的即时意图优先于系统自检", () => {
    expect(finishGateVerdict({ status: "ok", open: 2, nudges: 0, steerQueued: true }).reason).toBe(
      "queued",
    );
    // 插话清除之后同一次输入仍可以催（队列是瞬时状态，不该把机会永久吃掉）。
    expect(finishGateVerdict({ status: "ok", open: 2, nudges: 0, steerQueued: false }).nudge).toBe(
      true,
    );
  });
});

describe("催收尾的那句话（d.232）", () => {
  it("逐条列出未完成项，标出进行中与未开始", () => {
    const text = finishGatePrompt([
      { content: "改 A", status: "pending" },
      { content: "跑测试", status: "in_progress" },
    ]);
    expect(text).toContain("还有 2 项没打勾");
    expect(text).toContain("[ ] 未开始：改 A");
    expect(text).toContain("[>] 进行中：跑测试");
  });

  it("超过上限时只列前几条，并说清还有几项没列出来", () => {
    const todos = Array.from({ length: FINISH_GATE_MAX_LISTED + 2 }, (_, index) => ({
      content: `第 ${index + 1} 项`,
      status: "pending" as const,
    }));
    const text = finishGatePrompt(todos);
    expect(text).toContain("还有 7 项没打勾");
    expect(text).toContain("第 5 项");
    expect(text).not.toContain("第 6 项");
    expect(text).toContain("还有 2 项没列出来");
  });

  it("要求它用 todo_write 对齐清单，并且别把未完成项留着就结束", () => {
    const text = finishGatePrompt([{ content: "改 A", status: "pending" }]);
    expect(text).toContain("todo_write");
    expect(text).toContain("completed");
    expect(text).toMatch(/别把未完成项留在清单里/);
    // 说明「这会让用户误以为做好了」——这是催它的理由，不是命令式口号。
    expect(text).toContain("以为都做好了");
  });
});
