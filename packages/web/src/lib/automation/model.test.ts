import { describe, expect, it } from "vitest";
import {
  ALL_WEEKDAYS,
  MAX_DETAIL_CHARS,
  describeAction,
  describeSchedule,
  describeSync,
  draftForKind,
  formatAutomationTime,
  nextRunAt,
  normalizeDraft,
  normalizeSync,
  normalizeTask,
  normalizeWeekdays,
  parseClock,
  validateDraft,
  type AutomationDraft,
} from "./model.js";

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const baseDraft: AutomationDraft = {
  name: "同步归档",
  kind: "infohub.sync",
  schedule: { type: "daily", time: "09:00", weekdays: [...ALL_WEEKDAYS] },
  sync: { sources: ["qq", "wechat"], full: false, archive: false },
};

describe("parseClock / normalizeWeekdays", () => {
  it("接受合法 HH:MM，拒绝越界与杂字符", () => {
    expect(parseClock("09:05")).toEqual({ hours: 9, minutes: 5 });
    expect(parseClock("9:05")).toEqual({ hours: 9, minutes: 5 });
    expect(parseClock("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("09:60")).toBeNull();
    expect(parseClock("9点")).toBeNull();
    expect(parseClock("")).toBeNull();
  });

  it("星期去重、剔除非法值、为空按每天", () => {
    expect(normalizeWeekdays([3, 1, 3, 8, -1, "x"])).toEqual([1, 3]);
    expect(normalizeWeekdays([])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeWeekdays(null)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("nextRunAt", () => {
  it("每天定时：当天未到取当天，已过取下一个匹配星期", () => {
    // 2026-11-02 是周一
    const monday = at(2026, 11, 2, 8, 30);
    expect(new Date(monday).getDay()).toBe(1);
    expect(nextRunAt({ type: "daily", time: "09:00", weekdays: [1] }, monday)).toBe(
      at(2026, 11, 2, 9, 0),
    );
    const after = at(2026, 11, 2, 9, 30);
    expect(nextRunAt({ type: "daily", time: "09:00", weekdays: [1] }, after)).toBe(
      at(2026, 11, 9, 9, 0),
    );
    expect(nextRunAt({ type: "daily", time: "09:00", weekdays: [3] }, monday)).toBe(
      at(2026, 11, 4, 9, 0),
    );
  });

  it("间隔：从起点加分钟，越界夹紧", () => {
    expect(nextRunAt({ type: "interval", minutes: 30 }, 1000)).toBe(1000 + 30 * 60_000);
    expect(nextRunAt({ type: "interval", minutes: 1 }, 0)).toBe(5 * 60_000);
    expect(nextRunAt({ type: "interval", minutes: 9999 }, 0)).toBe(1440 * 60_000);
  });
});

describe("validateDraft", () => {
  it("合法草稿通过", () => {
    expect(validateDraft(baseDraft)).toBe("");
  });

  it("名称、来源、时间、间隔分别校验", () => {
    expect(validateDraft({ ...baseDraft, name: "  " })).toContain("名称");
    expect(
      validateDraft({ ...baseDraft, sync: { ...baseDraft.sync, sources: [] } }),
    ).toContain("同步来源");
    expect(
      validateDraft({ ...baseDraft, schedule: { type: "daily", time: "25:00", weekdays: [1] } }),
    ).toContain("HH:MM");
    expect(
      validateDraft({ ...baseDraft, schedule: { type: "daily", time: "09:00", weekdays: [] } }),
    ).toContain("星期");
    expect(
      validateDraft({ ...baseDraft, schedule: { type: "interval", minutes: 3 } }),
    ).toContain("5–1440");
    expect(
      validateDraft({ ...baseDraft, schedule: { type: "interval", minutes: 30.5 } }),
    ).toContain("整数");
  });

  it("重扫日程不需要同步来源", () => {
    expect(
      validateDraft({
        ...baseDraft,
        kind: "infohub.agenda",
        sync: { ...baseDraft.sync, sources: [] },
      }),
    ).toBe("");
  });

  it("未知动作按「请选择动作」拒绝（白名单来自注册表）", () => {
    const unknownKind = "infohub.unknown" as unknown as AutomationDraft["kind"];
    expect(validateDraft({ ...baseDraft, kind: unknownKind })).toBe("请选择要执行的动作");
  });
});

describe("读盘与展示", () => {
  it("normalizeTask 丢弃未知结构，保留合法任务", () => {
    const now = at(2026, 11, 1, 12, 0);
    expect(normalizeTask({ id: "x" }, now)).toBeNull();
    expect(
      normalizeTask(
        {
          id: "a1",
          name: "同步",
          kind: "infohub.sync",
          schedule: { type: "interval", minutes: 1 },
          sync: { sources: ["qq"] },
        },
        now,
      ),
    ).toBeNull();
    const task = normalizeTask(
      {
        id: "a2",
        name: "同步",
        kind: "infohub.sync",
        schedule: { type: "daily", time: "09:00", weekdays: [1, 3, 3] },
        sync: { sources: ["qq"], full: true, archive: true },
        createdAt: now,
        runCount: 2,
        lastDetail: "很长的详情".repeat(80),
      },
      now,
    );
    expect(task).not.toBeNull();
    expect(task!.schedule).toEqual({ type: "daily", time: "09:00", weekdays: [1, 3] });
    expect(task!.sync).toEqual({ sources: ["qq"], full: true, archive: true });
    expect(task!.nextRunAt).toBe(nextRunAt(task!.schedule, now));
    expect([...(task!.lastDetail ?? "")].length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
  });

  it("normalizeSync：显式空来源保留为空，缺省按双来源", () => {
    expect(normalizeSync(undefined).sources).toEqual(["qq", "wechat"]);
    expect(normalizeSync({ sources: [] }).sources).toEqual([]);
    expect(normalizeSync({ sources: ["wechat", "wechat", "x"] }).sources).toEqual(["wechat"]);
  });

  it("展示文案", () => {
    expect(describeSchedule({ type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      "每天 09:00",
    );
    expect(describeSchedule({ type: "daily", time: "18:30", weekdays: [1, 3] })).toBe(
      "每周一、三 18:30",
    );
    expect(describeSchedule({ type: "interval", minutes: 30 })).toBe("每 30 分钟");
    expect(describeSync({ sources: ["qq", "wechat"], full: true, archive: false })).toBe(
      "QQ、微信 · 全量重扫",
    );
    expect(
      describeAction({
        kind: "infohub.sync",
        sync: { sources: ["qq"], full: false, archive: false },
      }),
    ).toContain("同步归档");
    expect(formatAutomationTime(0)).toBe("—");
  });

  it("normalizeDraft 夹紧间隔并按动作生成默认草稿", () => {
    expect(
      normalizeDraft({
        ...baseDraft,
        schedule: { type: "interval", minutes: 1 },
      }).schedule,
    ).toEqual({ type: "interval", minutes: 5 });
    expect(draftForKind("infohub.agenda").name).toBe("重扫日程");
    expect(
      draftForKind("infohub.sync", { sources: ["qq"], full: true, archive: false }).sync,
    ).toEqual({ sources: ["qq"], full: true, archive: false });
  });

  it("未知 kind：草稿落默认动作，读盘条目照旧丢弃", () => {
    const unknownKind = "infohub.unknown" as unknown as AutomationDraft["kind"];
    expect(normalizeDraft({ ...baseDraft, kind: unknownKind }).kind).toBe("infohub.sync");
    expect(
      normalizeTask({
        id: "a9",
        name: "未知动作",
        kind: "infohub.unknown",
        schedule: { type: "interval", minutes: 30 },
        sync: { sources: ["qq"] },
      }),
    ).toBeNull();
  });

  it("动作描述与注册表元数据对齐", () => {
    expect(
      describeAction({ kind: "infohub.sync", sync: { sources: ["qq"], full: true, archive: false } }),
    ).toBe("同步归档（QQ · 全量重扫）");
    // 与任务卡现有说明逐字一致：页面可直接改用 describeAction 而不动文案。
    expect(
      describeAction({ kind: "infohub.agenda", sync: { sources: [], full: false, archive: false } }),
    ).toBe("重扫本机归档的日程表");
  });
});
