import { describe, expect, it } from "vitest";
import {
  AGENDA_LOOKAHEAD_MS,
  AUTO_COOLDOWN_MS,
  DEFAULT_STAFF_SETTINGS,
  MAX_STAFF_RUNS,
  agendaKey,
  buildRuleBrief,
  collectFacts,
  countAutoRunsToday,
  decideTick,
  describeNextCheck,
  filterFactsBySources,
  filterUnseenFacts,
  inQuietHours,
  isDailyDue,
  mergeLlmBrief,
  nextDailyAt,
  normalizeRun,
  normalizeSeen,
  normalizeSettings,
  pruneRuns,
  taskKey,
  tokensToday,
  todayKey,
  type StaffFacts,
  type StaffRun,
  type StaffSettings,
} from "./model.js";

/** 固定本地时间：2026-11-01 09:00（周日）。 */
const NOW = new Date(2026, 10, 1, 9, 0, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function settings(patch: Partial<StaffSettings> = {}): StaffSettings {
  return {
    ...DEFAULT_STAFF_SETTINGS,
    enabled: true,
    ...patch,
    sources: { ...DEFAULT_STAFF_SETTINGS.sources, ...(patch.sources ?? {}) },
  };
}

function emptyFacts(): StaffFacts {
  return {
    agenda: [],
    tasks: [],
    running: 0,
    totals: { overdue: 0, today: 0, next24h: 0, stuck: 0, failed: 0 },
  };
}

function run(patch: Partial<StaffRun> = {}): StaffRun {
  return {
    id: "run-1",
    trigger: "agenda",
    mode: "rules",
    startedAt: NOW,
    finishedAt: NOW,
    summary: "",
    findings: [],
    tokens: null,
    ...patch,
  };
}

describe("staff 设置归一", () => {
  it("坏数据回退默认（默认关闭，避免刚升级就自动跑）", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_STAFF_SETTINGS);
    expect(normalizeSettings("坏")).toEqual(DEFAULT_STAFF_SETTINGS);
    expect(DEFAULT_STAFF_SETTINGS.enabled).toBe(false);
  });

  it("非法时间回退、上限夹紧、来源显式 false 保留", () => {
    const s = normalizeSettings({
      enabled: true,
      dailyAt: "25:00",
      quietFrom: "8:5",
      quietTo: "07:30",
      sources: { daily: false, agenda: true },
      profileId: "  ",
      dailyRunCap: 99,
      dailyTokenCap: -5,
      lastDailyDate: "2026-11-01",
    });
    expect(s.dailyAt).toBe("08:00");
    expect(s.quietFrom).toBe("22:00");
    expect(s.quietTo).toBe("07:30");
    expect(s.sources).toEqual({ daily: false, agenda: true, task: true });
    expect(s.profileId).toBeNull();
    expect(s.dailyRunCap).toBe(24);
    expect(s.dailyTokenCap).toBe(0);
    expect(s.lastDailyDate).toBe("2026-11-01");
  });

  it("日期格式不对 → null", () => {
    expect(normalizeSettings({ lastDailyDate: "2026/11/01" }).lastDailyDate).toBeNull();
  });
});

describe("静默时段与晨报时机", () => {
  it("跨零点静默：22:00–07:30", () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 1, h, m).getTime();
    expect(inQuietHours("22:00", "07:30", at(23))).toBe(true);
    expect(inQuietHours("22:00", "07:30", at(3))).toBe(true);
    expect(inQuietHours("22:00", "07:30", at(7, 29))).toBe(true);
    expect(inQuietHours("22:00", "07:30", at(7, 30))).toBe(false);
    expect(inQuietHours("22:00", "07:30", at(12))).toBe(false);
  });

  it("同起点同终点视为不静默（避免全天静默把功能关死）", () => {
    expect(inQuietHours("08:00", "08:00", NOW)).toBe(false);
  });

  it("晨报每天一次，到点才跑", () => {
    const early = new Date(2026, 10, 1, 7, 59).getTime();
    expect(isDailyDue(settings(), early)).toBe(false);
    expect(isDailyDue(settings(), NOW)).toBe(true);
    expect(isDailyDue(settings({ lastDailyDate: todayKey(NOW) }), NOW + HOUR)).toBe(false);
    expect(isDailyDue(settings({ sources: { daily: false, agenda: true, task: true } }), NOW)).toBe(
      false,
    );
  });

  it("下一次晨报：今天未到点 → 今天；已跑 → 明天", () => {
    const early = new Date(2026, 10, 1, 7, 0).getTime();
    expect(nextDailyAt(settings(), early)).toBe(new Date(2026, 10, 1, 8, 0).getTime());
    expect(nextDailyAt(settings({ lastDailyDate: todayKey(NOW) }), NOW)).toBe(
      new Date(2026, 10, 2, 8, 0).getTime(),
    );
  });

  it("下次检查文案覆盖关闭/静默/巡检", () => {
    expect(describeNextCheck(settings({ enabled: false }), NOW)).toBe("已关闭");
    expect(describeNextCheck(settings(), NOW)).toContain("每 15 分钟巡检");
    expect(describeNextCheck(settings(), new Date(2026, 10, 1, 7, 0).getTime())).toContain(
      "今天 08:00 晨报",
    );
    const quiet = new Date(2026, 10, 1, 8, 5).getTime();
    expect(describeNextCheck(settings({ quietTo: "08:10" }), quiet)).toContain("静默结束后");
  });
});

