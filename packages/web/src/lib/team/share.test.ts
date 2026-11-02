import { describe, expect, it } from "vitest";
import type { InfohubAgendaItem } from "../infohub/client.js";
import type { TaskRecord } from "../tasks/store.js";
import type { UsageRecord } from "../../store/tokenUsage.js";
import {
  collectTeamActivities,
  collectTeamUsage,
  DEFAULT_TEAM_SHARE,
  normalizeTeamShareSettings,
  summarizeLocalUsage,
  TEAM_UPLOAD_LIMIT,
  type TeamShareSettings,
} from "./share.js";

function task(over: Partial<TaskRecord> & Pick<TaskRecord, "id" | "updatedAt">): TaskRecord {
  return {
    conversationId: "c1",
    agentId: "a1",
    agentName: "小鸣",
    title: `任务 ${over.id}`,
    prompt: "不该上传的提示词",
    status: "done",
    createdAt: over.updatedAt - 1_000,
    steps: [],
    ...over,
  };
}

function agenda(
  over: Partial<InfohubAgendaItem> & Pick<InfohubAgendaItem, "id" | "dueTs">,
): InfohubAgendaItem {
  return {
    messageId: 1,
    conversationId: 2,
    title: `日程 ${over.id}`,
    detail: "不该上传的原文",
    dueText: "2026-11-03 09:00",
    allDay: false,
    kind: "meeting",
    status: "open",
    convName: "项目群",
    source: "wechat",
    senderName: "同事",
    msgTs: 1,
    ...over,
  };
}

const ON: TeamShareSettings = { tasks: true, agenda: true, usage: true, usageClearedAt: null, lastSyncAt: null };

describe("团队共享设置", () => {
  it("默认全关（任务 / 日程 / 用量三类）", () => {
    expect(DEFAULT_TEAM_SHARE).toEqual({
      tasks: false,
      agenda: false,
      usage: false,
      usageClearedAt: null,
      lastSyncAt: null,
    });
    expect(normalizeTeamShareSettings(null)).toEqual(DEFAULT_TEAM_SHARE);
    // 用量是 ②-3 新增：旧配置里没有这个字段，读回必须是关（不能默认开）
    expect(normalizeTeamShareSettings({ tasks: true })).toMatchObject({ usage: false });
  });

  it("旧版本存过的 staff 字段读回时丢弃", () => {
    const raw = { tasks: true, staff: true, agenda: true, usage: true, lastSyncAt: 123 };
    expect(normalizeTeamShareSettings(raw)).toEqual({
      tasks: true,
      agenda: true,
      usage: true,
      usageClearedAt: null,
      lastSyncAt: 123,
    });
  });

  it("坏字段一律回落为关闭", () => {
    expect(normalizeTeamShareSettings({ tasks: "yes", agenda: 1, lastSyncAt: "x" })).toEqual(
      DEFAULT_TEAM_SHARE,
    );
    expect(normalizeTeamShareSettings({ usageClearedAt: -5 })).toMatchObject({ usageClearedAt: null });
  });
});

describe("团队摘要采集", () => {
  it("只采真实成员的任务与日程，不产生智能体类条目", () => {
    const items = collectTeamActivities(ON, {
      tasks: [task({ id: "t1", updatedAt: 1_000 })],
      agenda: [agenda({ id: 1, dueTs: 2_000 })],
    });
    expect(items.map((i) => i.kind).sort()).toEqual(["agenda", "task"]);
  });

  it("关闭的来源不采集", () => {
    const items = collectTeamActivities(
      { ...DEFAULT_TEAM_SHARE, agenda: true },
      { tasks: [task({ id: "t1", updatedAt: 1_000 })], agenda: [agenda({ id: 1, dueTs: 2_000 })] },
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("agenda");
  });

  it("只上报白名单字段，提示词 / 日程原文 / 发送人不出本机", () => {
    const items = collectTeamActivities(ON, {
      tasks: [task({ id: "t1", updatedAt: 1_000 })],
      agenda: [agenda({ id: 1, dueTs: 2_000 })],
    });
    for (const item of items) {
      expect(item).not.toHaveProperty("prompt");
      expect(JSON.stringify(item)).not.toContain("不该上传");
      expect(JSON.stringify(item)).not.toContain("同事");
    }
    expect(items.find((i) => i.kind === "task")?.detail).toBe("任务 · 已完成");
    expect(items.find((i) => i.kind === "agenda")?.detail).toMatch(/^日程 · /);
  });

  it("sourceId 确定性生成：同一输入重复采集结果一致（服务端可幂等跳过）", () => {
    const sources = {
      tasks: [task({ id: "t1", updatedAt: 1_000 })],
      agenda: [agenda({ id: 1, dueTs: 2_000 })],
    };
    expect(collectTeamActivities(ON, sources)).toEqual(collectTeamActivities(ON, sources));
  });

  it("单次上报不超过 50 条（任务 20 + 日程 30 恰好封顶）", () => {
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task({ id: `t${i}`, updatedAt: 10_000 - i }),
    );
    const agendaItems = Array.from({ length: 60 }, (_, i) =>
      agenda({ id: i, dueTs: 10_000 - i }),
    );
    const items = collectTeamActivities(ON, { tasks, agenda: agendaItems });
    expect(items).toHaveLength(TEAM_UPLOAD_LIMIT);
  });

  it("按发生时间倒序", () => {
    const items = collectTeamActivities(ON, {
      tasks: [task({ id: "old", updatedAt: 1_000 }), task({ id: "new", updatedAt: 3_000 })],
      agenda: [agenda({ id: 1, dueTs: 2_000 })],
    });
    expect(items.map((i) => i.occurredAt)).toEqual([
      new Date(3_000).toISOString(),
      new Date(2_000).toISOString(),
      new Date(1_000).toISOString(),
    ]);
  });
});

