import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  ALL_WEEKDAYS,
  MAX_AUTOMATIONS,
  nextRunAt,
  type AutomationDraft,
  type AutomationTask,
} from "./model.js";
import {
  AUTOMATIONS_KEY,
  readAutomations,
  setAutomationStorage,
  useAutomationStore,
} from "./store.js";

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const draft: AutomationDraft = {
  name: "同步归档",
  kind: "infohub.sync",
  schedule: { type: "daily", time: "09:00", weekdays: [...ALL_WEEKDAYS] },
  sync: { sources: ["qq", "wechat"], full: false, archive: false },
};

function makeTask(overrides: Partial<AutomationTask> = {}): AutomationTask {
  const now = at(2026, 11, 1, 12, 0);
  return {
    id: "t1",
    name: "同步归档",
    kind: "infohub.sync",
    enabled: true,
    schedule: { type: "interval", minutes: 60 },
    sync: { sources: ["qq"], full: false, archive: false },
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    runCount: 0,
    ...overrides,
  };
}

function stored(mem: StorageLike): AutomationTask[] {
  return JSON.parse(mem.getItem(AUTOMATIONS_KEY) ?? "[]") as AutomationTask[];
}

let mem: StorageLike;

beforeEach(() => {
  mem = createMemoryStorage();
  setAutomationStorage(mem);
  useAutomationStore.setState({ tasks: [], runningId: null, runningSince: 0 });
});

afterEach(() => {
  setAutomationStorage(null);
});

describe("自动化 store · 增删改", () => {
  it("create 落盘并按当前时刻排期", () => {
    const now = at(2026, 11, 2, 8, 0); // 周一
    const result = useAutomationStore.getState().create(draft, now);
    expect(result.ok).toBe(true);
    const tasks = useAutomationStore.getState().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].nextRunAt).toBe(at(2026, 11, 2, 9, 0));
    expect(stored(mem)).toHaveLength(1);
    expect(stored(mem)[0].name).toBe("同步归档");
  });

  it("非法草稿拒绝且不落盘；超过上限拒绝", () => {
    const store = useAutomationStore.getState();
    expect(store.create({ ...draft, name: "" }, 1000)).toEqual({
      ok: false,
      error: "请填写任务名称",
    });
    expect(useAutomationStore.getState().tasks).toHaveLength(0);

    for (let i = 0; i < MAX_AUTOMATIONS; i += 1) {
      const res = useAutomationStore.getState().create(
        {
          ...draft,
          name: `任务 ${i}`,
          schedule: { type: "interval", minutes: 60 },
        },
        1000,
      );
      expect(res.ok).toBe(true);
    }
    const overflow = useAutomationStore.getState().create({ ...draft, name: "再来一个" }, 1000);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain(String(MAX_AUTOMATIONS));
  });

  it("update 改频率即重新排期；未知 id 报错", () => {
    const created = useAutomationStore.getState().create(draft, at(2026, 11, 2, 8, 0));
    expect(created.ok).toBe(true);
    const id = created.ok ? created.id : "";
    const now = at(2026, 11, 2, 10, 0);
    const updated = useAutomationStore.getState().update(
      id,
      { ...draft, name: "改名", schedule: { type: "interval", minutes: 30 } },
      now,
    );
    expect(updated).toEqual({ ok: true, id });
    const task = useAutomationStore.getState().tasks[0];
    expect(task.name).toBe("改名");
    expect(task.nextRunAt).toBe(nextRunAt({ type: "interval", minutes: 30 }, now));
    expect(
      useAutomationStore.getState().update("missing", draft, now),
    ).toEqual({ ok: false, error: "任务不存在" });
  });

  it("remove / setEnabled：停用保留计划，重新启用从当前时刻重排", () => {
    useAutomationStore.setState({
      tasks: [makeTask({ id: "a", enabled: false, nextRunAt: 1 })],
    });
    const now = at(2026, 11, 1, 12, 0);
    useAutomationStore.getState().setEnabled("a", true, now);
    const enabled = useAutomationStore.getState().tasks[0];
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeGreaterThan(now);

    const before = enabled.nextRunAt;
    useAutomationStore.getState().setEnabled("a", false, now);
    expect(useAutomationStore.getState().tasks[0].nextRunAt).toBe(before);

    useAutomationStore.getState().remove("a");
    expect(useAutomationStore.getState().tasks).toHaveLength(0);
    expect(stored(mem)).toHaveLength(0);
  });
});

