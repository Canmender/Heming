import { describe, it, expect } from "vitest";
import { MemoryStore } from "./store.js";
import { MEMORY_KEYS } from "./storage.js";
import { bm25Score, recallMemory } from "./recall.js";
import { MEMORY_CHAR_BUDGET, formatMemorySection, summarizeInjection } from "./format.js";
import { tokenize } from "./tokenize.js";
import { USAGE_BOOST_MAX, UsageLedger, isColdUsage } from "./usage.js";
import type { UsageView } from "./usage.js";
import type {
  EpisodicEntry,
  MemorySettings,
  SemanticEntry,
  StorageLike,
  WorkingTurn,
} from "./types.js";
import { GLOBAL_AGENT_ID } from "./types.js";

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  write(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }
}

const NOW = new Date("2026-10-17T08:00:00.000Z").getTime();
const DAY = 86_400_000;
const iso = (offsetMs = 0) => new Date(NOW - offsetMs).toISOString();

function episodic(id: string, summary: string, offsetMs = 0, extra: Partial<EpisodicEntry> = {}): EpisodicEntry {
  return {
    id,
    agentId: "agent-1",
    conversationId: "conv-1",
    summary,
    keywords: tokenize(summary).slice(0, 12),
    at: iso(offsetMs),
    importance: 0.5,
    sourceTurns: 6,
    ...extra,
  };
}

function semantic(id: string, key: string, value: string, extra: Partial<SemanticEntry> = {}): SemanticEntry {
  return {
    id,
    agentId: "agent-1",
    key,
    value,
    scope: "user",
    confidence: 0.8,
    pinned: false,
    source: "manual",
    createdAt: iso(),
    updatedAt: iso(),
    ...extra,
  };
}

function working(id: string, userText: string, assistantText: string, offsetMs = 0, extra: Partial<WorkingTurn> = {}): WorkingTurn {
  return { id, conversationId: "conv-1", agentId: "agent-1", userText, assistantText, at: iso(offsetMs), ...extra };
}

function storeOf(seed: {
  episodic?: EpisodicEntry[];
  semantic?: SemanticEntry[];
  semanticGlobal?: SemanticEntry[];
  working?: WorkingTurn[];
  settings?: Partial<MemorySettings>;
}): MemoryStore {
  const storage = new FakeStorage();
  if (seed.episodic?.length) storage.write(MEMORY_KEYS.episodic, { "agent-1": seed.episodic });
  if (seed.semantic?.length || seed.semanticGlobal?.length) {
    storage.write(MEMORY_KEYS.semantic, {
      ...(seed.semantic?.length ? { "agent-1": seed.semantic } : {}),
      ...(seed.semanticGlobal?.length ? { [GLOBAL_AGENT_ID]: seed.semanticGlobal } : {}),
    });
  }
  if (seed.working?.length) storage.write(MEMORY_KEYS.working, { "conv-1": seed.working });
  if (seed.settings) storage.write(MEMORY_KEYS.settings, { enabled: true, autoCapture: true, retentionDays: 90, ...seed.settings });
  return new MemoryStore(storage, () => NOW);
}

const recall = (store: MemoryStore, query: string, usage?: UsageView) =>
  recallMemory(store, { agentId: "agent-1", conversationId: "conv-1", query }, usage);

describe("tokenize：ASCII 词 + 中文 bigram", () => {
  it("中文按相邻二字切分", () => {
    expect(tokenize("讨论发布计划")).toEqual(["讨论", "论发", "发布", "布计", "计划"]);
  });

  it("ASCII 词小写化，与中文混排", () => {
    expect(tokenize("用 React 写 UI")).toEqual(["用", "react", "写", "ui"]);
  });

  it("标点切分、重复词只留首次出现顺序", () => {
    expect(tokenize("部署端口，端口是 8787。端口")).toEqual(["部署", "署端", "端口", "口是", "8787"]);
  });

  it("空串与纯标点返回空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("，。！？ —— ")).toEqual([]);
  });
});

