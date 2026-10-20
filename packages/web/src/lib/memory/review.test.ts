import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryStore } from "./store.js";
import { SkillPool } from "../skills/store.js";
import {
  DEFAULT_REVIEW_SETTINGS,
  bumpReviewCounter,
  buildReviewPrompt,
  containsSensitive,
  isComplexTask,
  parseReviewOutput,
  readReviewReport,
  resolveReviewSettings,
  runReview,
  semanticChars,
  type ReviewDeps,
} from "./review.js";
import type { StorageLike } from "./types.js";

/** 与其他记忆用例同口径的内存存储。 */
class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const T0 = new Date("2026-10-17T08:00:00.000Z").getTime();

function makePool() {
  const map = new Map<string, string>();
  return { pool: new SkillPool(new FakeStorage(), () => T0), storage: () => new FakeStorage() };
}

/** 组一份最小可用的复盘依赖；callModel 由用例注入。 */
function makeDeps(opts: {
  callModel: () => Promise<string>;
  prefs?: { shortTerm: boolean; longTerm: boolean; personalDb: boolean };
  counters?: Record<string, number>;
  settings?: Partial<typeof DEFAULT_REVIEW_SETTINGS>;
}) {
  const store = new MemoryStore(new FakeStorage(), () => T0);
  const { pool } = makePool();
  const state = {
    counters: opts.counters ?? {},
    settings: { ...DEFAULT_REVIEW_SETTINGS, ...(opts.settings ?? {}) },
  };
  const deps: ReviewDeps = {
    store,
    skills: pool,
    callModel: opts.callModel,
    readAgentPrefs: () => opts.prefs ?? { shortTerm: true, longTerm: true, personalDb: true },
    readSettings: () => state.settings,
    writeSettings: (s) => {
      state.settings = s;
    },
    readCounters: () => state.counters,
    writeCounters: (c) => {
      state.counters = c;
    },
    now: () => T0,
  };
  return { deps, store, pool, state };
}

const TURN = {
  agentId: "a1",
  conversationId: "c1",
  userText: "帮我把周报生成流程跑一遍",
  assistantText: "已按流程生成周报，并记录了踩坑点。",
  recentTurns: [
    { userText: "先读 git log", assistantText: "读取完成" },
    { userText: "按区域分组", assistantText: "分组完成" },
  ],
};

describe("resolveReviewSettings", () => {
  it("非法值一律回落默认，绝不让脏数据把复盘变成失控", () => {
    expect(resolveReviewSettings(null)).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(resolveReviewSettings("坏数据")).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(resolveReviewSettings({ frequency: "随时" }).frequency).toBe("after_complex_tasks");
    expect(resolveReviewSettings({ turnsThreshold: 0 }).turnsThreshold).toBe(
      DEFAULT_REVIEW_SETTINGS.turnsThreshold,
    );
    expect(resolveReviewSettings({ semanticCharLimit: 10 }).semanticCharLimit).toBe(
      DEFAULT_REVIEW_SETTINGS.semanticCharLimit,
    );
  });

  it("合法值照单全收", () => {
    expect(resolveReviewSettings({ frequency: "always", turnsThreshold: 3, semanticCharLimit: 800 })).toEqual({
      frequency: "always",
      turnsThreshold: 3,
      semanticCharLimit: 800,
    });
  });
});

describe("isComplexTask", () => {
  it("用过工具 / 输入长 / 回答展开 任一命中即算复杂", () => {
    expect(isComplexTask({ userText: "在吗", assistantText: "在", toolCallCount: 1 })).toBe(true);
    expect(isComplexTask({ userText: "问".repeat(120), assistantText: "短" })).toBe(true);
    expect(isComplexTask({ userText: "问", assistantText: "答".repeat(600) })).toBe(true);
  });

  it("寒暄与短问答不算复杂", () => {
    expect(isComplexTask({ userText: "你好", assistantText: "你好，有什么可以帮你？" })).toBe(false);
  });
});

describe("bumpReviewCounter", () => {
  it("到阈值才复盘，且复盘后计数归零", () => {
    let counters: Record<string, number> = {};
    const first = bumpReviewCounter(counters, "k", 3);
    expect(first.shouldReview).toBe(false);
    counters = first.counters;
    expect(counters.k).toBe(1);
    const second = bumpReviewCounter(counters, "k", 3);
    expect(second.shouldReview).toBe(false);
    const third = bumpReviewCounter(second.counters, "k", 3);
    expect(third.shouldReview).toBe(true);
    expect(third.counters.k).toBe(0);
  });
});

