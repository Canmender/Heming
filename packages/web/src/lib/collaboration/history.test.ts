import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import {
  COLLAB_HISTORY_KEY,
  COLLAB_HISTORY_MAX_CHARS,
  clearLastRun,
  loadLastRun,
  saveLastRun,
} from "./history.js";
import type { CollaborationRun } from "./types.js";

function run(overrides: Partial<CollaborationRun> = {}): CollaborationRun {
  return {
    id: "r1",
    mode: "sequential",
    task: "整理季度复盘",
    participants: [
      { agentId: "a1", name: "小研", systemPrompt: "私有提示词" },
      { agentId: "a2", name: "小写" },
    ],
    rounds: 1,
    turns: [
      {
        id: "t1",
        agentId: "a1",
        agentName: "小研",
        role: "方案",
        round: 1,
        text: "第一版方案",
        startedAt: 1,
        endedAt: 2,
      },
    ],
    status: "done",
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
}

describe("协作历史 · localStorage 最近一次", () => {
  it("保存后可读回，且不落私有 systemPrompt", () => {
    const store = createMemoryStorage();
    saveLastRun(run(), store);
    const loaded = loadLastRun(store);
    expect(loaded?.task).toBe("整理季度复盘");
    expect(loaded?.turns[0].text).toBe("第一版方案");
    expect(loaded?.participants).toEqual([
      { agentId: "a1", name: "小研" },
      { agentId: "a2", name: "小写" },
    ]);
    expect(store.getItem(COLLAB_HISTORY_KEY)).not.toContain("私有提示词");
  });

  it("超长正文会被截断到上限内", () => {
    const store = createMemoryStorage();
    saveLastRun(
      run({
        turns: Array.from({ length: 5 }, (_, i) => ({
          id: `t${i}`,
          agentId: "a1",
          agentName: "小研",
          role: "方案",
          round: 1,
          text: "长".repeat(40_000),
          startedAt: 1,
          endedAt: 2,
        })),
      }),
      store,
    );
    const raw = store.getItem(COLLAB_HISTORY_KEY) ?? "";
    expect(raw.length).toBeLessThanOrEqual(COLLAB_HISTORY_MAX_CHARS);
    expect(loadLastRun(store)?.turns).toHaveLength(5);
  });

  it("上次未结束（running）按中止恢复；脏数据返回 null", () => {
    const store = createMemoryStorage();
    saveLastRun(run({ status: "running" }), store);
    expect(loadLastRun(store)?.status).toBe("aborted");

    store.setItem(COLLAB_HISTORY_KEY, "{broken");
    expect(loadLastRun(store)).toBeNull();
    store.setItem(COLLAB_HISTORY_KEY, JSON.stringify({ mode: "unknown" }));
    expect(loadLastRun(store)).toBeNull();
  });

  it("可清除", () => {
    const store = createMemoryStorage();
    saveLastRun(run(), store);
    clearLastRun(store);
    expect(loadLastRun(store)).toBeNull();
  });
});
