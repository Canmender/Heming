/**
 * 会话级任务清单存储：**只测数据口径**，不测 UI。
 *
 * 关注三件事：按会话隔离、整份替换、落 localStorage 后能读回（重开应用接着做）。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_STORED_LISTS,
  MAX_TODOS,
  TODOS_KEY,
  clearTodos,
  countTodos,
  formatTodos,
  getTodos,
  resetTodoStore,
  setTodos,
  subscribeTodos,
} from "./store.js";

beforeEach(() => {
  localStorage.clear();
  resetTodoStore();
});

describe("会话级任务清单", () => {
  it("按会话隔离：A 会话的计划不会出现在 B 会话", () => {
    setTodos("conv-a", [{ content: "读入口文件", status: "in_progress" }]);
    setTodos("conv-b", [{ content: "改登录文案", status: "pending" }]);
    expect(getTodos("conv-a")).toEqual([{ content: "读入口文件", status: "in_progress" }]);
    expect(getTodos("conv-b")).toEqual([{ content: "改登录文案", status: "pending" }]);
    expect(getTodos("conv-c")).toEqual([]);
  });

  it("整份替换而不是增量合并（模型少给一条就该少一条）", () => {
    setTodos("c", [
      { content: "一", status: "completed" },
      { content: "二", status: "pending" },
    ]);
    setTodos("c", [{ content: "一", status: "completed" }]);
    expect(getTodos("c").map((t) => t.content)).toEqual(["一"]);
  });

  it("读出来的是副本：改返回值不会改内部状态", () => {
    setTodos("c", [{ content: "一", status: "pending" }]);
    const list = getTodos("c");
    list[0].content = "被篡改";
    expect(getTodos("c")[0].content).toBe("一");
  });

  it("空清单等于清空，并把自己从存储里删掉", () => {
    setTodos("c", [{ content: "一", status: "pending" }]);
    setTodos("c", []);
    expect(getTodos("c")).toEqual([]);
    expect(localStorage.getItem(TODOS_KEY)).not.toContain('"c"');
    clearTodos("c"); // 幂等
    expect(getTodos("c")).toEqual([]);
  });

  it("落 localStorage：重开应用（重置内存缓存）能读回", () => {
    setTodos("c", [
      { content: "一", status: "completed" },
      { content: "二", status: "in_progress" },
    ]);
    resetTodoStore();
    expect(getTodos("c")).toHaveLength(2);
    expect(getTodos("c")[1]).toEqual({ content: "二", status: "in_progress" });
  });

  it("存储坏了不抛错：按空清单处理（对话不能因为计划丢了就失败）", () => {
    localStorage.setItem(TODOS_KEY, "{不是 JSON");
    resetTodoStore();
    expect(getTodos("c")).toEqual([]);
    // 坏了之后还能正常写入
    setTodos("c", [{ content: "一", status: "pending" }]);
    expect(getTodos("c")).toHaveLength(1);
  });

  it("存储里的坏条目逐条丢弃，好的保留", () => {
    localStorage.setItem(
      TODOS_KEY,
      JSON.stringify({
        c: {
          updatedAt: 1,
          items: [
            { content: "好条目", status: "pending" },
            { content: "", status: "pending" },
            { content: "坏状态", status: "doing" },
            null,
          ],
        },
      }),
    );
    resetTodoStore();
    expect(getTodos("c")).toEqual([{ content: "好条目", status: "pending" }]);
  });

  it(`最多保留 ${MAX_STORED_LISTS} 个会话：超出按最近更新淘汰`, () => {
    for (let i = 0; i < MAX_STORED_LISTS + 5; i += 1) {
      setTodos(`c${i}`, [{ content: `任务${i}`, status: "pending" }]);
    }
    const stored = JSON.parse(localStorage.getItem(TODOS_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(MAX_STORED_LISTS);
    // 最早的几个已经不在了，最近的还在
    expect(getTodos("c0")).toEqual([]);
    expect(getTodos(`c${MAX_STORED_LISTS + 4}`)).toHaveLength(1);
  });

  it(`重开应用后淘汰的仍是最久没用的会话（LRU 序号跨重启还原，不把刚用的那份删掉）`, () => {
    // 造满 MAX_STORED_LISTS 个会话：c0 最早写、c49 最近写。
    for (let i = 0; i < MAX_STORED_LISTS; i += 1) {
      setTodos(`c${i}`, [{ content: `任务${i}`, status: "pending" }]);
    }
    // 再把 c49 碰一下，确保它是全场 MRU；c0 保持 LRU。
    setTodos("c49", [{ content: "c49-更新", status: "pending" }]);
    // 模拟「关掉应用再打开」：内存序号清零，只能靠落盘的 seq 还原次序。
    resetTodoStore();
    expect(getTodos("c49")).toEqual([{ content: "c49-更新", status: "pending" }]);

    // 第 51 个会话写入触发淘汰：应删最旧的 c0，留最近用过的 c49。
    setTodos("cNew", [{ content: "新任务", status: "pending" }]);
    expect(getTodos("c0")).toEqual([]); // 最久没用 → 被淘汰
    expect(getTodos("c49")).toEqual([{ content: "c49-更新", status: "pending" }]); // 刚用过 → 保留
    expect(getTodos("cNew")).toHaveLength(1);
    const stored = JSON.parse(localStorage.getItem(TODOS_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(MAX_STORED_LISTS);
  });

  it("计数口径：pending / in_progress / completed 各自算清楚", () => {
    expect(
      countTodos([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
        { content: "d", status: "pending" },
      ]),
    ).toEqual({ total: 4, pending: 2, inProgress: 1, completed: 1 });
  });

  it("渲染：进度行 + 编号 + 状态标记（模型要能一眼读回）", () => {
    const text = formatTodos([
      { content: "读入口", status: "completed" },
      { content: "改文案", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ]);
    expect(text.split("\n")[0]).toBe("进度：1/3 已完成，1 进行中，1 待开始");
    expect(text).toContain("1. [x] 读入口");
    expect(text).toContain("2. [>] 改文案");
    expect(text).toContain("3. [ ] 跑测试");
    expect(formatTodos([])).toBe("（空清单）");
  });

  it(`单会话上限 ${MAX_TODOS} 条由写入口（todo_write）保证，存储层不静默截断`, () => {
    const list = Array.from({ length: MAX_TODOS }, (_, i) => ({
      content: `步骤${i}`,
      status: "pending" as const,
    }));
    setTodos("c", list);
    expect(getTodos("c")).toHaveLength(MAX_TODOS);
  });

  describe("变更订阅（d.158 清单要渲染进界面）", () => {
    it("写入/清空都会通知，并带上变化的会话 id", () => {
      const seen: (string | undefined)[] = [];
      const off = subscribeTodos((id) => seen.push(id));
      setTodos("a", [{ content: "一", status: "pending" }]);
      setTodos("a", []); // 清空也算变更：界面必须把面板收掉
      off();
      expect(seen).toEqual(["a", "a"]);
    });

    it("退订后不再通知（组件卸载不能继续 setState）", () => {
      let calls = 0;
      const off = subscribeTodos(() => {
        calls += 1;
      });
      setTodos("a", [{ content: "一", status: "pending" }]);
      off();
      setTodos("a", [{ content: "二", status: "pending" }]);
      expect(calls).toBe(1);
    });

    it("某个订阅者抛错不影响其它订阅者（UI 崩了不能丢变更事实）", () => {
      let ok = 0;
      const offBad = subscribeTodos(() => {
        throw new Error("渲染炸了");
      });
      const offGood = subscribeTodos(() => {
        ok += 1;
      });
      expect(() => setTodos("a", [{ content: "一", status: "pending" }])).not.toThrow();
      expect(ok).toBe(1);
      offBad();
      offGood();
    });
  });
});