describe("bm25Score", () => {
  it("命中查询词的文档得分更高", () => {
    const docs = [tokenize("讨论发布计划与回归"), tokenize("今天天气不错"), tokenize("发布计划周四确认")];
    const scores = bm25Score(tokenize("发布计划"), docs);
    expect(scores).toHaveLength(3);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[2]).toBeGreaterThan(0);
    expect(scores[1]).toBe(0);
    expect(scores[2]).toBeGreaterThan(scores[0]);
  });

  it("无重叠、空查询、空文档集一律 0", () => {
    expect(bm25Score(tokenize("天气"), [tokenize("讨论发布计划")])).toEqual([0]);
    expect(bm25Score([], [tokenize("讨论发布计划")])).toEqual([0]);
    expect(bm25Score(tokenize("讨论"), [])).toEqual([]);
  });
});

describe("recallMemory：语义层", () => {
  it("pinned 无条件带出，其余按重合度取 top5", () => {
    const store = storeOf({
      semantic: [
        semantic("pin", "称呼", "用户希望被称为「阿和」", { pinned: true }),
        semantic("lang", "偏好-语言", "默认使用简体中文", { updatedAt: iso(DAY) }),
        semantic("port", "部署端口", "默认 8787", { updatedAt: iso(2 * DAY) }),
        semantic("unrelated", "爱好", "喜欢爬山", { updatedAt: iso(3 * DAY) }),
        semantic("old", "偏好-编辑器", "使用默认的编辑器", { updatedAt: iso(4 * DAY) }),
      ],
    });
    const { semantic: hit } = recall(store, "默认用什么语言");
    expect(hit[0].id).toBe("pin");
    expect(hit.map((e) => e.id)).toContain("lang");
    expect(hit.map((e) => e.id)).toContain("old");
    expect(hit.map((e) => e.id)).not.toContain("unrelated");
    expect(hit.length).toBeLessThanOrEqual(6); // pinned + top5
  });

  it("命中数超过 5 条时截到 top5（不含 pinned）", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      semantic(`s${i}`, `部署端口${i}`, `默认端口是 878${i}`, { updatedAt: iso((i + 1) * DAY) }),
    );
    const store = storeOf({
      semantic: [semantic("pin", "称呼", "阿和", { pinned: true }), ...many],
    });
    const { semantic: hit } = recall(store, "默认端口");
    expect(hit).toHaveLength(6);
    expect(hit[0].id).toBe("pin");
  });

  it("查询为空时退回 pinned + 最近更新的 5 条", () => {
    const store = storeOf({
      semantic: [
        semantic("pin", "称呼", "阿和", { pinned: true }),
        semantic("a", "键a", "值a", { updatedAt: iso(5 * DAY) }),
        semantic("b", "键b", "值b", { updatedAt: iso(1 * DAY) }),
      ],
    });
    const { semantic: hit } = recall(store, "");
    expect(hit.map((e) => e.id)).toEqual(["pin", "b", "a"]);
  });
});

describe("recallMemory：情景层", () => {
  it("同等相关性下新条目优先（14 天半衰期）", () => {
    const store = storeOf({
      episodic: [
        episodic("old", "讨论了发布计划与回归", 28 * DAY),
        episodic("mid", "讨论了发布计划与回归", 14 * DAY),
        episodic("fresh", "讨论了发布计划与回归", 0),
      ],
    });
    const { episodic: hit } = recall(store, "讨论发布计划");
    expect(hit.map((e) => e.id)).toEqual(["fresh", "mid", "old"]);
  });

  it("与查询无关的条目不召回，top3 截断", () => {
    const store = storeOf({
      episodic: [
        episodic("a", "讨论了发布计划"),
        episodic("b", "讨论了发布计划的回归范围"),
        episodic("c", "发布计划与回归排期"),
        episodic("d", "发布计划最终确认"),
        episodic("e", "今天天气不错"),
      ],
    });
    const { episodic: hit } = recall(store, "发布计划");
    expect(hit).toHaveLength(3);
    expect(hit.map((e) => e.id)).not.toContain("e");
  });

  it("重要度加权影响排序", () => {
    const store = storeOf({
      episodic: [
        episodic("low", "讨论了发布计划", 0, { importance: 0.05 }),
        episodic("high", "讨论了发布计划", 0, { importance: 1 }),
      ],
    });
    const { episodic: hit } = recall(store, "发布计划");
    expect(hit[0].id).toBe("high");
  });
});

