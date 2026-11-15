import { describe, expect, it } from "vitest";
import {
  RECALL_DROP_LABELS,
  RECALL_EXPLAIN_LIMIT,
  explainRecalls,
  recallLayerLabel,
} from "./explain.js";
import type { RecallRun } from "./recallLog.js";

/**
 * 「注入可解释」（P3/T17）。
 *
 * 这层只做筛选/倒序/补标签，但正是最容易出错的一层：把别人的档案当成本会话的、
 * 把「没注入」说成「没召回」、把被预算裁掉的条目静默吞掉——面板一旦这么骗人，
 * 用户就再也定位不到「该召回没召回」是哪条、为什么。
 */

function run(id: string, conversationId: string, overrides: Partial<RecallRun> = {}): RecallRun {
  return {
    id,
    at: `2026-11-15T0${id}:00:00.000Z`,
    agentId: "a1",
    conversationId,
    query: `问题 ${id}`,
    recalled: { semantic: 2, episodic: 1, working: 0 },
    injected: [{ id: "s1", layer: "semantic", content: "称呼：阿和", truncated: false }],
    dropped: [],
    used: [],
    ...overrides,
  };
}

describe("explainRecalls", () => {
  it("只挑本会话的档案：别人的注入不能显示在我的面板里", () => {
    const rows = explainRecalls([run("1", "c1"), run("2", "c2"), run("3", "c1")], "c1");
    expect(rows.map((r) => r.id)).toEqual(["3", "1"]);
  });

  it("最新的在最上面（日志升序、面板倒序）", () => {
    const rows = explainRecalls([run("1", "c1"), run("2", "c1"), run("3", "c1")], "c1", 2);
    expect(rows.map((r) => r.id)).toEqual(["3", "2"]);
    expect(RECALL_EXPLAIN_LIMIT).toBe(3);
  });

  it("空会话 id 直接返回空：不把「不知道属于谁」当成本会话", () => {
    expect(explainRecalls([run("1", "")], "")).toEqual([]);
  });

  it("注入与被裁分开保留：被裁的条目带内容与原因，才能定位「该召回没召回」", () => {
    const rows = explainRecalls(
      [
        run("1", "c1", {
          dropped: [
            { id: "s9", layer: "semantic", reason: "budget", content: "旧称呼：小和" },
            { id: "e9", layer: "episodic", reason: "superseded" },
          ],
          used: ["s1"],
        }),
      ],
      "c1",
    );
    expect(rows[0].injected).toHaveLength(1);
    expect(rows[0].injected[0].id).toBe("s1");
    expect(rows[0].dropped.map((d) => d.id)).toEqual(["s9", "e9"]);
    expect(rows[0].dropped[0].content).toBe("旧称呼：小和");
    expect(rows[0].used).toEqual(["s1"]);
  });

  it("打分与截断标记原样带上（面板据此说明「这条是按分进来的」）", () => {
    const rows = explainRecalls(
      [
        run("1", "c1", {
          injected: [{ id: "e1", layer: "episodic", content: "讨论了发布计划", score: 0.42, truncated: true }],
        }),
      ],
      "c1",
    );
    expect(rows[0].injected[0]).toMatchObject({ score: 0.42, truncated: true });
  });

  it("没有档案时返回空数组（面板据此整块省略，而不是给全 0）", () => {
    expect(explainRecalls([], "c1")).toEqual([]);
  });
});

describe("文案映射", () => {
  it("被裁原因与记忆层都有中文名，不会漏出英文枚举", () => {
    expect(RECALL_DROP_LABELS.budget).toBe("预算不够");
    expect(RECALL_DROP_LABELS.superseded).toBe("被同键新值覆盖");
    expect(recallLayerLabel("semantic")).toBe("语义");
    expect(recallLayerLabel("episodic")).toBe("情景");
    expect(recallLayerLabel("working")).toBe("工作");
  });
});