describe("containsSensitive", () => {
  it("密钥/令牌/口令类一律命中", () => {
    expect(containsSensitive("我的 key 是 sk-abcdefghijklmnop")).toBe(true);
    expect(containsSensitive("token: ghp_abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(containsSensitive("密码：hunter2000")).toBe(true);
    expect(containsSensitive("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("普通内容不误伤", () => {
    expect(containsSensitive("项目用 pnpm 而不是 npm")).toBe(false);
    expect(containsSensitive("部署脚本在 scripts/deploy.sh")).toBe(false);
  });
});

describe("parseReviewOutput", () => {
  it("包 markdown 代码块也能解析，并裁掉超长字段", () => {
    const raw = '```json\n{"memories":[{"key":"偏好-包管理器","value":"用 pnpm","scope":"user","confidence":0.8},{"key":"","value":"丢弃"}],"skill":{"name":"weekly-report","description":"周报","instructions":"1. 读 git log\\n2. 分组\\n3. 输出","triggers":["周报"],"tags":["汇报"]}}\n```';
    const out = parseReviewOutput(raw);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]).toMatchObject({ key: "偏好-包管理器", scope: "user", confidence: 0.8 });
    expect(out.skill?.name).toBe("weekly-report");
    expect(out.skill?.instructions).toContain("读 git log");
  });

  it("模型在 JSON 字符串里吐裸换行时也能救回来", () => {
    const raw = '{"memories":[{"key":"k","value":"第一行\n第二行"}],"skill":null}'.replace(
      /"第一行\n第二行"/,
      '"第一行\n第二行"',
    );
    const out = parseReviewOutput(raw);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0].value.replace(/\s+/g, " ")).toContain("第一行 第二行");
  });

  it("脏输出/非 JSON/缺字段一律空结果，绝不猜", () => {
    expect(parseReviewOutput("")).toEqual({ memories: [], skill: null });
    expect(parseReviewOutput("我觉得应该记住…")).toEqual({ memories: [], skill: null });
    expect(parseReviewOutput('{"memories":"不是数组","skill":"不是对象"}')).toEqual({
      memories: [],
      skill: null,
    });
    expect(parseReviewOutput('{"skill":{"name":"太短","instructions":"ab"}}').skill).toBeNull();
  });

  it("confidence 越界被夹到 [0.1, 1]", () => {
    const out = parseReviewOutput('{"memories":[{"key":"k","value":"v","confidence":9}]}');
    expect(out.memories[0].confidence).toBe(1);
  });
});

describe("buildReviewPrompt", () => {
  it("写清三件事：不记什么、密钥不记、流程走 skill，并带上已知 key", () => {
    const prompt = buildReviewPrompt({ ...TURN, knownKeys: ["偏好-语言"] });
    expect(prompt).toContain("不要记");
    expect(prompt).toContain("绝对不要记任何密钥");
    expect(prompt).toContain('"skill":null');
    expect(prompt).toContain("偏好-语言");
    expect(prompt).toContain("读 git log");
  });
});

describe("semanticChars", () => {
  it("按 key + value 累计", () => {
    const { deps, store } = makeDeps({ callModel: async () => "{}" });
    store.upsertSemantic({ agentId: "a1", key: "kk", value: "vvvv", source: "manual" });
    expect(semanticChars(store, "a1")).toBe(6);
    expect(deps).toBeTruthy();
  });
});