describe("recallMemory：时效覆盖与多样性重排", () => {
  it("同主题键只注入最新那条：全局桶与本智能体桶不会各带一份", () => {
    const store = storeOf({
      semantic: [semantic("local", "称呼", "用户希望被称为「老王」", { updatedAt: iso(30 * DAY) })],
      semanticGlobal: [
        semantic("shared", "称呼", "用户希望被称为「王总」", {
          agentId: GLOBAL_AGENT_ID,
          updatedAt: iso(DAY),
        }),
      ],
    });
    const { semantic: hit } = recall(store, "称呼是什么");
    expect(hit.map((e) => e.id)).toEqual(["shared"]);
  });

  it("同一桶里的历史重复条目同样被最新值覆盖（老版本数据不留双份）", () => {
    const store = storeOf({
      semantic: [
        semantic("old", "称呼", "用户希望被称为「老王」", { updatedAt: iso(30 * DAY) }),
        semantic("new", "称呼", "用户希望被称为「王总」", { updatedAt: iso(DAY) }),
      ],
    });
    const { semantic: hit } = recall(store, "称呼是什么");
    expect(hit.map((e) => e.id)).toEqual(["new"]);
  });

  it("置顶的是主题而不是那一版内容：同键有更新条目时由它继承置顶位", () => {
    const store = storeOf({
      semantic: [
        semantic("old", "称呼", "老王", { pinned: true, updatedAt: iso(30 * DAY) }),
        semantic("new", "称呼", "王总", { updatedAt: iso(DAY) }),
      ],
    });
    // 查询与记忆内容毫无重合——非置顶条目本该一条都不带，这里只验证「主题仍必带」且带的是新版
    const { semantic: hit } = recall(store, "今天天气怎么样");
    expect(hit.map((e) => e.id)).toEqual(["new"]);
  });

  it("置信度与 90 天半衰期共同决定排序：久远的强相关事实压过刚写的弱相关事实", () => {
    const store = storeOf({
      semantic: [
        semantic("old-fact", "发布计划", "每次发布计划都安排在周四", {
          confidence: 0.95,
          updatedAt: iso(150 * DAY),
        }),
        semantic("recent-weak", "计划", "今天有个会", { confidence: 0.6, updatedAt: iso() }),
      ],
    });
    const { semantic: hit } = recall(store, "发布计划");
    expect(hit.map((e) => e.id)).toEqual(["old-fact", "recent-weak"]);
  });

  it("情景层近似重复的摘要只占一个名额，其余名额让给不同内容", () => {
    const store = storeOf({
      episodic: [
        episodic("dup-a", "讨论了发布计划与回归", 0),
        episodic("dup-b", "讨论了发布计划与回归", 0),
        episodic("other-a", "发布计划与回归都已确认", 0),
        episodic("other-b", "发布计划与回归的最终排期", 0),
      ],
    });
    const { episodic: hit } = recall(store, "发布计划与回归");
    expect(hit).toHaveLength(3);
    const dups = hit.filter((e) => e.id === "dup-a" || e.id === "dup-b");
    expect(dups).toHaveLength(1); // 完全同文的两条不会一起挤进注入预算
  });
});