describe("事实采集", () => {
  it("日程分三档：逾期 / 今天 / 24 小时内；更远与已完成丢弃", () => {
    const facts = collectFacts(
      {
        agenda: [
          { id: 1, title: "逾期的", dueTs: NOW - HOUR },
          { id: 2, title: "今天的", dueTs: NOW + HOUR },
          { id: 3, title: "明天的", dueTs: NOW + 20 * HOUR },
          { id: 4, title: "后天的", dueTs: NOW + AGENDA_LOOKAHEAD_MS + HOUR },
          { id: 5, title: "已完成", dueTs: NOW + HOUR, status: "done" },
        ],
      },
      NOW,
    );
    expect(facts.agenda.map((item) => [item.agendaId, item.bucket])).toEqual([
      [1, "overdue"],
      [2, "today"],
      [3, "next24h"],
    ]);
    expect(facts.totals).toMatchObject({ overdue: 1, today: 1, next24h: 1 });
  });

  it("任务：卡住 / 24 小时内失败 / 进行中计数；更早的失败不报", () => {
    const facts = collectFacts(
      {
        tasks: [
          {
            id: "t1",
            conversationId: "c1",
            title: "卡住的任务",
            status: "running",
            updatedAt: NOW - 11 * MINUTE,
          },
          {
            id: "t2",
            conversationId: "c2",
            title: "刚失败的",
            status: "failed",
            updatedAt: NOW - MINUTE,
            error: "网络错误",
          },
          {
            id: "t3",
            conversationId: "c3",
            title: "昨天失败的",
            status: "failed",
            updatedAt: NOW - 25 * HOUR,
          },
          {
            id: "t4",
            conversationId: "c4",
            title: "正常进行中",
            status: "running",
            updatedAt: NOW - MINUTE,
          },
        ],
      },
      NOW,
    );
    expect(facts.running).toBe(2);
    expect(facts.tasks.map((item) => [item.taskId, item.issue])).toEqual([
      ["t1", "stuck"],
      ["t2", "failed"],
    ]);
    expect(facts.totals).toMatchObject({ stuck: 1, failed: 1 });
  });

  it("去重键：日程按 id+档位，任务按 id+问题+updatedAt", () => {
    expect(agendaKey({ agendaId: 7, bucket: "today" })).toBe("7:today");
    expect(taskKey({ taskId: "t1", issue: "failed", updatedAt: 123 })).toBe("t1:failed:123");
  });
});

describe("规则简报", () => {
  const facts = collectFacts(
    {
      agenda: [{ id: 1, title: "交材料", dueTs: NOW - HOUR, convName: "2601班群", dueText: "昨天 18:00" }],
      tasks: [
        {
          id: "t1",
          conversationId: "c1",
          title: "整理名单",
          status: "failed",
          updatedAt: NOW - MINUTE,
          error: "接口超时",
        },
      ],
    },
    NOW,
  );

  it("逾期日程是 urgent，失败任务是 warn，证据可追溯", () => {
    const brief = buildRuleBrief(facts, "daily", NOW);
    expect(brief.findings[0]).toMatchObject({
      severity: "urgent",
      title: "已逾期：交材料",
      action: { kind: "open-infohub" },
    });
    expect(brief.findings[0].detail).toContain("2601班群");
    expect(brief.findings[1]).toMatchObject({
      severity: "warn",
      title: "任务失败：整理名单",
      action: { kind: "open-task", targetId: "t1", conversationId: "c1" },
    });
    expect(brief.findings[1].detail).toContain("接口超时");
    expect(brief.summary).toContain("1 条日程临期");
  });

  it("全空时说「今天没有临期事项」；有进行中任务时补一句", () => {
    expect(buildRuleBrief(emptyFacts(), "daily", NOW).summary).toBe(
      "今天没有临期事项，也没有异常任务。",
    );
    expect(buildRuleBrief({ ...emptyFacts(), running: 2 }, "daily", NOW).summary).toBe(
      "今天没有临期事项，也没有异常任务；2 个任务进行中。",
    );
  });

  it("事件触发只报自己那一路", () => {
    const agendaOnly = buildRuleBrief(facts, "agenda", NOW);
    expect(agendaOnly.findings).toHaveLength(1);
    expect(agendaOnly.summary).toBe("有 1 条日程需要留意。");
    const taskOnly = buildRuleBrief(facts, "task", NOW);
    expect(taskOnly.findings).toHaveLength(1);
    expect(taskOnly.summary).toBe("有 1 个任务需要留意。");
  });

  it("findings 上限 8 条，紧急项排在前面", () => {
    const many = collectFacts(
      {
        agenda: Array.from({ length: 10 }, (_, i) => ({
          id: i + 1,
          title: `日程${i + 1}`,
          dueTs: NOW - HOUR + i * MINUTE,
        })),
      },
      NOW,
    );
    expect(buildRuleBrief(many, "agenda", NOW).findings).toHaveLength(8);
  });
});