describe("自动化 store · 执行状态", () => {
  it("beginRun 串行保护；finishRun 记录结果并顺延下次", () => {
    const now = at(2026, 11, 1, 12, 0);
    useAutomationStore.setState({ tasks: [makeTask({ nextRunAt: now })] });
    expect(useAutomationStore.getState().beginRun("t1", now)).toBe(true);
    expect(useAutomationStore.getState().beginRun("t1", now)).toBe(false);
    expect(useAutomationStore.getState().beginRun("missing", now)).toBe(false);

    const finishedAt = now + 30_000;
    useAutomationStore
      .getState()
      .finishRun("t1", { status: "ok", detail: "同步完成：QQ 新增 3" }, finishedAt);
    const task = useAutomationStore.getState().tasks[0];
    expect(useAutomationStore.getState().runningId).toBeNull();
    expect(task.lastStatus).toBe("ok");
    expect(task.lastDetail).toContain("QQ 新增 3");
    expect(task.runCount).toBe(1);
    expect(task.lastRunAt).toBe(finishedAt);
    expect(task.nextRunAt).toBe(nextRunAt(task.schedule, finishedAt));
    expect(stored(mem)[0].lastStatus).toBe("ok");
  });

  it("任务被删除后收尾只释放执行权", () => {
    const now = at(2026, 11, 1, 12, 0);
    useAutomationStore.setState({ tasks: [makeTask({ id: "t1" })], runningId: "t1", runningSince: now });
    useAutomationStore.getState().finishRun("t1", { status: "error", detail: "x" }, now);
    expect(useAutomationStore.getState().runningId).toBeNull();
  });

  it("rescheduleMissed 只顺延启用且已过期的任务", () => {
    const since = at(2026, 11, 2, 12, 0);
    useAutomationStore.setState({
      tasks: [
        makeTask({ id: "due", enabled: true, nextRunAt: since - 60_000 }),
        makeTask({ id: "future", enabled: true, nextRunAt: since + 60_000 }),
        makeTask({ id: "off", enabled: false, nextRunAt: since - 60_000 }),
      ],
    });
    expect(useAutomationStore.getState().rescheduleMissed(since, since)).toBe(1);
    const tasks = useAutomationStore.getState().tasks;
    expect(tasks.find((t) => t.id === "due")!.nextRunAt).toBeGreaterThan(since);
    expect(tasks.find((t) => t.id === "future")!.nextRunAt).toBe(since + 60_000);
    expect(tasks.find((t) => t.id === "off")!.nextRunAt).toBe(since - 60_000);
  });
});

describe("readAutomations", () => {
  it("丢弃损坏条目、去重，并补算缺失的下次时间", () => {
    const now = at(2026, 11, 1, 12, 0);
    const raw = [
      { id: "ok", name: "同步", kind: "infohub.sync", schedule: { type: "interval", minutes: 30 }, sync: { sources: ["qq"] } },
      { id: "ok", name: "重复", kind: "infohub.sync", schedule: { type: "interval", minutes: 30 }, sync: { sources: ["qq"] } },
      { id: "bad", name: "坏", kind: "infohub.sync", schedule: { type: "daily", time: "99:99" }, sync: { sources: ["qq"] } },
      null,
    ];
    const memory = createMemoryStorage();
    memory.setItem(AUTOMATIONS_KEY, JSON.stringify(raw));
    const tasks = readAutomations(memory, now);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("ok");
    expect(tasks[0].nextRunAt).toBe(nextRunAt(tasks[0].schedule, now));
  });

  it("损坏 JSON / 非数组回退空", () => {
    const memory = createMemoryStorage();
    memory.setItem(AUTOMATIONS_KEY, "not json");
    expect(readAutomations(memory, 0)).toEqual([]);
    memory.setItem(AUTOMATIONS_KEY, "{}");
    expect(readAutomations(memory, 0)).toEqual([]);
  });
});