describe("recallMemory：工作层与总开关", () => {
  it("取最近 6 轮，按时间先后返回", () => {
    const turns = Array.from({ length: 8 }, (_, i) => working(`w${i}`, `问 ${i}`, `答 ${i}`, (8 - i) * 60_000));
    const store = storeOf({ working: turns });
    const { working: hit } = recall(store, "随便问问");
    expect(hit).toHaveLength(6);
    expect(hit.map((t) => t.userText)).toEqual(["问 2", "问 3", "问 4", "问 5", "问 6", "问 7"]);
  });

  it("工作记忆只取本会话、本智能体（载荷字段不符的轮次也不串台）", () => {
    const store = storeOf({
      working: [working("w0", "问", "答"), working("w1", "别家", "答", 0, { conversationId: "conv-9" })],
    });
    const { working: hit } = recall(store, "问");
    expect(hit.map((t) => t.id)).toEqual(["w0"]);
  });

  it("记忆总开关关闭时三层都为空", () => {
    const store = storeOf({
      semantic: [semantic("s", "称呼", "阿和")],
      episodic: [episodic("e", "讨论了发布计划")],
      working: [working("w", "问", "答")],
      settings: { enabled: false },
    });
    expect(recall(store, "讨论发布计划")).toEqual({
      semantic: [],
      episodic: [],
      working: [],
      scores: {},
      boosts: {},
      superseded: [],
    });
  });

  it("空库召回为空，格式化为空串（零注入）", () => {
    const store = storeOf({});
    expect(formatMemorySection(recall(store, "任何问题"))).toBe("");
  });
});

describe("formatMemorySection：注入格式与预算", () => {
  it("严格按设计 §4 的三段格式输出", () => {
    const recalled = {
      semantic: [semantic("s1", "称呼", "用户希望被称为「阿和」")],
      episodic: [episodic("e1", "讨论了发布计划，结论是周五前完成回归。", 0, { at: "2026-10-16T10:00:00.000Z" })],
      working: [working("w1", "部署端口是多少", "默认 8787", 0, { at: "2026-10-16T10:00:00.000Z" })],
    };
    expect(formatMemorySection(recalled)).toBe(
      [
        "## 长期记忆（语义）",
        "- 称呼：用户希望被称为「阿和」",
        "",
        "## 相关情景记忆",
        "- 2026-10-16：讨论了发布计划，结论是周五前完成回归。",
        "",
        "## 当前会话焦点",
        "- 焦点：部署端口是多少",
        "- 用户：部署端口是多少",
        "- 助手：默认 8787",
        "",
        "> 以上记忆仅作参考；与用户当前表述冲突时，以当前表述为准。不要向用户复述本段结构。",
      ].join("\n"),
    );
  });

  it("三层全空返回空串；有内容的层才出标题", () => {
    expect(formatMemorySection({ semantic: [], episodic: [], working: [] })).toBe("");
    const onlySemantic = formatMemorySection({
      semantic: [semantic("s1", "称呼", "阿和")],
      episodic: [],
      working: [],
    });
    expect(onlySemantic).toContain("## 长期记忆（语义）");
    expect(onlySemantic).not.toContain("## 相关情景记忆");
    expect(onlySemantic).not.toContain("## 当前会话焦点");
    expect(onlySemantic).toContain("> 以上记忆仅作参考");
  });

  it("总字符不超过 1200，逐条截断而非整段丢弃", () => {
    const store = storeOf({
      semantic: Array.from({ length: 5 }, (_, i) => semantic(`s${i}`, `问题${i}`, "值".repeat(200))),
      episodic: Array.from({ length: 3 }, (_, i) => episodic(`e${i}`, "摘".repeat(400), i * DAY)),
      working: Array.from({ length: 6 }, (_, i) =>
        working(`w${i}`, `问 ${"问".repeat(300)} ${i}`, `答 ${"答".repeat(300)} ${i}`, (6 - i) * 60_000),
      ),
    });
    const out = formatMemorySection(recall(store, "问题"));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET);
    expect(out).toContain("## 长期记忆（语义）");
    expect(out).toContain("## 当前会话焦点");
    expect(out).toContain("…"); // 长条目被截断但仍保留
  });

  it("未用额度顺延：只有情景层时长条目也能完整注入", () => {
    const long = "字".repeat(250);
    const store = storeOf({
      episodic: [episodic("e0", long, 0), episodic("e1", long, DAY), episodic("e2", long, 2 * DAY)],
    });
    const out = formatMemorySection(recall(store, "字字"));
    expect(out.length).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET);
    expect(out).toContain(`- ${iso(2 * DAY).slice(0, 10)}：${long}`);
    expect(out).toContain(`- ${iso(0).slice(0, 10)}：${long}`);
  });

  it("工作记忆为空时不出现焦点标题", () => {
    const out = formatMemorySection({ semantic: [], episodic: [episodic("e1", "讨论了发布计划")], working: [] });
    expect(out).toContain("## 相关情景记忆");
    expect(out).not.toContain("## 当前会话焦点");
  });
});

