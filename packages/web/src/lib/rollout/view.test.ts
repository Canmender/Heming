import { describe, expect, it } from "vitest";
import {
  ROLLOUT_FILTERS,
  ROLLOUT_EXPORT_VERSION,
  buildRolloutExport,
  counterpartIndex,
  filterRolloutItems,
  relativeLabel,
  relativeOffsetMs,
  rolloutExportFileName,
} from "./view.js";
import { pairToolCalls, turnCompletion } from "./pair.js";
import type { RolloutItem } from "./types.js";

/**
 * 回放展示的纯逻辑：相对时间、类型筛选、悬停配对、单回合导出。
 * 这些判定必须可单测——组件只负责画，出错了要能一眼定位到函数。
 */

const start = "2026-11-02T09:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(start) + offsetMs).toISOString();

const items: RolloutItem[] = [
  { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "查" },
  { type: "tool_call", seq: 1, at: at(100), streamId: "s1", id: "t1", name: "srv__read", args: "{}" },
  { type: "tool_result", seq: 2, at: at(3200), streamId: "s1", id: "t1", name: "srv__read", ok: true, text: "内容" },
  { type: "tool_call", seq: 3, at: at(4000), streamId: "s1", id: "t2", name: "srv__write", args: "{}" },
  { type: "tool_result", seq: 4, at: at(4200), streamId: "s1", id: "t2", name: "srv__write", ok: false, denied: true, text: "未执行" },
  { type: "assistant_final", seq: 5, at: at(5000), streamId: "s1", text: "完成" },
  { type: "turn_end", seq: 6, at: at(6000), streamId: "s1", status: "ok" },
];

describe("相对时间", () => {
  it("距开始 +3.2s：排查时比绝对时钟直观", () => {
    expect(relativeOffsetMs(start, at(3200))).toBe(3200);
    expect(relativeLabel(start, at(3200))).toBe("+3.2s");
    expect(relativeLabel(start, at(0))).toBe("+0ms");
    expect(relativeLabel(start, at(500))).toBe("+500ms");
  });

  it("超过一分钟换成 +1m02s、超过一小时换成 +1h02m（不显示一长串秒）", () => {
    expect(relativeLabel(start, at(62_000))).toBe("+1m02s");
    expect(relativeLabel(start, at(3_720_000))).toBe("+1h02m");
  });

  it("记录早于开始（时钟回拨/坏数据）显示负号，不假装成 0", () => {
    expect(relativeLabel(start, at(-3200))).toBe("-3.2s");
  });

  it("时间戳非法时不显示 NaN，返回空串", () => {
    expect(relativeOffsetMs(start, "not-a-date")).toBeNull();
    expect(relativeLabel("not-a-date", at(1000))).toBe("");
  });
});

describe("类型筛选", () => {
  it("提供四档：全部 / 工具 / 失败 / 被拒", () => {
    expect(ROLLOUT_FILTERS.map((f) => f.key)).toEqual(["all", "tools", "failed", "denied"]);
  });

  it("工具：只看调用与结果（含被拒的）", () => {
    const filtered = filterRolloutItems(items, "tools");
    expect(filtered.map((it) => it.seq)).toEqual([1, 2, 3, 4]);
  });

  it("失败：失败/被拒的工具结果 + 非正常收尾", () => {
    const failed = filterRolloutItems(items, "failed");
    expect(failed.map((it) => it.seq)).toEqual([4]);
    const errorTurn: RolloutItem[] = [...items.slice(0, 6), { type: "turn_end", seq: 6, at: at(6000), streamId: "s1", status: "error", error: "挂了" }];
    expect(filterRolloutItems(errorTurn, "failed").map((it) => it.seq)).toEqual([4, 6]);
  });

  it("被拒：只留 denied 的调用（与「执行失败」分开）", () => {
    expect(filterRolloutItems(items, "denied").map((it) => it.seq)).toEqual([4]);
  });

  it("全部：原样返回（同一份数组引用，避免无谓重算）", () => {
    expect(filterRolloutItems(items, "all")).toBe(items);
  });
});

describe("悬停配对", () => {
  const pairing = pairToolCalls(items);

  it("停在 tool_result 上能找回它的调用，反之亦然", () => {
    expect(counterpartIndex(pairing, 2)).toBe(1);
    expect(counterpartIndex(pairing, 1)).toBe(2);
  });

  it("没有配对（回合开始/最终答案）返回 null，不高亮错行", () => {
    expect(counterpartIndex(pairing, 0)).toBeNull();
    expect(counterpartIndex(pairing, 5)).toBeNull();
  });
});

describe("单回合导出 JSON", () => {
  it("导出内容与面板同源：条目数、未完成判定、日志版本", () => {
    const text = buildRolloutExport(items, { streamId: "s1", version: 2, exportedAt: start });
    const payload = JSON.parse(text) as {
      format: string;
      version: number;
      exportedAt: string;
      streamId: string;
      rolloutVersion: number;
      incomplete: { incomplete: boolean };
      count: number;
      items: RolloutItem[];
    };
    expect(payload.format).toBe("heming-rollout");
    expect(payload.version).toBe(ROLLOUT_EXPORT_VERSION);
    expect(payload.streamId).toBe("s1");
    expect(payload.rolloutVersion).toBe(2);
    expect(payload.count).toBe(items.length);
    expect(payload.items.map((it) => it.seq)).toEqual(items.map((it) => it.seq));
    // 与面板调用同一份判定：正常回合 → 未完成=false
    expect(payload.incomplete.incomplete).toBe(turnCompletion(items).incomplete);
  });

  it("崩溃回合导出后仍是「未完成」，并指出停在哪一步", () => {
    const crashed = items.slice(0, 3);
    const payload = JSON.parse(buildRolloutExport(crashed, { streamId: "s1", version: 2 })) as {
      incomplete: ReturnType<typeof turnCompletion>;
      exportedAt?: string;
    };
    expect(payload.incomplete.incomplete).toBe(true);
    expect(payload.incomplete.stoppedAtSeq).toBe(2);
    // 未传导出时间就不写这个字段（纯函数可复现，便于对比两次导出）
    expect(payload.exportedAt).toBeUndefined();
  });

  it("文件名带 streamId 且去掉路径分隔符（防止导出成路径）", () => {
    expect(rolloutExportFileName("s1")).toBe("rollout-s1.json");
    expect(rolloutExportFileName("../etc/passwd")).toBe("rollout-.._etc_passwd.json");
    expect(rolloutExportFileName("")).toBe("rollout-rollout.json");
  });
});
