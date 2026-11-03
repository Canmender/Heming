import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, utf8Length } from "../memory/storage.js";
import { MAX_DETAIL_CHARS } from "./model.js";
import {
  AUTOMATION_RUNS_KEY,
  MAX_AUTOMATION_RUNS,
  normalizeRun,
  pruneRuns,
  readAutomationRuns,
  setAutomationRunStorage,
  useAutomationRunsStore,
  type AutomationRun,
} from "./runs.js";

/**
 * 自动化运行记录（独立键）的纯函数与 store 用例。
 *
 * 钉三件事：
 * 1. 坏条目怎么丢——读盘时逐条 normalize，不因一条坏数据整表回退；
 * 2. 怎么淘汰——条数上限 + 字节上限双保险，最新在前；
 * 3. 怎么级联——任务删除时记录一起摘掉（页面文案已承诺）。
 */

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    taskId: "t1",
    taskName: "同步本机归档",
    kind: "infohub.sync",
    trigger: "schedule",
    status: "ok",
    detail: "同步完成：QQ 新增 3 条",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_012_000,
    durationMs: 12_000,
    ...overrides,
  };
}

let mem = createMemoryStorage();

beforeEach(() => {
  mem = createMemoryStorage();
  setAutomationRunStorage(mem);
  useAutomationRunsStore.setState({ runs: [] });
});

afterEach(() => {
  setAutomationRunStorage(null);
});

describe("normalizeRun（单条校验与归整）", () => {
  it("缺字段、未知枚举、坏时间一律丢弃", () => {
    expect(normalizeRun(null)).toBeNull();
    expect(normalizeRun("run")).toBeNull();
    expect(normalizeRun({ ...makeRun(), id: "" })).toBeNull();
    expect(normalizeRun({ ...makeRun(), taskId: "  " })).toBeNull();
    expect(normalizeRun({ ...makeRun(), taskName: "" })).toBeNull();
    expect(normalizeRun({ ...makeRun(), kind: "script.run" })).toBeNull();
    expect(normalizeRun({ ...makeRun(), trigger: "retry" })).toBeNull();
    expect(normalizeRun({ ...makeRun(), status: "running" })).toBeNull();
    expect(normalizeRun({ ...makeRun(), startedAt: Number.NaN })).toBeNull();
    expect(normalizeRun({ ...makeRun(), startedAt: 0 })).toBeNull();
  });

  it("detail 压成一行并截断；缺 finishedAt/durationMs 时按开始时间补算", () => {
    const longDetail = "失".repeat(MAX_DETAIL_CHARS + 40);
    const run = normalizeRun({
      ...makeRun(),
      detail: `第一行\n第二行   第三行 ${longDetail}`,
      finishedAt: undefined,
      durationMs: undefined,
    });
    expect(run).not.toBeNull();
    expect(run!.detail).not.toContain("\n");
    expect(run!.detail).toContain("第一行 第二行 第三行");
    expect([...run!.detail]).toHaveLength(MAX_DETAIL_CHARS);
    // 只丢了 finishedAt：用 startedAt 兜底，耗时归零而不是负值
    expect(run!.finishedAt).toBe(run!.startedAt);
    expect(run!.durationMs).toBe(0);
  });

  it("负数/非数字耗时按时间差重算，不把负值带进列表", () => {
    const run = normalizeRun({ ...makeRun(), durationMs: -5 });
    expect(run!.durationMs).toBe(12_000);
  });
});

describe("pruneRuns（条数 + 字节双淘汰）", () => {
  it("超过条数上限时淘汰最旧", () => {
    const items = Array.from({ length: MAX_AUTOMATION_RUNS + 8 }, (_, i) =>
      makeRun({ id: `r${i}`, startedAt: 1_000 + i }),
    );
    const pruned = pruneRuns(items);
    expect(pruned).toHaveLength(MAX_AUTOMATION_RUNS);
    expect(pruned[0].id).toBe(`r${MAX_AUTOMATION_RUNS + 7}`);
    expect(pruned.some((run) => run.id === "r0")).toBe(false);
  });

  it("字节超限时从最旧开始丢，且结果一定装得下", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeRun({ id: `r${i}`, startedAt: 1_000 + i, detail: "字".repeat(100) }),
    );
    const limit = Math.floor(utf8Length(JSON.stringify([items[0]])) * 1.5);
    const pruned = pruneRuns(items, limit);
    expect(pruned.length).toBeLessThan(items.length);
    expect(pruned[0].id).toBe("r9");
    expect(utf8Length(JSON.stringify(pruned))).toBeLessThanOrEqual(limit);
  });

  it("单条都装不下时清空（写一个超限数组只会让整个键失效）", () => {
    const huge = makeRun({ detail: "字".repeat(MAX_DETAIL_CHARS) });
    expect(pruneRuns([huge], 10)).toEqual([]);
  });
});