describe("recallMemory：打分与覆盖旁路（可观测性）", () => {
  it("每个入选条目都带分数，且分数随重合度单调", () => {
    const store = storeOf({
      semantic: [
        semantic("strong", "部署端口", "默认 8787，端口不可改"),
        semantic("weak", "爱好", "偶尔看看部署相关的书"),
      ],
      episodic: [episodic("e1", "讨论了发布计划的回归范围")],
    });
    const found = recall(store, "部署端口与发布计划");
    expect(found.scores.strong).toBeGreaterThan(found.scores.weak);
    expect(Object.keys(found.scores).sort()).toEqual(["e1", "strong", "weak"]);
    // 分数保留 4 位：UI 直接展示，不能出现 0.3247109382471093
    for (const value of Object.values(found.scores)) expect(value).toBe(Math.round(value * 1e4) / 1e4);
  });

  it("pinned 也带分数（口径为衰减分 × 置信度，与是否命中查询无关）", () => {
    const store = storeOf({ semantic: [semantic("pin", "称呼", "阿和", { pinned: true })] });
    const found = recall(store, "今天天气怎么样"); // 与记忆毫无重合
    expect(found.semantic.map((e) => e.id)).toEqual(["pin"]);
    expect(found.scores.pin).toBeGreaterThan(0);
  });

  it("未入选的条目没有分数：空位就是空位，不填 0 冒充「算过」", () => {
    const store = storeOf({ semantic: [semantic("s1", "部署端口", "8787"), semantic("s2", "爱好", "爬山")] });
    const found = recall(store, "部署端口");
    expect(found.scores.s1).toBeGreaterThan(0);
    expect(found.scores.s2).toBeUndefined();
  });

  it("同键覆盖留下 loser→winner 的记录，供记忆区解释「为什么没带这条」", () => {
    const store = storeOf({
      semantic: [
        semantic("old", "称呼", "老王", { updatedAt: iso(30 * DAY) }),
        semantic("new", "称呼", "王总", { updatedAt: iso(DAY) }),
        semantic("solo", "端口", "8787"),
      ],
    });
    const found = recall(store, "称呼");
    expect(found.superseded).toEqual([{ key: "称呼", loserId: "old", winnerId: "new" }]);
  });

  it("全局桶与本智能体桶撞键时同样记录覆盖来源", () => {
    const store = storeOf({
      semantic: [semantic("local", "称呼", "老王", { updatedAt: iso(30 * DAY) })],
      semanticGlobal: [
        semantic("shared", "称呼", "王总", { agentId: GLOBAL_AGENT_ID, updatedAt: iso(DAY) }),
      ],
    });
    expect(recall(store, "称呼").superseded).toEqual([
      { key: "称呼", loserId: "local", winnerId: "shared" },
    ]);
  });
});

