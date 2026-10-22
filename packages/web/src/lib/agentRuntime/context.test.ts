import { describe, it, expect, vi } from "vitest";
import { buildAgentContext } from "./context.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryStore as MemoryStoreType } from "../memory/store.js";
import { createMemoryStorage, MEMORY_KEYS } from "../memory/storage.js";
import { SkillPool } from "../skills/store.js";
import type { UsageView } from "../memory/usage.js";
import type { SkillPool as SkillPoolType } from "../skills/store.js";

/**
 * 运行时上下文组装（设计 §6）的集成单测：
 * 顺序 basePrompt → 记忆段 → 技能段；记忆/技能为空、关闭、抛错一律原样返回 basePrompt。
 */

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const BASE = "你是和小鸣";

/** 固定时钟 + 纯内存存储：召回的时间衰减/2h TTL 需要确定性基准，且不污染 localStorage。 */
function makeMemory(): MemoryStore {
  return new MemoryStore(createMemoryStorage(), () => NOW);
}

/** 空技能池：清掉首启种子的 4 个内置技能，「无命中」分支才好断言。 */
function emptySkills(): SkillPool {
  const pool = new SkillPool(createMemoryStorage(), () => NOW);
  for (const skill of pool.list()) pool.remove(skill.id);
  return pool;
}

function addCodeReview(pool: SkillPool) {
  return pool.create({
    name: "代码审查",
    description: "对代码变更做缺陷与可维护性审查",
    instructions: "先读变更意图，再逐处检查边界、并发与错误处理。",
    triggers: ["审查"],
    tags: ["代码"],
    enabled: true,
    version: "1.0.0",
  });
}

const EMPTY_RECALLED = { semantic: [], episodic: [], working: [] };

