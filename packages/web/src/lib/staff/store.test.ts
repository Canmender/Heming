import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import {
  STAFF_RUNS_KEY,
  STAFF_SEEN_KEY,
  STAFF_SETTINGS_KEY,
  DEFAULT_STAFF_SETTINGS,
  normalizeSettings,
  todayKey,
  type StaffRun,
} from "./model.js";
import {
  readStaffRuns,
  readStaffSeen,
  readStaffSettings,
  setStaffStorage,
  useStaffStore,
} from "./store.js";

const NOW = new Date(2026, 10, 1, 9, 0).getTime();

function run(patch: Partial<StaffRun> = {}): StaffRun {
  return {
    id: "run-1",
    trigger: "manual",
    mode: "rules",
    startedAt: NOW,
    finishedAt: NOW,
    summary: "今天没有临期事项",
    findings: [],
    tokens: null,
    ...patch,
  };
}

let storage: ReturnType<typeof createMemoryStorage>;

beforeEach(() => {
  storage = createMemoryStorage();
  setStaffStorage(storage);
  useStaffStore.setState({
    settings: normalizeSettings(null),
    runs: [],
    seen: { agenda: {}, tasks: {} },
  });
});

describe("幕僚设置", () => {
  it("局部更新：sources 合并而不是整体覆盖，越界值夹紧并落盘", () => {
    const next = useStaffStore.getState().updateSettings({
      enabled: true,
      sources: { agenda: false },
      dailyRunCap: 99,
    });
    expect(next.enabled).toBe(true);
    expect(next.sources).toEqual({ daily: true, agenda: false, task: true });
    expect(next.dailyRunCap).toBe(24);
    const saved = JSON.parse(storage.getItem(STAFF_SETTINGS_KEY) as string);
    expect(saved.enabled).toBe(true);
    expect(saved.sources.agenda).toBe(false);
    expect(readStaffSettings(storage).enabled).toBe(true);
  });

  it("坏 JSON → 默认设置（默认关闭）", () => {
    storage.setItem(STAFF_SETTINGS_KEY, "{坏");
    expect(readStaffSettings(storage)).toEqual(DEFAULT_STAFF_SETTINGS);
  });
});

describe("简报历史", () => {
  it("新简报在前；同一 id 覆盖不重复", () => {
    useStaffStore.getState().recordRun(run({ id: "a", startedAt: NOW - 1000 }));
    useStaffStore.getState().recordRun(run({ id: "b" }));
    useStaffStore.getState().recordRun(run({ id: "a", summary: "更新过", startedAt: NOW }));
    const runs = useStaffStore.getState().runs;
    expect(runs.map((item) => item.id)).toEqual(["a", "b"]);
    expect(runs[0].summary).toBe("更新过");
    expect(JSON.parse(storage.getItem(STAFF_RUNS_KEY) as string)).toHaveLength(2);
  });

  it("晨报落盘时把 lastDailyDate 记为今天", () => {
    useStaffStore.getState().recordRun(run({ trigger: "daily", startedAt: NOW }));
    expect(useStaffStore.getState().settings.lastDailyDate).toBe(todayKey(NOW));
    expect(readStaffSettings(storage).lastDailyDate).toBe(todayKey(NOW));
  });

  it("事件运行不写 lastDailyDate", () => {
    useStaffStore.getState().recordRun(run({ trigger: "agenda", startedAt: NOW }));
    expect(useStaffStore.getState().settings.lastDailyDate).toBeNull();
  });

  it("读盘丢弃结构不符的条目，按时间保留最新 30 份", () => {
    const items = Array.from({ length: 35 }, (_, i) =>
      run({ id: `r${i}`, startedAt: NOW - i * 1000 }),
    );
    storage.setItem(STAFF_RUNS_KEY, JSON.stringify([...items, { id: "bad" }, null]));
    const runs = readStaffRuns(storage);
    expect(runs).toHaveLength(30);
    expect(runs[0].id).toBe("r0");
  });

  it("清空历史不影响去重账本", () => {
    useStaffStore.getState().recordRun(run());
    useStaffStore.getState().markSeen({ agenda: ["1:overdue"], tasks: [] }, NOW);
    useStaffStore.getState().clearRuns();
    expect(useStaffStore.getState().runs).toEqual([]);
    expect(useStaffStore.getState().seen.agenda["1:overdue"]).toBe(NOW);
    expect(JSON.parse(storage.getItem(STAFF_RUNS_KEY) as string)).toEqual([]);
  });
});

describe("去重账本", () => {
  it("写入两类键并落盘；重复标记只更新时间", () => {
    useStaffStore.getState().markSeen({ agenda: ["1:today"], tasks: ["t1:failed:5"] }, NOW);
    useStaffStore.getState().markSeen({ agenda: ["1:today"], tasks: [] }, NOW + 1000);
    const seen = readStaffSeen(storage);
    expect(seen.agenda["1:today"]).toBe(NOW + 1000);
    expect(seen.tasks["t1:failed:5"]).toBe(NOW);
    expect(JSON.parse(storage.getItem(STAFF_SEEN_KEY) as string).agenda["1:today"]).toBe(NOW + 1000);
  });

  it("坏数据回退空账本", () => {
    storage.setItem(STAFF_SEEN_KEY, "[]");
    expect(readStaffSeen(storage)).toEqual({ agenda: {}, tasks: {} });
  });
});
