import { describe, expect, it } from "vitest";
import {
  dailyNotePath,
  DEFAULT_DAILY_CONFIG,
  isValidDailyFormat,
  parseDailyPath,
  resolveDailyConfig,
} from "./daily.js";

/**
 * 日记路径：默认 `daily/YYYY-MM-DD.md`、自定义文件夹/格式、非法配置回退并报原因、反解日期。
 *
 * 日期用本地时间构造（`new Date(2026, 10, 8)`），与格式化的本地口径一致。
 */

const DAY = new Date(2026, 10, 8); // 本地 2026-11-08 00:00:00

function parts(date: Date): [number, number, number, number, number, number] {
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
}

describe("resolveDailyConfig", () => {
  it("缺省配置不回退", () => {
    const resolved = resolveDailyConfig();
    expect(resolved.fallback).toBe(false);
    expect(resolved.reason).toBe("");
    expect(resolved.config).toEqual(DEFAULT_DAILY_CONFIG);
  });

  it("显式空文件夹 = 库根（合法，不回退）", () => {
    const resolved = resolveDailyConfig({ folder: "" });
    expect(resolved.fallback).toBe(false);
    expect(resolved.config.folder).toBe("");
  });

  it("非法文件夹回退默认值并说明原因", () => {
    for (const folder of ["../escape", "/abs", ".hidden", "a\u0000b", "a:b"]) {
      const resolved = resolveDailyConfig({ folder });
      expect(resolved.fallback).toBe(true);
      expect(resolved.config.folder).toBe("daily");
      expect(resolved.reason).toContain("日记文件夹");
    }
    const notString = resolveDailyConfig({ folder: 42 as unknown as string });
    expect(notString.config.folder).toBe("daily");
    expect(notString.reason).toContain("不是字符串");
  });

  it("非法日期格式回退默认并说明原因（含路径分隔符、缺年月日）", () => {
    for (const format of ["YYYY/MM/DD", "MM-DD", "", "YYYY-MM", "dddd"]) {
      const resolved = resolveDailyConfig({ format });
      expect(resolved.fallback).toBe(true);
      expect(resolved.config.format).toBe("YYYY-MM-DD");
      expect(resolved.reason).toContain("日期格式不合法");
    }
  });

  it("合法自定义格式与模板路径保留", () => {
    const resolved = resolveDailyConfig({
      folder: "日记/工作",
      format: "YYYY年MM月DD日",
      templatePath: "templates/daily.md",
    });
    expect(resolved.fallback).toBe(false);
    expect(resolved.config).toEqual({
      folder: "日记/工作",
      format: "YYYY年MM月DD日",
      templatePath: "templates/daily.md",
    });
  });

  it("非法模板路径被忽略并说明原因", () => {
    const resolved = resolveDailyConfig({ templatePath: "../x.md" });
    expect(resolved.fallback).toBe(true);
    expect(resolved.config.templatePath).toBeUndefined();
    expect(resolved.reason).toContain("模板路径");
  });
});

describe("isValidDailyFormat", () => {
  it("接受只含 Y/M/D/H/m/s 与字面量的格式", () => {
    for (const format of ["YYYY-MM-DD", "YYYYMMDD", "DD.MM.YYYY", "YYYY年MM月DD日"]) {
      expect(isValidDailyFormat(format)).toBe(true);
    }
  });

  it("拒绝路径分隔符、缺年月日与非字符串", () => {
    for (const format of ["YYYY/MM/DD", "YYYY-MM", "x", 1, null]) {
      expect(isValidDailyFormat(format)).toBe(false);
    }
    // 带时间但不含日 → 不能反解日期
    expect(isValidDailyFormat("YYYY-MM HH:mm")).toBe(false);
  });
});

describe("dailyNotePath", () => {
  it("默认配置：daily/YYYY-MM-DD.md", () => {
    expect(dailyNotePath(undefined, DAY)).toBe("daily/2026-11-08.md");
    expect(dailyNotePath({}, DAY)).toBe("daily/2026-11-08.md");
  });

  it("自定义文件夹与格式", () => {
    expect(dailyNotePath({ folder: "日记/工作", format: "YYYY年MM月DD日" }, DAY)).toBe(
      "日记/工作/2026年11月08日.md",
    );
    expect(dailyNotePath({ folder: "", format: "YYYYMMDD" }, DAY)).toBe("20261108.md");
  });

  it("非法配置静默回退默认（原因用 resolveDailyConfig 取）", () => {
    expect(dailyNotePath({ folder: "../x", format: "YYYY/MM/DD" }, DAY)).toBe("daily/2026-11-08.md");
  });
});

describe("parseDailyPath", () => {
  it("默认配置反解日期", () => {
    const date = parseDailyPath(undefined, "daily/2026-11-08.md");
    expect(date).not.toBeNull();
    expect(parts(date!)).toEqual([2026, 11, 8, 0, 0, 0]);
  });

  it("自定义格式可往返（含时间）", () => {
    const config = { folder: "日记", format: "YYYY-MM-DD-HHmm" };
    const date = new Date(2026, 10, 8, 9, 5);
    const rel = dailyNotePath(config, date);
    expect(rel).toBe("日记/2026-11-08-0905.md");
    const parsed = parseDailyPath(config, rel);
    expect(parsed).not.toBeNull();
    expect(parts(parsed!)).toEqual([2026, 11, 8, 9, 5, 0]);
  });

  it("反解失败返回 null：目录不对 / 非 md / 格式不符 / 不存在的日期", () => {
    expect(parseDailyPath(undefined, "other/2026-11-08.md")).toBeNull();
    expect(parseDailyPath(undefined, "daily/2026-11-08")).toBeNull();
    expect(parseDailyPath(undefined, "daily/2026年11月08日.md")).toBeNull();
    expect(parseDailyPath(undefined, "daily/2026-02-31.md")).toBeNull();
    expect(parseDailyPath(undefined, "")).toBeNull();
  });

  it("库根文件夹也能反解", () => {
    const date = parseDailyPath({ folder: "" }, "2026-11-08.md");
    expect(date).not.toBeNull();
    expect(parts(date!)).toEqual([2026, 11, 8, 0, 0, 0]);
  });

  it("规范化反斜杠与前导 ./", () => {
    expect(parts(parseDailyPath(undefined, "./daily\\2026-11-08.md")!)).toEqual([
      2026, 11, 8, 0, 0, 0,
    ]);
  });
});