describe("buildAgentContext", () => {
  it("顺序为 basePrompt → 记忆段 → 技能段，且原提示词原文在最前", () => {
    const memory = makeMemory();
    memory.upsertSemantic({
      agentId: "a1",
      key: "称呼",
      value: "用户希望被称为「阿和」",
      source: "explicit",
    });
    memory.addEpisodic({ agentId: "a1", conversationId: "c1", summary: "确认了部署端口与备份策略" });
    memory.appendTurn({
      agentId: "a1",
      conversationId: "c1",
      userText: "上次聊了发布计划",
      assistantText: "周五前完成回归",
    });
    const skills = emptySkills();
    const matched = addCodeReview(skills);

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "我的称呼是什么？顺便看下部署端口与审查",
      basePrompt: BASE,
      memory,
      skills,
    });

    // 原提示词原文不动（前缀逐字相等），三段按设计 §4/§5 的顺序追加
    expect(out.systemPrompt.slice(0, BASE.length)).toBe(BASE);
    const semanticAt = out.systemPrompt.indexOf("## 长期记忆（语义）");
    const episodicAt = out.systemPrompt.indexOf("## 相关情景记忆");
    const workingAt = out.systemPrompt.indexOf("## 当前会话焦点");
    const skillAt = out.systemPrompt.indexOf("## 已启用技能");
    expect(semanticAt).toBeGreaterThan(BASE.length);
    expect(episodicAt).toBeGreaterThan(semanticAt);
    expect(workingAt).toBeGreaterThan(episodicAt);
    expect(skillAt).toBeGreaterThan(workingAt);

    expect(out.systemPrompt).toContain("称呼：用户希望被称为「阿和」");
    expect(out.systemPrompt).toContain("### 代码审查");

    // 召回明细与命中技能一并返回，供记忆页预览/调试使用
    expect(out.recalled.semantic.map((e) => e.key)).toEqual(["称呼"]);
    expect(out.recalled.episodic.map((e) => e.summary)).toEqual(["确认了部署端口与备份策略"]);
    expect(out.recalled.working.map((t) => t.userText)).toEqual(["上次聊了发布计划"]);
    expect(out.skills.map((m) => m.skill.id)).toEqual([matched.id]);
  });

  it("未传 memory/skills → 严格原样返回 basePrompt", () => {
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "hi",
      basePrompt: BASE,
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.recalled).toEqual(EMPTY_RECALLED);
    expect(out.skills).toEqual([]);
  });

  it("basePrompt 为空串且无记忆/技能 → 仍为空串（不凭空造标题）", () => {
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "hi",
      basePrompt: "",
      memory: makeMemory(),
      skills: emptySkills(),
    });
    expect(out.systemPrompt).toBe("");
  });

  it("记忆总开关关闭 → 严格原样返回 basePrompt（即便有内容）", () => {
    const memory = makeMemory();
    memory.updateSettings({ enabled: false });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    memory.appendTurn({
      agentId: "a1",
      conversationId: "c1",
      userText: "称呼",
      assistantText: "阿和",
    });

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "称呼是什么",
      basePrompt: BASE,
      memory,
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.recalled).toEqual(EMPTY_RECALLED);
  });

  it("记忆读取抛错 → 严格原样返回 basePrompt（零注入，不上抛）", () => {
    const broken = {
      getSettings: () => ({ enabled: true, autoCapture: true, retentionDays: 90 }),
      nowMs: () => NOW,
      semantic: () => {
        throw new Error("storage boom");
      },
      episodic: () => [],
      working: () => [],
    } as unknown as MemoryStoreType;

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "称呼是什么",
      basePrompt: BASE,
      memory: broken,
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.recalled).toEqual(EMPTY_RECALLED);
  });

  it("记忆读取抛错时不影响技能段（两层各自隔离）", () => {
    const broken = {
      getSettings: () => ({ enabled: true, autoCapture: true, retentionDays: 90 }),
      nowMs: () => NOW,
      semantic: () => {
        throw new Error("storage boom");
      },
      episodic: () => [],
      working: () => [],
    } as unknown as MemoryStoreType;
    const skills = emptySkills();
    addCodeReview(skills);

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "看下这版审查",
      basePrompt: BASE,
      memory: broken,
      skills,
    });
    expect(out.systemPrompt.startsWith(`${BASE}\n\n`)).toBe(true);
    expect(out.systemPrompt).toContain("## 已启用技能");
    expect(out.systemPrompt).not.toContain("## 长期记忆（语义）");
  });

  it("技能无命中（空池）→ 严格原样返回 basePrompt", () => {
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "看下这版审查",
      basePrompt: BASE,
      skills: emptySkills(),
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.skills).toEqual([]);
  });

  it("命中但被该智能体禁用 → 不注入、不计 usage，严格原样返回 basePrompt", () => {
    const skills = emptySkills();
    const skill = addCodeReview(skills);
    skills.setBinding("a1", { disabled: [skill.id] });
    const usage = vi.spyOn(skills, "recordUsage");

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "看下这版审查",
      basePrompt: BASE,
      skills,
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.skills).toEqual([]);
    expect(usage).not.toHaveBeenCalled();
  });

  it("技能路由抛错 → 严格原样返回 basePrompt（不上抛）", () => {
    const broken = {
      route: () => {
        throw new Error("route boom");
      },
    } as unknown as SkillPoolType;

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "看下这版审查",
      basePrompt: BASE,
      skills: broken,
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.skills).toEqual([]);
  });

  it("命中技能逐个计一次 usage（注入成功才计）", () => {
    const skills = emptySkills();
    const skill = addCodeReview(skills);
    const usage = vi.spyOn(skills, "recordUsage");

    buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "看下这版审查",
      basePrompt: BASE,
      skills,
    });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(skill.id);
  });

  it("usage 计数抛错不影响注入结果", () => {
    const skills = emptySkills();
    addCodeReview(skills);
    vi.spyOn(skills, "recordUsage").mockImplementation(() => {
      throw new Error("quota boom");
    });

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "看下这版审查",
      basePrompt: BASE,
      skills,
    });
    expect(out.systemPrompt).toContain("## 已启用技能");
    expect(out.skills).toHaveLength(1);
  });

  it("召回查询包含最近 2 轮用户文本（设计 §4）：只在该窗口命中的记忆才被带回", () => {
    const memory = makeMemory();
    // 三轮工作记忆（按时间先后）：末两轮词汇与「紫色」条目完全不共词
    memory.appendTurn({ agentId: "a1", conversationId: "c1", userText: "第一轮聊紫色", assistantText: "好" });
    memory.appendTurn({ agentId: "a1", conversationId: "c1", userText: "第二轮聊橙色", assistantText: "好" });
    memory.appendTurn({ agentId: "a1", conversationId: "c1", userText: "第三轮聊蓝色", assistantText: "好" });
    memory.upsertSemantic({ agentId: "a1", key: "紫色", value: "已废弃", source: "manual" });
    memory.upsertSemantic({ agentId: "a1", key: "橙色", value: "是主色", source: "manual" });
    memory.upsertSemantic({ agentId: "a1", key: "蓝色", value: "用于强调", source: "manual" });

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "接着说说这个",
      basePrompt: BASE,
      memory,
    });

    // 当前文本 + 最近 2 轮 → 命中橙色/蓝色；仅第 1 轮出现的紫色不召回
    expect(out.recalled.semantic.map((e) => e.key).sort()).toEqual(["橙色", "蓝色"]);
    expect(out.recalled.working).toHaveLength(3);
  });
});

