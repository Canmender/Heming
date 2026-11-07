import { describe, expect, it } from "vitest";
import { scheduleTrigger } from "./scheduleTrigger.js";
import { createFakeContext } from "./fakeContext.js";

/**
 * 定时触发的 getNextRun 是调度器唯一依赖的纯函数：
 * 这里按「间隔 / 每天 / 每周 / Cron」逐类钉住语义，以及非法参数返回 null 的约定。
 * 全部日期用本地时间构造（模块只支持 local 时区）。
 */

function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

function iso(date: Date | null): string {
  return date ? date.toISOString() : "null";
}

function next(parameters: Record<string, unknown>, from: Date): Date | null {
  const getNextRun = scheduleTrigger.getNextRun;
  if (!getNextRun) throw new Error("scheduleTrigger 必须实现 getNextRun");
  return getNextRun(parameters, from);
}

describe("定时触发 · 间隔", () => {
  it("秒：按数量推进", () => {
    expect(iso(next({ triggerInterval: "seconds", intervalCount: 5 }, at(2026, 11, 7, 10, 0)))).toBe(
      iso(at(2026, 11, 7, 10, 0, 5)),
    );
  });

  it("分钟与小时：按绝对毫秒推进", () => {
    expect(iso(next({ triggerInterval: "minutes", intervalCount: 90 }, at(2026, 11, 7, 10, 0)))).toBe(
      iso(at(2026, 11, 7, 11, 30)),
    );
    expect(iso(next({ triggerInterval: "hours", intervalCount: 2 }, at(2026, 11, 7, 10, 0)))).toBe(
      iso(at(2026, 11, 7, 12, 0)),
    );
  });

  it("间隔数量非法时返回 null（0、负数、NaN）", () => {
    for (const intervalCount of [0, -1, Number.NaN]) {
      expect(next({ triggerInterval: "hours", intervalCount }, at(2026, 11, 7, 10, 0))).toBeNull();
    }
  });
});

describe("定时触发 · 每天", () => {
  it("今天目标时刻还没到就是今天", () => {
    expect(
      iso(
        next(
          { triggerInterval: "days", intervalCount: 1, triggerAtHour: 9, triggerAtMinute: 0 },
          at(2026, 11, 7, 8, 0),
        ),
      ),
    ).toBe(iso(at(2026, 11, 7, 9, 0)));
  });

  it("今天目标时刻已过就顺延 N 天", () => {
    expect(
      iso(
        next(
          { triggerInterval: "days", intervalCount: 1, triggerAtHour: 9, triggerAtMinute: 0 },
          at(2026, 11, 7, 20, 31),
        ),
      ),
    ).toBe(iso(at(2026, 11, 8, 9, 0)));
    expect(
      iso(
        next(
          { triggerInterval: "days", intervalCount: 3, triggerAtHour: 9, triggerAtMinute: 0 },
          at(2026, 11, 7, 20, 31),
        ),
      ),
    ).toBe(iso(at(2026, 11, 10, 9, 0)));
  });

  it("小时/分钟越界时返回 null", () => {
    expect(
      next({ triggerInterval: "days", triggerAtHour: 24, triggerAtMinute: 0 }, at(2026, 11, 7, 0, 0)),
    ).toBeNull();
    expect(
      next({ triggerInterval: "days", triggerAtHour: 9, triggerAtMinute: 60 }, at(2026, 11, 7, 0, 0)),
    ).toBeNull();
  });
});

describe("定时触发 · 每周", () => {
  it("从周六看，下一次是下周一的目标时刻", () => {
    expect(
      iso(
        next(
          {
            triggerInterval: "weeks",
            intervalCount: 1,
            triggerAtHour: 9,
            triggerAtMinute: 30,
            triggerAtDayOfWeek: 1,
          },
          at(2026, 11, 7, 20, 31),
        ),
      ),
    ).toBe(iso(at(2026, 11, 9, 9, 30)));
  });

  it("正好落在触发时刻时推进一个周期（固定点友好）", () => {
    expect(
      iso(
        next(
          { triggerInterval: "weeks", intervalCount: 1, triggerAtHour: 9, triggerAtMinute: 0, triggerAtDayOfWeek: 1 },
          at(2026, 11, 9, 9, 0),
        ),
      ),
    ).toBe(iso(at(2026, 11, 16, 9, 0)));
  });

  it("每 N 周：从触发时刻推进 N 周", () => {
    expect(
      iso(
        next(
          { triggerInterval: "weeks", intervalCount: 2, triggerAtHour: 9, triggerAtMinute: 0, triggerAtDayOfWeek: 1 },
          at(2026, 11, 9, 9, 0),
        ),
      ),
    ).toBe(iso(at(2026, 11, 23, 9, 0)));
  });

  it("星期越界返回 null", () => {
    expect(
      next(
        { triggerInterval: "weeks", triggerAtDayOfWeek: 8, triggerAtHour: 9, triggerAtMinute: 0 },
        at(2026, 11, 7, 0, 0),
      ),
    ).toBeNull();
  });
});

describe("定时触发 · Cron", () => {
  it("合法表达式按本地时间推进", () => {
    expect(
      iso(next({ triggerInterval: "cron", cronExpression: "0 9 * * *" }, at(2026, 11, 7, 20, 31))),
    ).toBe(iso(at(2026, 11, 8, 9, 0)));
  });

  it("非法表达式返回 null", () => {
    expect(next({ triggerInterval: "cron", cronExpression: "bad cron" }, at(2026, 11, 7, 0, 0))).toBeNull();
    expect(next({ triggerInterval: "cron" }, at(2026, 11, 7, 0, 0))).toBeNull();
  });
});

describe("定时触发 · 执行与描述", () => {
  it("execute 输出一条带时间戳的空 item", async () => {
    const output = await scheduleTrigger.execute(createFakeContext());
    const main = (output as { main: Array<Array<{ json: Record<string, unknown> }>> }).main;
    expect(main[0]).toHaveLength(1);
    expect(typeof main[0]?.[0]?.json.timestamp).toBe("number");
  });

  it("描述信息完整：中文名/说明/触发标记", () => {
    const { description } = scheduleTrigger;
    expect(description.type).toBe("scheduleTrigger");
    expect(description.displayName).toBe("定时触发");
    expect(description.trigger).toBe("schedule");
    expect(description.isTrigger).toBe(true);
    expect(description.properties.some((property) => property.name === "triggerInterval")).toBe(true);
    expect(description.properties.some((property) => property.name === "cronExpression")).toBe(true);
  });
});
