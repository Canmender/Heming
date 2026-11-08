import { describe, expect, it } from "vitest";
import {
  LEGACY_ENGINES,
  compareHemingVersion,
  enginesStatus,
  enginesStatusText,
  hemingVersionSegmentCount,
  normalizeEnginesHemmin,
  parseHemingVersion,
  satisfiesEngines,
} from "./version.js";

describe("parseHemingVersion", () => {
  it("接受 3–5 段与预发后缀", () => {
    expect(parseHemingVersion("d.103")).toMatchObject({ channel: "d", feature: 103, breaking: 0, revision: 0, build: 0 });
    expect(parseHemingVersion("d.103.2")).toMatchObject({ feature: 103, breaking: 2 });
    expect(parseHemingVersion("d.103.2.42.0")).toMatchObject({ feature: 103, breaking: 2, revision: 42, build: 0 });
    expect(parseHemingVersion("d.103.2.42.0-dev.3")).toMatchObject({ build: 0 });
    expect(parseHemingVersion("  D.104.0.0.0  ")?.channel).toBe("d");
  });

  it("拒绝非法值", () => {
    for (const bad of ["", "103", "d", "d.abc", "1.2.3", "d.1.2.3.4.5", "d.99999999", "x.1"]) {
      expect(parseHemingVersion(bad)).toBeNull();
    }
    expect(parseHemingVersion(undefined)).toBeNull();
    expect(parseHemingVersion(103)).toBeNull();
  });

  it("段数计数（UI 判断 3 段/5 段写法）", () => {
    expect(hemingVersionSegmentCount("d.103")).toBe(2);
    expect(hemingVersionSegmentCount("d.103.2.42.0")).toBe(5);
  });
});

describe("compareHemingVersion", () => {
  it("按段数值比较，缺段补 0", () => {
    expect(compareHemingVersion("d.103", "d.103.0.0.0")).toBe(0);
    expect(compareHemingVersion("d.103", "d.104")).toBeLessThan(0);
    expect(compareHemingVersion("d.104.0.0.0", "d.103.9.9.9")).toBeGreaterThan(0);
    expect(compareHemingVersion("d.103.2.42.0", "d.103.2.42.1")).toBeLessThan(0);
  });

  it("忽略预发后缀", () => {
    expect(compareHemingVersion("d.103.2.42.0-dev.9", "d.103.2.42.0")).toBe(0);
  });

  it("非法版本视为最小（失败关闭）", () => {
    expect(compareHemingVersion("nope", "d.103")).toBeLessThan(0);
    expect(compareHemingVersion("d.103", "nope")).toBeGreaterThan(0);
    expect(compareHemingVersion("nope", "bad")).toBe(0);
  });
});

describe("satisfiesEngines", () => {
  it("最小版本语义", () => {
    expect(satisfiesEngines("d.103", "d.103.2.42.0")).toBe(true);
    expect(satisfiesEngines("d.104", "d.103.2.42.0")).toBe(false);
    expect(satisfiesEngines(undefined, "d.103")).toBe(true);
    expect(satisfiesEngines("", "d.103")).toBe(true);
    expect(satisfiesEngines(LEGACY_ENGINES, "d.1.0.0.0")).toBe(true);
  });

  it("非法 required / actual 都不满足（不假装兼容）", () => {
    expect(satisfiesEngines("d.abc", "d.103.2.42.0")).toBe(false);
    expect(satisfiesEngines("d.103", "what")).toBe(false);
  });
});

describe("enginesStatus", () => {
  it("三态与文案", () => {
    expect(enginesStatus(undefined, "d.103").status).toBe("compatible");
    const newer = enginesStatus("d.105", "d.103.2.42.0");
    expect(newer.status).toBe("needsNewerApp");
    expect(enginesStatusText(newer)).toContain("需要和鸣 d.105");
    const invalid = enginesStatus("v1", "d.103");
    expect(invalid.status).toBe("invalidEngines");
    expect(enginesStatusText(invalid)).toContain("不合法");
  });
});

describe("normalizeEnginesHemmin", () => {
  it("接受对象/裸字符串，区分未声明与非法", () => {
    expect(normalizeEnginesHemmin({ heming: "d.103" })).toBe("d.103");
    expect(normalizeEnginesHemmin("d.103.2")).toBe("d.103.2");
    expect(normalizeEnginesHemmin(undefined)).toBeUndefined();
    expect(normalizeEnginesHemmin({})).toBeUndefined();
    expect(normalizeEnginesHemmin({ heming: "x" })).toBeNull();
    expect(normalizeEnginesHemmin({ heming: 3 })).toBeNull();
    expect(normalizeEnginesHemmin(7)).toBeNull();
  });
});
