import { describe, expect, it } from "vitest";

import {
  SOURCE_TUNE_FIELDS,
  sourceTuneCommand,
  sourceTuneCommands,
  sourceTuneRejected,
} from "./magpieSourceTune";

describe("来源调流", () => {
  it("五项都在，且键不重复", () => {
    const keys = SOURCE_TUNE_FIELDS.map((field) => field.key);
    expect(keys).toEqual(["atOnce", "rpm", "queue", "quotaRest", "restCap"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("同时用几个账号：数值发给 at-once，不限发 off", () => {
    expect(sourceTuneCommand("p", "atOnce", "3")).toEqual(["provider", "at-once", "p", "3"]);
    expect(sourceTuneCommand("p", "atOnce", "off")).toEqual(["provider", "at-once", "p", "off"]);
    expect(sourceTuneCommand("p", "atOnce", "三个")).toBeNull();
  });

  it("每分钟请求：整数发给 rpm，off 也认，留空不发", () => {
    expect(sourceTuneCommand("p", "rpm", "20")).toEqual(["provider", "rpm", "p", "20"]);
    expect(sourceTuneCommand("p", "rpm", "off")).toEqual(["provider", "rpm", "p", "off"]);
    expect(sourceTuneCommand("p", "rpm", "")).toBeNull();
    expect(sourceTuneCommand("p", "rpm", "二十")).toBeNull();
  });

  it("排队：只写长度就只发长度，写了 20:30 才带等待秒数", () => {
    expect(sourceTuneCommand("p", "queue", "20")).toEqual(["provider", "queue", "p", "20"]);
    expect(sourceTuneCommand("p", "queue", "20:30")).toEqual([
      "provider",
      "queue",
      "p",
      "20",
      "30",
    ]);
    expect(sourceTuneCommand("p", "queue", "20:")).toBeNull();
    expect(sourceTuneCommand("p", "queue", "a:b")).toBeNull();
  });

  it("休息时长与失败上限照写", () => {
    expect(sourceTuneCommand("p", "quotaRest", "6h")).toEqual([
      "provider",
      "quota-rest",
      "p",
      "6h",
    ]);
    expect(sourceTuneCommand("p", "restCap", "off")).toEqual(["provider", "rest-cap", "p", "off"]);
  });

  it("没有来源 ID 就一条都不发", () => {
    expect(sourceTuneCommands("  ", { atOnce: "3", rpm: "20" })).toEqual([]);
    expect(sourceTuneCommand("  ", "rpm", "20")).toBeNull();
  });

  it("只发改过的那几项，顺序固定", () => {
    expect(sourceTuneCommands("p", { rpm: "20", quotaRest: "6h" })).toEqual([
      ["provider", "rpm", "p", "20"],
      ["provider", "quota-rest", "p", "6h"],
    ]);
    expect(sourceTuneCommands("p", {})).toEqual([]);
    expect(sourceTuneCommands("p", { atOnce: "  ", rpm: "" })).toEqual([]);
  });

  it("填了但看不懂的项点名报出来，留空的不算", () => {
    expect(sourceTuneRejected({ rpm: "二十", queue: "20:30", atOnce: "" })).toEqual(["每分钟请求"]);
    expect(sourceTuneRejected({})).toEqual([]);
  });
});
