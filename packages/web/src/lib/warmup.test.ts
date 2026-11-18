import { describe, expect, it } from "vitest";
import {
  WARMUP_VENDORS,
  normaliseTime,
  parseTimeList,
  warmupArgs,
  warmupLevel,
  warmupSummary,
  warmupTimes,
  warmupTimesArgs,
  warmupTimesText,
} from "./warmup.js";

const table = (rows: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(rows));

describe("warmupLevel", () => {
  it("只认内核那两个字面值，其余都当不预热", () => {
    expect(warmupLevel(table({ codexWarmup: "week" }), "codexWarmup")).toBe("week");
    expect(warmupLevel(table({ codexWarmup: "all" }), "codexWarmup")).toBe("all");
    for (const value of ["", "off", "on", true, null, undefined, 1]) {
      expect(warmupLevel(table({ codexWarmup: value }), "codexWarmup")).toBe("off");
    }
    expect(warmupLevel(table({}), "codexWarmup")).toBe("off");
  });

  it("两家厂商的设置键与内核一致", () => {
    expect(WARMUP_VENDORS.map((item) => [item.name, item.levelKey, item.timesKey])).toEqual([
      ["ChatGPT", "codexWarmup", "codexWarmAts"],
      ["Claude", "claudeWarmup", "claudeWarmAts"],
    ]);
  });
});

describe("warmupArgs", () => {
  it("开预热用 set，关预热用 reset（空串会被内核当成没给值）", () => {
    expect(warmupArgs("codexWarmup", "week")).toEqual(["settings", "set", "codexWarmup", "week"]);
    expect(warmupArgs("claudeWarmup", "all")).toEqual(["settings", "set", "claudeWarmup", "all"]);
    expect(warmupArgs("codexWarmup", "off")).toEqual(["settings", "reset", "codexWarmup"]);
  });
});

describe("parseTimeList", () => {
  it("逗号、顿号、空格都能分开，去重并按时间排好", () => {
    expect(parseTimeList("15:05, 09:00 、09:00")).toEqual(["09:00", "15:05"]);
    expect(parseTimeList("6:00 21:30")).toEqual(["06:00", "21:30"]);
  });

  it("认不出的丢掉，空的返回空", () => {
    expect(parseTimeList("")).toEqual([]);
    expect(parseTimeList("25:00 12:70 中午 07:15")).toEqual(["07:15"]);
  });

  it("补零到两位，方便直接写进内核的列表", () => {
    expect(normaliseTime("9:05")).toBe("09:05");
    expect(normaliseTime("0950")).toBe("09:50");
    expect(normaliseTime("24:00")).toBe("");
    expect(normaliseTime("9")).toBe("");
  });
});

describe("warmupTimes", () => {
  it("列表与只有一条的老写法都认", () => {
    expect(warmupTimes(table({ codexWarmAts: ["15:05", "09:00"] }), "codexWarmAts")).toEqual(["09:00", "15:05"]);
    expect(warmupTimes(table({ codexWarmAts: "07:30" }), "codexWarmAts")).toEqual(["07:30"]);
    expect(warmupTimes(table({ codexWarmAts: null }), "codexWarmAts")).toEqual([]);
    expect(warmupTimes(table({}), "codexWarmAts")).toEqual([]);
  });
});

describe("warmupTimesArgs", () => {
  it("有几个就一起写进去，一个都没有就重置", () => {
    expect(warmupTimesArgs("codexWarmAts", ["09:00", "15:05"])).toEqual([
      "settings",
      "set",
      "codexWarmAts",
      "09:00,15:05",
    ]);
    expect(warmupTimesArgs("claudeWarmAts", [])).toEqual(["settings", "reset", "claudeWarmAts"]);
  });
});

describe("warmupTimesText", () => {
  it("说清是每天几点，没设就说没设", () => {
    expect(warmupTimesText(["06:00", "15:05"])).toBe("每天 06:00、15:05 各开一次");
    expect(warmupTimesText([])).toBe("还没设固定时间");
  });
});

describe("warmupSummary", () => {
  it("两家都没开时明说现在不预热", () => {
    expect(warmupSummary(table({}))).toMatch(/两家都还没预热/);
  });

  it("开了谁、开到哪一档、有没有固定时间，都写进去", () => {
    expect(
      warmupSummary(
        table({
          codexWarmup: "all",
          codexWarmAts: ["06:00", "15:05"],
          claudeWarmup: "week",
        }),
      ),
    ).toBe("ChatGPT：每周与 5 小时窗口，每天 06:00、15:05 开一次；Claude：每周窗口");
  });
});
