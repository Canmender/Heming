import { describe, expect, it } from "vitest";
import type { InfohubAgendaItem } from "../infohub/client.js";
import type { TaskRecord } from "../tasks/store.js";
import {
  collectTeamActivities,
  DEFAULT_TEAM_SHARE,
  normalizeTeamShareSettings,
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

const ON: TeamShareSettings = { tasks: true, agenda: true, lastSyncAt: null };

describe("团队共享设置", () => {
  it("默认全关，且只有任务 / 日程两类", () => {
    expect(DEFAULT_TEAM_SHARE).toEqual({ tasks: false, agenda: false, lastSyncAt: null });
    expect(normalizeTeamShareSettings(null)).toEqual(DEFAULT_TEAM_SHARE);
  });

  it("旧版本存过的 staff 字段读回时丢弃", () => {
    const raw = { tasks: true, staff: true, agenda: true, lastSyncAt: 123 };
    expect(normalizeTeamShareSettings(raw)).toEqual({
      tasks: true,
      agenda: true,
      lastSyncAt: 123,
    });
  });

  it("坏字段一律回落为关闭", () => {
    expect(normalizeTeamShareSettings({ tasks: "yes", agenda: 1, lastSyncAt: "x" })).toEqual(
      DEFAULT_TEAM_SHARE,
    );
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