describe("summarizeInjection：召回 ≠ 注入", () => {
  it("预算裁掉的候选只在 dropped 里出现，不算注入", () => {
    const store = storeOf({
      semantic: Array.from({ length: 5 }, (_, i) => semantic(`s${i}`, `问题${i}`, "值".repeat(200))),
    });
    const found = recall(store, "问题");
    const { text, observability } = summarizeInjection(found);
    expect(text).toBe(formatMemorySection(found)); // 文本口径与老封装逐字一致
    expect(observability.counts.semantic).toBe(found.semantic.length);
    expect(observability.injected.length).toBeLessThan(found.semantic.length);
    const injectedIds = new Set(observability.injected.map((item) => item.id));
    for (const drop of observability.dropped) {
      expect(injectedIds.has(drop.id)).toBe(false);
      expect(drop.reason).toBe("budget");
    }
    expect(observability.dropped.map((d) => d.id)).toEqual(
      found.semantic.filter((entry) => !injectedIds.has(entry.id)).map((entry) => entry.id),
    );
  });

  it("被同键新值覆盖的旧条目归因为 superseded，不与预算裁剪混在一起", () => {
    const found = recall(
      storeOf({
        semantic: [
          semantic("old", "称呼", "老王", { updatedAt: iso(30 * DAY) }),
          semantic("new", "称呼", "王总", { updatedAt: iso(DAY) }),
        ],
      }),
      "称呼是什么",
    );
    // 覆盖发生在排序之前：loser 根本没进候选，所以它出现在 superseded 而不是 dropped
    expect(found.superseded).toEqual([{ key: "称呼", loserId: "old", winnerId: "new" }]);
    const { observability } = summarizeInjection(found);
    expect(observability.superseded).toEqual(found.superseded);
    expect(observability.dropped).toEqual([]);
  });

  it("同一 id 既没注入又被标为覆盖时按覆盖归因（覆盖优先于预算，两种原因不重复计）", () => {
    const { observability } = summarizeInjection({
      // 第一条把语义层额度吃满，第二条进不去 → 它既是 dropped 又已被同键新值推翻
      semantic: [semantic("a", "长文", "值".repeat(500)), semantic("b", "称呼", "老王")],
      episodic: [],
      working: [],
      superseded: [{ key: "称呼", loserId: "b", winnerId: "c" }],
    });
    expect(observability.dropped).toEqual([
      { id: "b", layer: "semantic", reason: "superseded", content: "称呼：老王" },
    ]);
  });

  it("未注入项也带上原文本：只给 id 用户看不出「哪条被裁了」", () => {
    const { observability } = summarizeInjection({
      semantic: [semantic("a", "长文", "值".repeat(500)), semantic("b", "称呼", "老王")],
    });
    expect(observability.dropped[0].content).toBe("称呼：老王");
  });

  it("零召回时既无文本也无清单", () => {
    const { text, observability } = summarizeInjection({ semantic: [], episodic: [], working: [] });
    expect(text).toBe("");
    expect(observability.injected).toEqual([]);
    expect(observability.dropped).toEqual([]);
    expect(observability.counts).toEqual({ semantic: 0, episodic: 0, working: 0 });
  });

  it("注入清单里的文本就是真进了提示词的那段（含截断标记）", () => {
    const { text, observability } = summarizeInjection({
      semantic: [semantic("s1", "称呼", "阿和"), semantic("s2", "端口", "8".repeat(1000))],
      episodic: [],
      working: [],
    });
    expect(observability.injected.map((item) => item.layer)).toEqual(["semantic", "semantic"]);
    expect(observability.injected[0]).toMatchObject({ id: "s1", content: "称呼：阿和", truncated: false });
    expect(observability.injected[1].truncated).toBe(true);
    for (const item of observability.injected) expect(text).toContain(`- ${item.content}`);
  });
});