describe("runReview", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("频率 never：直接不跑模型", async () => {
    const callModel = vi.fn(async () => "{}");
    const { deps } = makeDeps({ callModel, settings: { frequency: "never" } });
    const report = await runReview(deps, TURN);
    expect(callModel).not.toHaveBeenCalled();
    expect(report.ran).toBe(false);
    expect(report.reason).toBe("复盘已关闭");
  });

  it("仅复杂任务模式：简单轮次跳过并累计计数", async () => {
    const callModel = vi.fn(async () => "{}");
    const { deps } = makeDeps({ callModel, settings: { frequency: "after_complex_tasks" } });
    const report = await runReview(deps, { ...TURN, userText: "你好", assistantText: "在" });
    expect(callModel).not.toHaveBeenCalled();
    expect(report.reason).toContain("不算复杂任务");
  });

  it("未到间隔轮次：跳过且不调模型", async () => {
    const callModel = vi.fn(async () => "{}");
    const { deps } = makeDeps({ callModel, settings: { frequency: "always", turnsThreshold: 5 } });
    const report = await runReview(deps, TURN);
    expect(callModel).not.toHaveBeenCalled();
    expect(report.reason).toContain("未到复盘间隔");
  });

  it("正常路径：写语义记忆（source=review）+ 沉淀技能并分配给该智能体", async () => {
    const callModel = vi.fn(async () =>
      JSON.stringify({
        memories: [{ key: "流程-周报", value: "先读 git log 再分组", scope: "agent", confidence: 0.7 }],
        skill: {
          name: "weekly-report",
          description: "生成周报",
          instructions: "1. 读 git log\n2. 按区域分组\n3. 输出三条要点",
          triggers: ["周报"],
          tags: ["汇报"],
        },
      }),
    );
    const { deps, store, pool } = makeDeps({ callModel, settings: { frequency: "always", turnsThreshold: 1 } });
    const report = await runReview(deps, TURN);

    expect(report.ran).toBe(true);
    expect(report.memoryWritten).toBe(1);
    expect(report.skillWritten).toBe("weekly-report");
    const mem = store.semantic("a1");
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ key: "流程-周报", source: "review", scope: "agent" });
    const skill = pool.list().find((s) => s.name === "weekly-report");
    expect(skill?.source).toBe("distilled");
    expect(skill?.instructions).toContain("读 git log");
    expect(pool.assigned("a1")).toContain(skill!.id);
  });

  it("同名技能再次沉淀 = 原地更新（自我改进），不产生副本", async () => {
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ memories: [], skill: { name: "weekly-report", instructions: "1. 读 git log\n2. 分组\n3. 输出" } }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ memories: [], skill: { name: "weekly-report", instructions: "1. 读 git log\n2. 排除 chore\n3. 输出并记录日期" } }),
      );
    const { deps, pool } = makeDeps({ callModel, settings: { frequency: "always", turnsThreshold: 1 } });
    await runReview(deps, TURN);
    const firstId = pool.list().find((s) => s.source === "distilled")!.id;
    await runReview(deps, TURN);
    const distilled = pool.list().filter((s) => s.source === "distilled");
    expect(distilled).toHaveLength(1);
    expect(distilled[0].id).toBe(firstId);
    expect(distilled[0].instructions).toContain("排除 chore");
  });

  it("密钥类候选被拒绝且不落盘", async () => {
    const callModel = vi.fn(async () =>
      JSON.stringify({
        memories: [
          { key: "凭据", value: "api_key=abcd1234efgh", scope: "agent" },
          { key: "环境", value: "生产机在 10.0.0.4", scope: "agent" },
        ],
        skill: null,
      }),
    );
    const { deps, store } = makeDeps({ callModel, settings: { frequency: "always", turnsThreshold: 1 } });
    const report = await runReview(deps, TURN);
    expect(report.memoryWritten).toBe(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].reason).toContain("密钥");
    expect(store.semantic("a1").map((e) => e.key)).toEqual(["环境"]);
  });

  it("容量写满后拒绝新增并说明原因（同 key 更新仍允许）", async () => {
    const callModel = vi.fn(async () =>
      JSON.stringify({
        memories: [
          { key: "已有", value: "旧值旧值旧值", scope: "agent" },
          { key: "新键", value: "值".repeat(300), scope: "agent" },
        ],
        skill: null,
      }),
    );
    const { deps, store } = makeDeps({
      callModel,
      settings: { frequency: "always", turnsThreshold: 1, semanticCharLimit: 200 },
    });
    store.upsertSemantic({ agentId: "a1", key: "已有", value: "旧值旧值旧值", source: "manual" });
    const report = await runReview(deps, TURN);
    expect(report.memoryWritten).toBe(1); // 同 key 覆盖，不占新额度
    expect(report.rejected[0].reason).toContain("已满");
    expect(store.semantic("a1")).toHaveLength(1);
  });

  it("长期记忆开关关闭：不写记忆也不沉淀技能", async () => {
    const callModel = vi.fn(async () =>
      JSON.stringify({
        memories: [{ key: "k", value: "v", scope: "agent" }],
        skill: { name: "s", instructions: "1. x\n2. y\n3. z" },
      }),
    );
    const { deps, store, pool } = makeDeps({
      callModel,
      prefs: { shortTerm: true, longTerm: false, personalDb: true },
      settings: { frequency: "always", turnsThreshold: 1 },
    });
    const report = await runReview(deps, TURN);
    expect(report.memoryWritten).toBe(0);
    expect(report.skillWritten).toBeNull();
    expect(report.rejected[0].reason).toContain("未开启长期记忆");
    expect(store.semantic("a1")).toHaveLength(0);
    expect(pool.list().filter((s) => s.source === "distilled")).toHaveLength(0);
  });

  it("模型报错不外溢，转成带原因的报告", async () => {
    const callModel = vi.fn(async () => {
      throw new Error("连接失败");
    });
    const { deps } = makeDeps({ callModel, settings: { frequency: "always", turnsThreshold: 1 } });
    const report = await runReview(deps, TURN);
    expect(report.ran).toBe(true);
    expect(report.reason).toContain("连接失败");
    expect(report.memoryWritten).toBe(0);
  });
});

describe("readReviewReport", () => {
  it("脏数据按「没有报告」处理", () => {
    expect(readReviewReport(null)).toBeNull();
    expect(readReviewReport({ getItem: () => "坏 JSON" })).toBeNull();
    expect(readReviewReport({ getItem: () => '{"foo":1}' })).toBeNull();
  });

  it("正常报告可读回，rejected 缺字段时归一为空数组", () => {
    const raw = JSON.stringify({
      at: "2026-10-19T00:00:00.000Z",
      agentId: "a1",
      ran: true,
      reason: "已沉淀",
      memoryWritten: 2,
      skillWritten: "x",
      rejected: "不是数组",
    });
    const report = readReviewReport({ getItem: () => raw });
    expect(report).toMatchObject({ memoryWritten: 2, skillWritten: "x", rejected: [] });
  });
});