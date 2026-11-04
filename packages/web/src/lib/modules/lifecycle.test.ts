import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import { ALL_WEEKDAYS, type AutomationDraft } from "../automation/model.js";
import {
  AUTOMATIONS_KEY,
  setAutomationStorage,
  useAutomationStore,
} from "../automation/store.js";
import {
  AUTOMATION_RUNS_KEY,
  setAutomationRunStorage,
  useAutomationRunsStore,
} from "../automation/runs.js";
import {
  DEFAULT_STAFF_SETTINGS,
  STAFF_RUNS_KEY,
  STAFF_SEEN_KEY,
  STAFF_SETTINGS_KEY,
  normalizeSettings,
  normalizeSeen,
  type StaffRun,
} from "../staff/model.js";
import { setStaffStorage, useStaffStore } from "../staff/store.js";
import { moduleCleanupPlan } from "./lifecycle.js";

/**
 * 模块「清理本机数据」的纯逻辑用例（d.71）。
 *
 * 这里不渲染组件：清理的真实风险在数据侧——配置是否被误删、级联是否漏、运行中是否
 * 被拦住。UI 只负责确认与提示（由 ModulesView 用例覆盖）。
 */

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

const draft: AutomationDraft = {
  name: "同步归档",
  kind: "infohub.sync",
  schedule: { type: "daily", time: "09:00", weekdays: [...ALL_WEEKDAYS] },
  sync: { sources: ["qq"], full: false, archive: false },
};

let staffStorage: ReturnType<typeof createMemoryStorage>;
let automationStorage: ReturnType<typeof createMemoryStorage>;
let runsStorage: ReturnType<typeof createMemoryStorage>;

beforeEach(() => {
  staffStorage = createMemoryStorage();
  setStaffStorage(staffStorage);
  automationStorage = createMemoryStorage();
  setAutomationStorage(automationStorage);
  runsStorage = createMemoryStorage();
  setAutomationRunStorage(runsStorage);

  useStaffStore.setState({
    settings: normalizeSettings(null),
    runs: [run(), run({ id: "run-2", summary: "3 条临期" })],
    seen: { agenda: { "2026-11-01": 1 }, tasks: { t1: 2 } },
  });
  useAutomationStore.setState({
    tasks: [],
    runningId: null,
    runningSince: 0,
    runningTrigger: "schedule",
  });
  useAutomationRunsStore.setState({ runs: [] });
});

describe("moduleCleanupPlan", () => {
  it("信息中枢没有清理入口：外部数据不归和鸣删", () => {
    expect(moduleCleanupPlan("infohub")).toBeNull();
  });

  it("幕僚：清简报与已见账本，保留设置，且磁盘与内存一致", () => {
    useStaffStore.getState().updateSettings({ enabled: true, dailyRunCap: 5 });
    const plan = moduleCleanupPlan("staff");
    expect(plan).not.toBeNull();
    expect(plan?.items.length).toBeGreaterThan(0);

    expect(plan?.run()).toBeNull();

    const state = useStaffStore.getState();
    expect(state.runs).toEqual([]);
    expect(state.seen).toEqual(normalizeSeen(null));
    // 「是否常驻 / 频率」属于配置，清理不能顺手重置
    expect(state.settings.enabled).toBe(true);
    expect(state.settings.dailyRunCap).toBe(5);

    expect(JSON.parse(staffStorage.getItem(STAFF_RUNS_KEY) as string)).toEqual([]);
    expect(staffStorage.getItem(STAFF_SEEN_KEY)).not.toContain("2026-11-01");
    // 设置键仍在
    expect(JSON.parse(staffStorage.getItem(STAFF_SETTINGS_KEY) as string).enabled).toBe(true);
    expect(DEFAULT_STAFF_SETTINGS.enabled).toBe(false);
  });

  it("自动化：删全部任务并级联删运行记录，磁盘同步清空", () => {
    const first = useAutomationStore.getState().create(draft, NOW);
    const second = useAutomationStore.getState().create(draft, NOW + 60_000);
    expect(first.ok && second.ok).toBe(true);
    const taskId = first.ok ? first.id : "";
    useAutomationRunsStore.getState().recordRun({
      id: "r1",
      taskId,
      taskName: "同步归档",
      kind: "infohub.sync",
      trigger: "manual",
      status: "ok",
      detail: "已同步 2 个来源",
      startedAt: NOW,
      finishedAt: NOW + 1000,
      durationMs: 1000,
    });

    const plan = moduleCleanupPlan("automations");
    expect(plan?.run()).toBeNull();

    expect(useAutomationStore.getState().tasks).toEqual([]);
    expect(useAutomationRunsStore.getState().runs).toEqual([]);
    expect(JSON.parse(automationStorage.getItem(AUTOMATIONS_KEY) as string)).toEqual([]);
    expect(JSON.parse(runsStorage.getItem(AUTOMATION_RUNS_KEY) as string)).toEqual([]);
  });

  it("自动化：有任务在运行时不清理，任务与记录原样保留", () => {
    const created = useAutomationStore.getState().create(draft, NOW);
    const taskId = created.ok ? created.id : "";
    expect(useAutomationStore.getState().beginRun(taskId, NOW)).toBe(true);

    const plan = moduleCleanupPlan("automations");
    const error = plan?.run();
    expect(error).toContain("正在运行");
    expect(useAutomationStore.getState().tasks).toHaveLength(1);
    expect(useAutomationStore.getState().runningId).toBe(taskId);
  });
});