describe("模型简报合并", () => {
  const rule = buildRuleBrief(
    collectFacts({ agenda: [{ id: 9, title: "交表", dueTs: NOW - HOUR }] }, NOW),
    "agenda",
    NOW,
  );

  it("模型总结优先；模型漏掉的 urgent 强制补回", () => {
    const merged = mergeLlmBrief(rule, {
      summary: "今天有一件事要立刻处理。",
      findings: [
        {
          id: "llm-1",
          severity: "info",
          title: "其他提醒",
          detail: "无关紧要",
          evidence: [],
        },
      ],
    });
    expect(merged.summary).toBe("今天有一件事要立刻处理。");
    expect(merged.findings.some((f) => f.title === "已逾期：交表")).toBe(true);
    expect(merged.findings[0].severity).toBe("urgent");
  });

  it("模型 refs 覆盖后不重复补回", () => {
    const merged = mergeLlmBrief(rule, {
      summary: "模型版",
      findings: [
        {
          id: "llm-1",
          severity: "urgent",
          title: "交表已逾期",
          detail: "模型改写",
          evidence: [{ label: "本机归档", kind: "agenda", refId: "agenda:9" }],
        },
      ],
    });
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0].title).toBe("交表已逾期");
  });

  it("模型结果为空 → 原样返回规则简报", () => {
    expect(mergeLlmBrief(rule, null)).toEqual(rule);
  });
});

describe("来源开关", () => {
  it("关掉某一路后，晨报也不会带出该类事实", () => {
    const facts = collectFacts(
      {
        agenda: [{ id: 1, title: "日程", dueTs: NOW - HOUR }],
        tasks: [
          {
            id: "t1",
            conversationId: "c1",
            title: "任务",
            status: "failed",
            updatedAt: NOW - MINUTE,
          },
        ],
      },
      NOW,
    );
    const filtered = filterFactsBySources(
      facts,
      settings({ sources: { daily: true, agenda: false, task: true } }),
    );
    expect(filtered.agenda).toEqual([]);
    expect(filtered.tasks).toHaveLength(1);
    expect(filtered.totals).toMatchObject({ overdue: 0, failed: 1 });
  });
});