describe("buildAgentContext：注入旁路（可观测性）", () => {
  const EMPTY_TRACE = {
    injected: [],
    dropped: [],
    scores: {},
    boosts: {},
    superseded: [],
    counts: { semantic: 0, episodic: 0, working: 0 },
  };

  it("未接记忆 / 记忆关闭 / 记忆抛错 → 旁路为空档（与零注入一致）", () => {
    expect(
      buildAgentContext({ agentId: "a1", conversationId: "c1", userText: "hi", basePrompt: BASE }).recallTrace,
    ).toEqual(EMPTY_TRACE);

    const memory = makeMemory();
    memory.updateSettings({ enabled: false });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    expect(
      buildAgentContext({
        agentId: "a1",
        conversationId: "c1",
        userText: "称呼是什么",
        basePrompt: BASE,
        memory,
      }).recallTrace,
    ).toEqual(EMPTY_TRACE);
  });

  it("注入了什么就在旁路里：分数、层级、文本三者对得上提示词", () => {
    const memory = makeMemory();
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "用户希望被称为「阿和」", source: "explicit" });
    memory.addEpisodic({ agentId: "a1", conversationId: "c1", summary: "确认了部署端口与备份策略" });

    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "我的称呼是什么？顺便看下部署端口",
      basePrompt: BASE,
      memory,
      skills: emptySkills(),
    });
    const layers = out.recallTrace.injected.map((item) => item.layer);
    expect(layers).toEqual(["semantic", "episodic"]);
    for (const item of out.recallTrace.injected) {
      expect(out.systemPrompt).toContain(`- ${item.content}`);
      expect(out.recallTrace.scores[item.id]).toBeGreaterThan(0);
    }
    expect(out.recallTrace.counts).toEqual({ semantic: 1, episodic: 1, working: 0 });
    expect(out.recallTrace.dropped).toEqual([]);
  });

  it("召回 ≠ 注入：被预算裁掉的候选进 dropped，绝不进 injected", () => {
    const memory = makeMemory();
    // 6 条 200 字的长事实，语义层额度（约 460 字）吃不下
    for (let i = 0; i < 6; i++) {
      memory.upsertSemantic({ agentId: "a1", key: `长文${i}`, value: "值".repeat(200), source: "manual" });
    }
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "长文",
      basePrompt: BASE,
      memory,
    });
    expect(out.recallTrace.counts.semantic).toBeGreaterThan(out.recallTrace.injected.length);
    expect(out.recallTrace.injected.length).toBeGreaterThan(0);
    const injectedIds = new Set(out.recallTrace.injected.map((item) => item.id));
    expect(out.recallTrace.dropped.length).toBe(
      out.recallTrace.counts.semantic - injectedIds.size,
    );
    for (const drop of out.recallTrace.dropped) {
      expect(injectedIds.has(drop.id)).toBe(false);
      expect(drop.reason).toBe("budget");
    }
  });

  it("同键旧值被覆盖时旁路给出 loser→winner，供记忆区解释", () => {
    // 直接塞两条同键条目（upsertSemantic 会就地合并，只有历史/多桶数据才会真的撞键）
    const storage = createMemoryStorage();
    const iso = new Date(NOW).toISOString();
    const entry = (id: string, value: string, updatedAt: string) => ({
      id,
      agentId: "a1",
      key: "称呼",
      value,
      scope: "user",
      confidence: 0.8,
      pinned: false,
      source: "manual",
      createdAt: iso,
      updatedAt,
    });
    storage.setItem(
      MEMORY_KEYS.semantic,
      JSON.stringify({
        a1: [entry("old", "老王", new Date(NOW - 30 * 86_400_000).toISOString()), entry("new", "王总", iso)],
      }),
    );
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "称呼是什么",
      basePrompt: BASE,
      memory: new MemoryStore(storage, () => NOW),
    });
    expect(out.systemPrompt).toContain("称呼：王总");
    expect(out.recallTrace.superseded).toEqual([{ key: "称呼", loserId: "old", winnerId: "new" }]);
    expect(out.recallTrace.injected[0].id).toBe("new");
  });
});