describe("readAutomationRuns（读盘回退）", () => {
  it("缺键 / 坏 JSON / 非数组回退空", () => {
    expect(readAutomationRuns(mem)).toEqual([]);
    mem.setItem(AUTOMATION_RUNS_KEY, "{oops");
    expect(readAutomationRuns(mem)).toEqual([]);
    mem.setItem(AUTOMATION_RUNS_KEY, JSON.stringify({ runs: [] }));
    expect(readAutomationRuns(mem)).toEqual([]);
  });

  it("坏条目逐条丢弃，好条目照读，并按条数上限淘汰", () => {
    const good = Array.from({ length: MAX_AUTOMATION_RUNS + 5 }, (_, i) =>
      makeRun({ id: `r${i}`, startedAt: 1_000 + i }),
    );
    mem.setItem(
      AUTOMATION_RUNS_KEY,
      JSON.stringify([...good, { id: "bad" }, null, { ...makeRun({ id: "x" }), status: "wat" }]),
    );
    const runs = readAutomationRuns(mem);
    expect(runs).toHaveLength(MAX_AUTOMATION_RUNS);
    // 最新在前：超出的最旧 5 条被淘汰
    expect(runs[0].id).toBe(`r${MAX_AUTOMATION_RUNS + 4}`);
    expect(runs.some((run) => run.id === "r0")).toBe(false);
  });
});

describe("useAutomationRunsStore", () => {
  it("recordRun 前插、按 id 去重、并落盘", () => {
    useAutomationRunsStore.getState().recordRun(makeRun({ id: "a", startedAt: 1_000 }));
    const runs = useAutomationRunsStore
      .getState()
      .recordRun(makeRun({ id: "b", startedAt: 2_000 }));
    expect(runs.map((run) => run.id)).toEqual(["b", "a"]);

    // 同 id 再记一次：覆盖而不是追加（同一记录被重复收尾时不该出现两条）
    const again = useAutomationRunsStore
      .getState()
      .recordRun(makeRun({ id: "a", startedAt: 3_000, status: "error", detail: "连接失败" }));
    expect(again.map((run) => run.id)).toEqual(["a", "b"]);
    expect(again[0].detail).toBe("连接失败");
    expect(JSON.parse(mem.getItem(AUTOMATION_RUNS_KEY) as string)).toHaveLength(2);
  });

  it("写不进存储时仍保留内存态（本次会话可见，重启后消失）", () => {
    const full = createMemoryStorage();
    full.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    setAutomationRunStorage(full);
    useAutomationRunsStore.getState().recordRun(makeRun({ id: "mem-only" }));
    expect(useAutomationRunsStore.getState().runs.map((run) => run.id)).toEqual(["mem-only"]);
  });

  it("removeForTask 只摘该任务的记录；没有记录时是 no-op", () => {
    useAutomationRunsStore.getState().recordRun(makeRun({ id: "a", taskId: "t1" }));
    useAutomationRunsStore.getState().recordRun(makeRun({ id: "b", taskId: "t2" }));
    useAutomationRunsStore.getState().removeForTask("t1");
    expect(useAutomationRunsStore.getState().runs.map((run) => run.id)).toEqual(["b"]);
    expect(JSON.parse(mem.getItem(AUTOMATION_RUNS_KEY) as string)).toHaveLength(1);

    const before = useAutomationRunsStore.getState().runs;
    useAutomationRunsStore.getState().removeForTask("missing");
    expect(useAutomationRunsStore.getState().runs).toBe(before);
  });

  it("clearAll 清空并落盘", () => {
    useAutomationRunsStore.getState().recordRun(makeRun({ id: "a" }));
    useAutomationRunsStore.getState().clearAll();
    expect(useAutomationRunsStore.getState().runs).toEqual([]);
    expect(JSON.parse(mem.getItem(AUTOMATION_RUNS_KEY) as string)).toEqual([]);
  });
});
