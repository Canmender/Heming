import { describe, expect, it, vi } from "vitest";
import type { LlmProfile } from "../../store/llm.js";
import { collectFacts, DEFAULT_STAFF_SETTINGS, type StaffSettings } from "./model.js";
import { runStaffBrief } from "./runner.js";

const NOW = new Date(2026, 10, 1, 9, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const profile: LlmProfile = {
  id: "p1",
  label: "测试连接",
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-test",
};

function settings(patch: Partial<StaffSettings> = {}): StaffSettings {
  return {
    ...DEFAULT_STAFF_SETTINGS,
    enabled: true,
    ...patch,
    sources: { ...DEFAULT_STAFF_SETTINGS.sources, ...(patch.sources ?? {}) },
  };
}

function factsOf(items: { agenda?: number; tasks?: number; withRunning?: boolean } = {}) {
  return collectFacts(
    {
      agenda: Array.from({ length: items.agenda ?? 1 }, (_, i) => ({
        id: i + 1,
        title: `日程${i + 1}`,
        dueTs: NOW - HOUR + i * MINUTE,
        convName: "班群",
      })),
      tasks: Array.from({ length: items.tasks ?? 1 }, (_, i) => ({
        id: `t${i + 1}`,
        conversationId: `c${i + 1}`,
        title: `任务${i + 1}`,
        status: "failed",
        updatedAt: NOW - MINUTE - i,
        error: "超时",
      })),
    },
    NOW,
  );
}

function deps(patch: Partial<Parameters<typeof runStaffBrief>[0]> = {}) {
  return {
    trigger: "daily" as const,
    settings: settings(),
    facts: factsOf(),
    now: NOW,
    pushNotification: vi.fn(),
    notifyDesktop: vi.fn(() => true),
    recordUsage: vi.fn(),
    ...patch,
  };
}

describe("规则模式", () => {
  it("生成规则简报、覆盖事实与通知，未配置模型不记账", async () => {
    const push = vi.fn();
    const notify = vi.fn(() => true);
    const record = vi.fn();
    const { run, seenPatch } = await runStaffBrief(
      deps({ pushNotification: push, notifyDesktop: notify, recordUsage: record }),
    );

    expect(run.mode).toBe("rules");
    expect(run.trigger).toBe("daily");
    expect(run.summary).toContain("1 条日程临期");
    expect(run.findings).toHaveLength(2);
    expect(run.tokens).toBeNull();
    expect(seenPatch).toEqual({ agenda: ["1:overdue"], tasks: [`t1:failed:${NOW - MINUTE}`] });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ kind: "staff", title: "幕僚简报" });
    expect(notify).toHaveBeenCalledWith({ title: "幕僚简报", body: "有你可能需要处理的事" });
    expect(record).not.toHaveBeenCalled();
  });

  it("没有发现时不打扰：不推站内、不弹系统通知", async () => {
    const push = vi.fn();
    const notify = vi.fn(() => true);
    const callModel = vi.fn();
    const { run, seenPatch } = await runStaffBrief(
      deps({
        facts: collectFacts({}, NOW),
        profile,
        callModel,
        pushNotification: push,
        notifyDesktop: notify,
      }),
    );
    expect(run.mode).toBe("rules");
    expect(run.findings).toEqual([]);
    expect(run.summary).toBe("今天没有临期事项，也没有异常任务。");
    expect(seenPatch).toEqual({ agenda: [], tasks: [] });
    expect(push).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(callModel).not.toHaveBeenCalled();
  });

  it("手动运行与静默时段不弹系统通知，但站内照常", async () => {
    const notify = vi.fn(() => true);
    await runStaffBrief(deps({ trigger: "manual", notifyDesktop: notify }));
    expect(notify).not.toHaveBeenCalled();

    const quietNotify = vi.fn(() => true);
    const push = vi.fn();
    await runStaffBrief(
      deps({
        trigger: "agenda",
        quiet: true,
        notifyDesktop: quietNotify,
        pushNotification: push,
      }),
    );
    expect(quietNotify).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("简报只覆盖真正写进 findings 的事实（截断项下次仍会提醒）", async () => {
    const { seenPatch } = await runStaffBrief(
      deps({ facts: factsOf({ agenda: 9, tasks: 0 }) }),
    );
    expect(seenPatch.agenda).toHaveLength(8);
    expect(seenPatch.tasks).toEqual([]);
  });
});

describe("模型模式", () => {
  it("模型总结成功：mode=llm、用量入账、模型漏掉的 warn 被强制补回", async () => {
    const record = vi.fn();
    const callModel = vi.fn(async () => ({
      text: JSON.stringify({
        summary: "今天有一份材料逾期。",
        findings: [
          { severity: "urgent", title: "交材料已逾期", detail: "模型改写", refs: ["agenda:1"] },
        ],
      }),
      tokens: 42,
    }));
    const { run } = await runStaffBrief(deps({ profile, callModel, recordUsage: record }));

    expect(run.mode).toBe("llm");
    expect(run.summary).toBe("今天有一份材料逾期。");
    expect(run.tokens).toBe(42);
    expect(record).toHaveBeenCalledWith("gpt-test", 42);
    // 模型没提任务失败，规则补回
    expect(run.findings.some((f) => f.title.startsWith("任务失败："))).toBe(true);
    expect(run.findings.some((f) => f.title === "交材料已逾期")).toBe(true);
  });

  it("模型输出非法 → 回退规则并保留错误；用量按未上报记账", async () => {
    const record = vi.fn();
    const callModel = vi.fn(async () => ({ text: "我不知道", tokens: null }));
    const { run } = await runStaffBrief(deps({ profile, callModel, recordUsage: record }));

    expect(run.mode).toBe("fallback");
    expect(run.error).toContain("不是可用的简报 JSON");
    expect(run.findings).toHaveLength(2);
    expect(record).toHaveBeenCalledWith("gpt-test", null);
  });

  it("超过每日 token 上限时不再调模型，退回规则", async () => {
    const callModel = vi.fn();
    const record = vi.fn();
    const { run } = await runStaffBrief(
      deps({
        profile,
        callModel,
        recordUsage: record,
        settings: settings({ dailyTokenCap: 100 }),
        tokensToday: 100,
      }),
    );
    expect(callModel).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(run.mode).toBe("rules");
  });

  it("0 = 不限 token", async () => {
    const callModel = vi.fn(async () => ({
      text: JSON.stringify({
        summary: "模型版",
        findings: [{ severity: "info", title: "看看", detail: "", refs: ["agenda:1"] }],
      }),
      tokens: 7,
    }));
    const { run } = await runStaffBrief(
      deps({
        profile,
        callModel,
        settings: settings({ dailyTokenCap: 0 }),
        tokensToday: 999_999,
      }),
    );
    expect(run.mode).toBe("llm");
  });
});