describe("buildAgentContext 个性化加权（d.28）", () => {
  /** 两条与「部署」同等相关的记忆：命中数、置信度、更新时间全同，先后只能由权重决定。 */
  function tiedMemory() {
    const memory = makeMemory();
    const a = memory.upsertSemantic({ agentId: "a1", key: "部署端口", value: "8787", source: "manual" });
    const b = memory.upsertSemantic({
      agentId: "a1",
      key: "部署目录",
      value: "生产放在 /var/www",
      source: "manual",
    });
    return { memory, a: a.id, b: b.id };
  }

  const build = (memory: MemoryStoreType, usage?: UsageView) =>
    buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "部署",
      basePrompt: BASE,
      memory,
      skills: emptySkills(),
      usage,
    });

  it("不传 usage → boosts 为空表，顺序与写入顺序一致（既有拼装口径零变化）", () => {
    const { memory, a, b } = tiedMemory();
    const out = build(memory);
    expect(out.recallTrace.boosts).toEqual({});
    expect(out.recallTrace.injected.map((item) => item.id)).toEqual([a, b]);
  });

  it("被疑似引用过的那条进提示词时排前面，旁路带出乘子与最终分数", () => {
    const { memory, a, b } = tiedMemory();
    const base = build(memory).recallTrace.scores[b];
    const out = build(memory, { boostOf: (id) => (id === b ? 1.2 : 1) });
    expect(out.recallTrace.injected.map((item) => item.id)).toEqual([b, a]);
    expect(out.recallTrace.boosts).toEqual({ [b]: 1.2 });
    expect(out.recallTrace.scores[b]).toBeCloseTo(base * 1.2, 4);
    // 注入文本真的换了顺序（不是只有旁路数字变了）
    expect(out.systemPrompt.indexOf("部署目录")).toBeLessThan(out.systemPrompt.indexOf("部署端口"));
  });

  it("权重只改顺序，不改取用：条数、层名额与候选集合都照旧", () => {
    const { memory, a, b } = tiedMemory();
    const neutral = build(memory);
    const boosted = build(memory, { boostOf: (id) => (id === b ? 1.25 : 1) });
    expect(boosted.recallTrace.counts).toEqual(neutral.recallTrace.counts);
    expect(boosted.recallTrace.injected.map((item) => item.id)).toEqual([b, a]);
    expect(neutral.recallTrace.injected.map((item) => item.id)).toEqual([a, b]);
  });
});