describe("调度决策", () => {
  const agendaFacts = collectFacts(
    { agenda: [{ id: 1, title: "临期", dueTs: NOW - HOUR }] },
    NOW,
  );

  it("关闭时什么都不跑", () => {
    expect(
      decideTick({
        settings: settings({ enabled: false }),
        runs: [],
        seen: { agenda: {}, tasks: {} },
        facts: agendaFacts,
        now: NOW,
      }),
    ).toEqual({ kind: "none", reason: "disabled" });
  });

  it("晨报优先于事件，且静默时段内延后", () => {
    const daily = decideTick({
      settings: settings(),
      runs: [],
      seen: { agenda: {}, tasks: {} },
      facts: agendaFacts,
      now: NOW,
    });
    expect(daily).toMatchObject({ kind: "run", trigger: "daily" });
    if (daily.kind === "run") expect(daily.facts.agenda).toHaveLength(1);

    const quiet = new Date(2026, 10, 1, 5, 0).getTime();
    // 05:00 还没到 08:00，晨报本来就没到点；把晨报时间调到 04:00 才是「到点但静默」
    expect(
      decideTick({
        settings: settings({ dailyAt: "04:00" }),
        runs: [],
        seen: { agenda: {}, tasks: {} },
        facts: agendaFacts,
        now: quiet,
      }),
    ).toEqual({ kind: "none", reason: "quiet-daily" });
  });

  it("今天已经跑过晨报就不再跑（即使 lastDailyDate 没写进去）", () => {
    const decision = decideTick({
      settings: settings(),
      runs: [run({ trigger: "daily" })],
      seen: { agenda: {}, tasks: {} },
      facts: agendaFacts,
      now: NOW,
    });
    // 晨报跳过；未进账本的日程仍可作为事件提醒（真实流程里晨报已写入账本）
    expect(decision).toMatchObject({ kind: "run", trigger: "agenda" });
  });

  it("事件有 10 分钟冷却与每日上限；晨报不计入上限", () => {
    const settingsNoDaily = settings({ sources: { daily: false, agenda: true, task: true } });
    const cooldown = decideTick({
      settings: settingsNoDaily,
      runs: [run({ startedAt: NOW - 5 * MINUTE })],
      seen: { agenda: {}, tasks: {} },
      facts: agendaFacts,
      now: NOW,
    });
    expect(cooldown).toEqual({ kind: "none", reason: "cooldown" });

    const runs = Array.from({ length: 8 }, (_, i) =>
      run({ id: `r${i}`, startedAt: NOW - (i + 1) * AUTO_COOLDOWN_MS }),
    );
    expect(countAutoRunsToday(runs, NOW)).toBe(8);
    expect(
      decideTick({
        settings: settingsNoDaily,
        runs,
        seen: { agenda: {}, tasks: {} },
        facts: agendaFacts,
        now: NOW,
      }),
    ).toEqual({ kind: "none", reason: "cap" });
    expect(countAutoRunsToday([run({ trigger: "daily" })], NOW)).toBe(0);
  });

  it("只提醒未进账本的事实；日程优先于任务", () => {
    const facts = collectFacts(
      {
        agenda: [{ id: 1, title: "临期", dueTs: NOW - HOUR }],
        tasks: [
          {
            id: "t1",
            conversationId: "c1",
            title: "失败",
            status: "failed",
            updatedAt: NOW - MINUTE,
          },
        ],
      },
      NOW,
    );
    const unseen = filterUnseenFacts(facts, { agenda: { "1:overdue": NOW }, tasks: {} });
    expect(unseen.agenda).toHaveLength(0);

    const decision = decideTick({
      settings: settings({ sources: { daily: false, agenda: true, task: true } }),
      runs: [],
      seen: { agenda: { "1:overdue": NOW }, tasks: {} },
      facts,
      now: NOW,
    });
    expect(decision).toMatchObject({ kind: "run", trigger: "task" });
  });

  it("今天运行次数与 token 只统计今天的记录", () => {
    const yesterday = new Date(2026, 9, 31, 12, 0).getTime();
    const runs = [
      run({ id: "a", startedAt: NOW, tokens: 100 }),
      run({ id: "b", startedAt: NOW, tokens: null }),
      run({ id: "c", startedAt: yesterday, tokens: 999 }),
    ];
    expect(tokensToday(runs, NOW)).toBe(100);
    expect(todayKey(NOW)).toBe("2026-11-01");
  });
});

describe("简报与账本归一", () => {
  it("normalizeRun 丢弃未知触发/模式，截断文案", () => {
    expect(normalizeRun({ id: "x", trigger: "cron", mode: "rules" })).toBeNull();
    const run1 = normalizeRun({
      id: "x",
      trigger: "daily",
      mode: "fallback",
      startedAt: NOW,
      finishedAt: NOW,
      summary: "a".repeat(500),
      findings: [{ id: "f", severity: "urgent", title: "t", detail: "d", evidence: [] }],
      tokens: 12,
      error: "超时",
    });
    expect(run1?.summary.length).toBe(200);
    expect(run1?.tokens).toBe(12);
    expect(run1?.findings).toHaveLength(1);
  });

  it("pruneRuns 只留最新 30 份", () => {
    const runs = Array.from({ length: 40 }, (_, i) =>
      run({ id: `r${i}`, startedAt: NOW - i * MINUTE }),
    );
    const pruned = pruneRuns(runs);
    expect(pruned).toHaveLength(MAX_STAFF_RUNS);
    expect(pruned[0].id).toBe("r0");
  });

  it("账本归一：坏值丢弃、每类最多 200 条且保留最近的", () => {
    const agenda: Record<string, number> = {};
    for (let i = 0; i < 220; i += 1) agenda[`k${i}`] = i + 1;
    const seen = normalizeSeen({
      agenda: { ...agenda, bad: "x" as never, zero: 0 },
      tasks: { ok: 5 },
    });
    expect(Object.keys(seen.agenda)).toHaveLength(200);
    expect(seen.agenda.k219).toBe(220);
    expect(seen.agenda.k0).toBeUndefined();
    expect(seen.agenda.bad).toBeUndefined();
    expect(seen.tasks).toEqual({ ok: 5 });
    expect(normalizeSeen("坏")).toEqual({ agenda: {}, tasks: {} });
  });
});