/** 固定「现在」，让本地自然日可预测（测试跑在任何时区都不该晃）。 */
const NOW = new Date(2026, 10, 2, 12, 0, 0); // 2026-11-02 12:00 本地时间

function usage(at: Date, over: Partial<UsageRecord> = {}): UsageRecord {
  return { model: "gpt-x", tokens: 100, at: at.toISOString(), ...over };
}

describe("团队用量采集（②-3）", () => {
  it("默认关闭：不采集（关闭时不上传、不采集是隐私红线）", () => {
    expect(collectTeamUsage(DEFAULT_TEAM_SHARE, [usage(NOW)], NOW)).toEqual([]);
  });

  it("只上报白名单字段：日期/模型/连接名/token/未上报轮数", () => {
    const items = collectTeamUsage(
      { ...DEFAULT_TEAM_SHARE, usage: true },
      [usage(NOW, { profileLabel: "我的主连接" })],
      NOW,
    );
    expect(items).toEqual([
      {
        date: "2026-11-02",
        model: "gpt-x",
        tokens: 100,
        unreported: 0,
        connections: ["我的主连接"],
      },
    ]);
    // 请求体里不可能出现正文类字段（本机账本里也没有）
    for (const forbidden of ["prompt", "text", "result", "args", "content"]) {
      expect(Object.keys(items[0]!)).not.toContain(forbidden);
    }
  });

  it("按「本地自然日 × 模型」聚合；未上报单独计数且不进合计", () => {
    const items = collectTeamUsage(
      { ...DEFAULT_TEAM_SHARE, usage: true },
      [
        usage(NOW, { tokens: 100 }),
        usage(NOW, { tokens: 200 }),
        usage(NOW, { tokens: null }),
        usage(new Date(2026, 10, 1, 9, 0, 0), { tokens: 50 }),
      ],
      NOW,
    );
    expect(items).toEqual([
      { date: "2026-11-02", model: "gpt-x", tokens: 300, unreported: 1, connections: [] },
      { date: "2026-11-01", model: "gpt-x", tokens: 50, unreported: 0, connections: [] },
    ]);
  });

  it("全部未上报的日期模型格给 tokens:null（未上报 ≠ 0）", () => {
    const items = collectTeamUsage(
      { ...DEFAULT_TEAM_SHARE, usage: true },
      [usage(NOW, { tokens: null })],
      NOW,
    );
    expect(items[0]).toMatchObject({ tokens: null, unreported: 1 });
  });

  it("窗口只取近 30 个自然日；条数封顶 50", () => {
    const records: UsageRecord[] = [];
    for (let i = 0; i < 40; i += 1) {
      records.push(usage(new Date(2026, 10, 2 - i, 9, 0, 0), { model: `m${i}` }));
    }
    records.push(usage(new Date(2026, 8, 1, 9, 0, 0), { model: "太旧" })); // 两个月前：窗口外
    const items = collectTeamUsage({ ...DEFAULT_TEAM_SHARE, usage: true }, records, NOW);
    expect(items.length).toBeLessThanOrEqual(50);
    expect(items.some((i) => i.model === "太旧")).toBe(false);
    expect(items[0]!.date).toBe("2026-11-02");
  });

  it("连接名去重且最多 5 个（服务端 schema 上限）", () => {
    const items = collectTeamUsage(
      { ...DEFAULT_TEAM_SHARE, usage: true },
      [
        usage(NOW, { profileLabel: "A" }),
        usage(NOW, { profileLabel: "A" }),
        usage(NOW, { profileLabel: "B" }),
        usage(NOW, { profileLabel: "C" }),
        usage(NOW, { profileLabel: "D" }),
        usage(NOW, { profileLabel: "E" }),
        usage(NOW, { profileLabel: "F" }),
      ],
      NOW,
    );
    expect(items[0]!.connections).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("清除水位之后的用量才重新上传（否则删掉的数据会被下一轮同步传回去）", () => {
    const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);
    const records = [
      usage(at(3 * 3_600_000), { tokens: 100 }), // 3 小时前：水位之前
      usage(at(1 * 60_000), { tokens: 200 }), // 1 分钟前：水位之后
    ];
    const clearedAt = NOW.getTime() - 2 * 3_600_000;
    const items = collectTeamUsage(
      { ...DEFAULT_TEAM_SHARE, usage: true, usageClearedAt: clearedAt },
      records,
      NOW,
    );
    expect(items).toEqual([
      { date: "2026-11-02", model: "gpt-x", tokens: 200, unreported: 0, connections: [] },
    ]);
  });
});

describe("本机用量汇总（关闭共享时的展示）", () => {
  it("口径与服务端 self 一致：未上报不进合计，逐日铺满", () => {
    const summary = summarizeLocalUsage(
      [usage(NOW, { tokens: 120 }), usage(NOW, { tokens: null }), usage(new Date(2026, 9, 20, 9, 0, 0))],
      7,
      NOW,
    );
    expect(summary.total).toBe(120);
    expect(summary.unreported).toBe(1);
    expect(summary.byModel).toEqual([
      { model: "gpt-x", tokens: 120, unreported: 1, connections: [] },
    ]);
    // 7 天窗口逐日铺满（含今天），窗口外的 10-20 不算
    expect(summary.byDay).toHaveLength(7);
    expect(summary.byDay.at(-1)).toMatchObject({ date: "2026-11-02", tokens: 120 });
    expect(summary.byDay.some((d) => d.date === "2026-10-20")).toBe(false);
  });
});