describe("个性化加权（d.28）", () => {
  /** 只给「这条值多少倍」的假视图：与 UsageLedger 同一接口，把公式与排序解耦开测。 */
  const viewOf = (map: Record<string, number>): UsageView => ({ boostOf: (id) => map[id] ?? 1 });

  /** 两条与「部署」同等相关（命中数、更新时间、置信度全同），差别只能由个性化决定。 */
  const tieStore = () =>
    storeOf({
      semantic: [semantic("sA", "部署端口", "8787"), semantic("sB", "部署目录", "/var/lib/heming")],
    });

  it("不传 usage 与显式 ×1 视图结果逐字相同（个性化是叠加层，不动既有口径）", () => {
    const store = tieStore();
    const neutral = recall(store, "部署");
    expect(neutral).toEqual(recall(store, "部署", viewOf({})));
    expect(neutral.boosts).toEqual({});
    // 不相关的一条根本不进候选（乘子救不了零命中）
    expect(neutral.semantic.map((entry) => entry.id)).toEqual(["sA", "sB"]);
    expect(neutral.scores).toEqual({ sA: 1.3, sB: 1.3 });
  });

  it("同等相关度里被疑似引用过的那条排前面，分数与旁路都带上乘子", () => {
    const boosted = recall(tieStore(), "部署", viewOf({ sB: 1.125 }));
    expect(boosted.semantic.map((entry) => entry.id)).toEqual(["sB", "sA"]);
    expect(boosted.scores).toEqual({ sB: 1.4625, sA: 1.3 });
    expect(boosted.boosts).toEqual({ sB: 1.125 });
  });

  it("提权封顶改不了明显的质量差：90 天前的老值最多加到 ×1.25 仍输给今天那条", () => {
    const store = storeOf({
      semantic: [
        semantic("sNew", "部署端口", "8787"),
        // 换键（同键会被时效覆盖，那样比的是覆盖不是加权）
        semantic("sOld", "部署目录", "opt", { updatedAt: iso(90 * DAY) }),
      ],
    });
    const result = recall(store, "部署", viewOf({ sOld: 1 + USAGE_BOOST_MAX }));
    expect(result.semantic.map((entry) => entry.id)).toEqual(["sNew", "sOld"]);
    expect(result.scores.sOld).toBeLessThan(result.scores.sNew);
  });

  it("pinned 项同样吃乘子（它必带，但分数仍要如实反映最终值）", () => {
    const store = storeOf({ semantic: [semantic("p", "称呼", "阿和", { pinned: true })] });
    const result = recall(store, "部署", viewOf({ p: 1.25 }));
    expect(result.scores.p).toBe(1.625);
    expect(result.boosts).toEqual({ p: 1.25 });
  });

  it("从没被引用的记忆不会因此被降权：冷只进清单，不改分数", () => {
    const storage = new FakeStorage();
    const ledger = new UsageLedger(storage, () => NOW);
    const run = {
      id: "rr-1",
      at: new Date(NOW).toISOString(),
      agentId: "agent-1",
      conversationId: "conv-1",
      query: "部署",
      recalled: { semantic: 2, episodic: 0, working: 0 },
      injected: [
        { id: "sA", layer: "semantic" as const, content: "部署端口：8787", truncated: false },
        { id: "sB", layer: "semantic" as const, content: "部署目录：/var/lib/heming", truncated: false },
      ],
      dropped: [],
      used: [],
    };
    for (let i = 0; i < 8; i++) ledger.apply(run);
    const store = tieStore();
    const result = recall(store, "部署", ledger);
    expect(result.scores).toEqual(recall(store, "部署").scores);
    expect(result.boosts).toEqual({});
    // 但清单上有它：8 次注入 0 次引用 = 冷
    expect(isColdUsage(ledger.get("sA"))).toBe(true);
  });

  it("情景层同样生效：BM25 打平时靠乘子决定谁进 top3", () => {
    const store = storeOf({
      episodic: [episodic("eA", "讨论了部署端口"), episodic("eB", "讨论了部署目录")],
    });
    expect(recall(store, "部署").episodic.map((e) => e.id)).toEqual(["eA", "eB"]);
    const boosted = recall(store, "部署", viewOf({ eB: 1.2 }));
    expect(boosted.episodic.map((e) => e.id)).toEqual(["eB", "eA"]);
    expect(boosted.boosts).toEqual({ eB: 1.2 });
  });

  it("summarizeInjection 原样带出乘子，缺省为空表", () => {
    const withBoost = summarizeInjection({
      semantic: [semantic("s1", "称呼", "阿和")],
      scores: { s1: 1.4625 },
      boosts: { s1: 1.125 },
    });
    expect(withBoost.observability.boosts).toEqual({ s1: 1.125 });
    expect(summarizeInjection({ semantic: [] }).observability.boosts).toEqual({});
  });
});
