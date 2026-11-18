import { describe, expect, it } from "vitest";
import {
  drawableRows,
  historySpan,
  lineFirstAt,
  lineLatestLeft,
  lineLastAt,
  lineResetsAt,
  paceText,
  parseQuotaHistory,
  quotaPace,
  resetAt,
  sparkPath,
  trendHeadline,
  type QuotaHistoryRow,
  type QuotaLine,
} from "./quotaHistory.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (offsetHours: number): string => new Date(NOW - offsetHours * HOUR).toISOString();

/** 一条从 100 匀速掉到 `left`、共 `hours` 小时的线。 */
function falling(left: number, hours: number): QuotaLine {
  const points = [];
  for (let hour = hours; hour >= 0; hour -= 1) {
    points.push({ at: iso(hour), left: 100 - ((100 - left) * (hours - hour)) / hours });
  }
  return { name: "5 hours", points };
}

describe("parseQuotaHistory", () => {
  it("读内核的形状：账号 → 窗口 → 点", () => {
    const rows = parseQuotaHistory(
      JSON.stringify([
        {
          provider: "claude",
          user: "work@example.com",
          lines: [
            {
              name: "5 hours",
              points: [
                { at: "2026-11-18T10:00:00Z", left: 100 },
                { at: "2026-11-18T11:00:00Z", left: 42, resetsAt: "2026-11-18T15:00:00Z" },
              ],
            },
          ],
        },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "claude", user: "work@example.com" });
    expect(rows[0]?.lines[0]?.points).toHaveLength(2);
    expect(rows[0]?.lines[0]?.points[1]).toEqual({
      at: "2026-11-18T11:00:00Z",
      left: 42,
      resetsAt: "2026-11-18T15:00:00Z",
    });
  });

  it("坏 JSON、非数组、缺 provider、缺点的行都丢掉", () => {
    expect(parseQuotaHistory("不再是我认识的 JSON")).toEqual([]);
    expect(parseQuotaHistory('{"provider":"claude"}')).toEqual([]);
    expect(parseQuotaHistory(JSON.stringify([{ lines: [{ name: "week", points: [{ at: iso(1), left: 10 }] }] }]))).toEqual([]);
    expect(
      parseQuotaHistory(
        JSON.stringify([{ provider: "claude", lines: [{ name: "", points: [{ at: iso(1), left: 10 }] }, { name: "week", points: [] }] }]),
      ),
    ).toEqual([]);
  });

  it("只有一个点的行解析得出来，但画不成线（drawableRows 滤掉它）", () => {
    const rows = parseQuotaHistory(
      JSON.stringify([
        { provider: "claude", lines: [{ name: "5 hours", points: [{ at: iso(2), left: 80 }] }] },
        {
          provider: "codex",
          lines: [
            { name: "week", points: [{ at: iso(2), left: 80 }, { at: iso(1), left: 60 }] },
          ],
        },
      ]),
    );
    expect(rows.map((row) => row.provider)).toEqual(["claude", "codex"]);
    expect(drawableRows(rows).map((row) => row.provider)).toEqual(["codex"]);
  });
});

describe("sparkPath", () => {
  it("从左到右铺满画布，剩余 100% 在顶、0% 在底", () => {
    const path = sparkPath(
      [
        { at: "2026-11-18T10:00:00Z", left: 100 },
        { at: "2026-11-18T12:00:00Z", left: 0 },
      ],
      100,
      24,
    );
    expect(path).toBe("M0.0 0.0 L100.0 24.0");
  });

  it("越界的百分比被夹在 0..100 之间", () => {
    const path = sparkPath(
      [
        { at: "2026-11-18T10:00:00Z", left: 140 },
        { at: "2026-11-18T12:00:00Z", left: -5 },
      ],
      100,
      24,
    );
    expect(path).toBe("M0.0 0.0 L100.0 24.0");
  });

  it("一个点或坏时间不给路径（不画半条线）", () => {
    expect(sparkPath([{ at: "2026-11-18T10:00:00Z", left: 50 }], 100, 24)).toBe("");
    expect(sparkPath([{ at: "坏时间", left: 50 }, { at: "也坏", left: 40 }], 100, 24)).toBe("");
  });

  it("给了重置时刻就把 x 轴延到那一刻：线停在左边，右边那段留给「到重置」", () => {
    const points = [
      { at: "2026-11-18T10:00:00Z", left: 100 },
      { at: "2026-11-18T11:00:00Z", left: 50 },
    ];
    const until = Date.parse("2026-11-18T13:00:00Z");
    // 读数跨 1 小时，重置在 3 小时后：第二个点落在 1/3 处，不再贴右边。
    expect(sparkPath(points, 100, 24, until)).toBe("M0.0 0.0 L33.3 12.0");
    // 重置已经过去（早于最后一个点）时不多留那一段。
    expect(sparkPath(points, 100, 24, Date.parse("2026-11-18T10:30:00Z"))).toBe(
      "M0.0 0.0 L100.0 12.0",
    );
    // 不给就是原来的铺满。
    expect(sparkPath(points, 100, 24, null)).toBe("M0.0 0.0 L100.0 12.0");
  });

  it("resetAt / lineLastAt：读得出毫秒，读不出就是 null", () => {
    const line: QuotaLine = {
      name: "5 hours",
      points: [
        { at: "2026-11-18T10:00:00Z", left: 100, resetsAt: "2026-11-18T16:00:00Z" },
        { at: "2026-11-18T11:00:00Z", left: 80 },
      ],
    };
    // 取最后一条带 resetsAt 的读数（内核只在知道时才写）。
    expect(resetAt(line)).toBe(Date.parse("2026-11-18T16:00:00Z"));
    expect(lineLastAt(line)).toBe(Date.parse("2026-11-18T11:00:00Z"));
    expect(resetAt({ name: "week", points: [{ at: "2026-11-18T10:00:00Z", left: 5 }] })).toBeNull();
    expect(lineLastAt({ name: "week", points: [{ at: "坏时间", left: 5 }] })).toBeNull();
  });
});

describe("quotaPace", () => {
  it("匀速往下掉：算出多久后用完", () => {
    const pace = quotaPace(falling(50, 5), NOW);
    expect(pace?.kind).toBe("runs-out");
    if (pace?.kind === "runs-out") {
      // 5 小时用掉 50%，剩下的 50% 还要 5 小时
      expect(pace.at - NOW).toBeGreaterThan(4.5 * HOUR);
      expect(pace.at - NOW).toBeLessThan(5.5 * HOUR);
    }
  });

  it("算出来的时间早于重置：说「用完」", () => {
    const pace = quotaPace(falling(50, 5), NOW, new Date(NOW + 10 * HOUR).toISOString());
    expect(pace?.kind).toBe("runs-out");
  });

  it("撑得过重置：说「撑得过」并带上重置时间", () => {
    const resetsAt = new Date(NOW + 2 * HOUR).toISOString();
    const pace = quotaPace(falling(50, 5), NOW, resetsAt);
    expect(pace).toEqual({ kind: "lasts", resetsAt: Date.parse(resetsAt) });
  });

  it("点太少、跨度太短、没在掉都说不准", () => {
    expect(quotaPace({ name: "week", points: [{ at: iso(2), left: 80 }, { at: iso(1), left: 60 }] }, NOW)).toBeNull();
    const brief = {
      name: "5 hours",
      points: [
        { at: iso(0.5), left: 80 },
        { at: iso(0.4), left: 70 },
        { at: iso(0), left: 60 },
      ],
    };
    expect(quotaPace(brief, NOW)).toBeNull();
    const flat = {
      name: "week",
      points: [
        { at: iso(6), left: 60 },
        { at: iso(4), left: 60 },
        { at: iso(2), left: 60 },
      ],
    };
    expect(quotaPace(flat, NOW)).toBeNull();
  });

  it("回升之前的老读数不算进来：只拟合最近这一轮，不会被上一轮的陡降骗到", () => {
    const points = [
      // 上一轮：从 100 掉到 5（很陡，按它会算成几小时后用完）
      { at: iso(20), left: 100 },
      { at: iso(18), left: 40 },
      { at: iso(16), left: 5 },
      // 重置回升，这一轮几乎没掉（4 小时掉 2%）
      { at: iso(4), left: 100 },
      { at: iso(2), left: 99 },
      { at: iso(0), left: 98 },
    ];
    const pace = quotaPace({ name: "week", points }, NOW);
    expect(pace?.kind).toBe("runs-out");
    if (pace?.kind === "runs-out") {
      // 按上一轮的斜率会是几小时；按这一轮是 8 天以上
      expect(pace.at - NOW).toBeGreaterThan(7 * 24 * HOUR);
    }
  });

  it("已经空了就不预测", () => {
    const points = [
      { at: iso(4), left: 40 },
      { at: iso(2), left: 10 },
      { at: iso(0), left: 0 },
    ];
    expect(quotaPace({ name: "5 hours", points }, NOW)).toBeNull();
  });
});

describe("paceText", () => {
  it("分钟、小时、天三种说法", () => {
    expect(paceText({ kind: "runs-out", at: NOW + 20 * 60 * 1000 }, NOW)).toBe("照这个速度，20 分钟后用完");
    expect(paceText({ kind: "runs-out", at: NOW + 3 * HOUR + 12 * 60 * 1000 }, NOW)).toBe("照这个速度，3 小时 12 分后用完");
    expect(paceText({ kind: "runs-out", at: NOW + 49 * HOUR }, NOW)).toBe("照这个速度，2 天 1 小时后用完");
  });

  it("撑得过重置、以及说不准时的空串", () => {
    expect(paceText({ kind: "lasts", resetsAt: NOW + HOUR }, NOW)).toBe("照这个速度，撑得过这次重置");
    expect(paceText(null, NOW)).toBe("");
  });
});

describe("historySpan / 最后一次读数", () => {
  it("给出整段读数的时间范围", () => {
    const rows = parseQuotaHistory(
      JSON.stringify([
        { provider: "claude", lines: [{ name: "week", points: [{ at: "2026-11-17T12:00:00Z", left: 90 }, { at: "2026-11-18T12:00:00Z", left: 30 }] }] },
      ]),
    );
    expect(historySpan(rows)).toEqual({ from: Date.parse("2026-11-17T12:00:00Z"), to: NOW });
    expect(historySpan([])).toBeNull();
  });

  it("取最后一点与最后一次记下的重置时间", () => {
    const line: QuotaLine = {
      name: "week",
      points: [
        { at: iso(3), left: 80 },
        { at: iso(2), left: 70, resetsAt: "2026-11-20T00:00:00Z" },
        { at: iso(1), left: 65 },
      ],
    };
    expect(lineLatestLeft(line)).toBe(65);
    expect(lineResetsAt(line)).toBe("2026-11-20T00:00:00Z");
    expect(lineLatestLeft({ name: "week", points: [] })).toBeNull();
  });

  it("给出第一份读数的时刻：横轴左端从哪儿开始", () => {
    const line: QuotaLine = {
      name: "week",
      points: [
        { at: iso(3), left: 80 },
        { at: iso(1), left: 60 },
      ],
    };
    expect(lineFirstAt(line)).toBe(NOW - 3 * HOUR);
    expect(lineFirstAt({ name: "week", points: [] })).toBeNull();
    expect(lineFirstAt({ name: "week", points: [{ at: "不是时间", left: 50 }] })).toBeNull();
  });
});

describe("trendHeadline", () => {
  it("只报最急的那一份，并说清还有几份也在往下掉", () => {
    const rows: QuotaHistoryRow[] = [
      // 8 小时掉 70%：从 30% 起还能撑 3 个多小时
      { provider: "claude", user: "a@example.com", lines: [falling(30, 8)] },
      // 6 小时掉 90%：从 10% 起不到一小时
      { provider: "codex", lines: [falling(10, 6)] },
    ];
    const head = trendHeadline(rows, NOW);
    expect(head.text).toContain("ChatGPT（5 小时）");
    expect(head.text).toContain("后用完");
    expect(head.text).toContain("另有 1 份也在往下掉");
    expect(head.tone).toBe("danger");
  });

  it("两小时内用完算危险，一天内算偏紧，更久的不喊", () => {
    expect(trendHeadline([{ provider: "codex", lines: [falling(10, 6)] }], NOW).tone).toBe(
      "danger",
    );
    expect(trendHeadline([{ provider: "codex", lines: [falling(30, 8)] }], NOW).tone).toBe("warn");
    expect(trendHeadline([{ provider: "codex", lines: [falling(95, 10)] }], NOW).tone).toBe(
      "muted",
    );
  });

  it("都撑得过这次重置时，报数而不是挨个说", () => {
    const row: QuotaHistoryRow = {
      provider: "claude",
      lines: [
        {
          name: "5 hours",
          points: falling(90, 4).points.map((point, index, all) =>
            index === all.length - 1
              ? { ...point, resetsAt: new Date(NOW + HOUR).toISOString() }
              : point,
          ),
        },
      ],
    };
    const head = trendHeadline([row], NOW);
    expect(head.text).toBe("照这个速度，这 1 份额度都撑得过这次重置");
    expect(head.tone).toBe("muted");
  });

  it("点太少、说不出所以然时给空串，让调用方自己兜一句", () => {
    const rows: QuotaHistoryRow[] = [
      { provider: "claude", lines: [{ name: "week", points: [{ at: iso(0), left: 40 }] }] },
    ];
    expect(trendHeadline(rows, NOW)).toEqual({ text: "", tone: "muted" });
    expect(trendHeadline([], NOW)).toEqual({ text: "", tone: "muted" });
  });
});
