import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  EPISODIC_LIMIT,
  MemoryStore,
  SEMANTIC_LIMIT,
  WORKING_LIMIT,
} from "./store.js";
import { KEY_SIZE_LIMIT, MEMORY_KEYS, utf8Length, writeJson } from "./storage.js";
import type { EpisodicEntry, SemanticEntry, StorageLike, WorkingTurn } from "./types.js";

/** 假存储：既能断言落盘，也能模拟配额爆掉（setItem 抛错）。 */
class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  /** 读回落盘 JSON（未写入返回 undefined）。 */
  read<T>(key: string): T | undefined {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  write(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }
}

const T0 = new Date("2026-10-17T08:00:00.000Z").getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 可注入时钟：跨 2h/14 天衰减的用例靠它推进时间。 */
function makeClock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function newStore(storage: StorageLike = new FakeStorage(), clock = makeClock()): MemoryStore {
  return new MemoryStore(storage, clock.now);
}

function episodicFixture(id: string, at: string, extra: Partial<EpisodicEntry> = {}): EpisodicEntry {
  return {
    id,
    agentId: "agent-1",
    conversationId: "conv-1",
    summary: `条目 ${id}`,
    keywords: ["条目"],
    at,
    importance: 0.5,
    sourceTurns: 1,
    ...extra,
  };
}

function semanticFixture(id: string, key: string, extra: Partial<SemanticEntry> = {}): SemanticEntry {
  return {
    id,
    agentId: "agent-1",
    key,
    value: `值 ${key}`,
    scope: "user",
    confidence: 0.5,
    pinned: false,
    source: "manual",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...extra,
  };
}

describe("MemoryStore：三层隔离与 Working", () => {
  it("三层各自独立：recordTurn 只进 Working，情景/语义需显式写入", () => {
    const store = newStore();
    store.recordTurn("agent-1", "conv-1", "你好", "你好呀");
    expect(store.working("conv-1")).toHaveLength(1);
    expect(store.episodic("agent-1")).toEqual([]);
    expect(store.semantic("agent-1")).toEqual([]);
  });

  it("Working 按会话隔离、可按 agentId 过滤", () => {
    const store = newStore();
    store.recordTurn("agent-1", "conv-1", "a1", "答 a1");
    store.recordTurn("agent-2", "conv-1", "a2", "答 a2");
    store.recordTurn("agent-1", "conv-2", "b1", "答 b1");
    expect(store.working("conv-1")).toHaveLength(2);
    expect(store.working("conv-2")).toHaveLength(1);
    expect(store.working("conv-3")).toEqual([]);
    expect(store.working("conv-1", "agent-1").map((t) => t.userText)).toEqual(["a1"]);
    expect(store.working("conv-1", "agent-2").map((t) => t.userText)).toEqual(["a2"]);
  });

  it("Working 每会话上限 40 轮，超出丢最旧、保最新", () => {
    const store = newStore();
    for (let i = 1; i <= WORKING_LIMIT + 5; i++) {
      store.appendTurn({ conversationId: "conv-1", agentId: "agent-1", userText: `u${i}`, assistantText: `a${i}` });
    }
    const turns = store.working("conv-1");
    expect(turns).toHaveLength(WORKING_LIMIT);
    expect(turns[0].userText).toBe("u6");
    expect(turns[WORKING_LIMIT - 1].userText).toBe(`u${WORKING_LIMIT + 5}`);
  });

  it("Working 读取时过滤 2 小时前的过期轮次", () => {
    const clock = makeClock();
    const store = new MemoryStore(new FakeStorage(), clock.now);
    store.appendTurn({ conversationId: "conv-1", agentId: "agent-1", userText: "两小时内", assistantText: "在" });
    clock.advance(1 * HOUR);
    store.appendTurn({ conversationId: "conv-1", agentId: "agent-1", userText: "新的", assistantText: "在" });
    expect(store.working("conv-1")).toHaveLength(2);
    clock.advance(3 * HOUR);
    expect(store.working("conv-1")).toEqual([]);
  });

  it("appendTurn 补齐 id/at，并保留传入的 at 与 partial 标记", () => {
    const store = newStore();
    store.appendTurn({ conversationId: "conv-1", agentId: "agent-1", userText: "半截", assistantText: "部分", partial: true, at: new Date(T0 - HOUR).toISOString() });
    const [turn] = store.working("conv-1");
    expect(turn.id).toBeTruthy();
    expect(turn.at).toBe(new Date(T0 - HOUR).toISOString());
    expect(turn.partial).toBe(true);
  });

  it("中断轮次只进 Working，不沉淀情景记忆", () => {
    const store = newStore();
    for (let i = 0; i < 8; i++) {
      store.appendTurn({ conversationId: "conv-1", agentId: "agent-1", userText: `u${i}`, assistantText: "部分", partial: true });
    }
    expect(store.working("conv-1")).toHaveLength(8);
    expect(store.episodic("agent-1")).toEqual([]);
  });
});

describe("MemoryStore：6 轮沉淀 Episodic", () => {
  it("每 6 轮成功对话沉淀 1 条；12 轮 2 条", () => {
    const store = newStore();
    for (let i = 1; i <= 6; i++) {
      store.recordTurn("agent-1", "conv-1", `第 ${i} 问：讨论发布计划`, `第 ${i} 答：周五前完成回归`);
    }
    const first = store.episodic("agent-1");
    expect(first).toHaveLength(1);
    expect(first[0].summary).toContain("第 1 问");
    expect(first[0].sourceTurns).toBe(6);
    expect(first[0].importance).toBe(0.5);
    expect(first[0].keywords.length).toBeGreaterThan(0);
    expect(first[0].keywords.length).toBeLessThanOrEqual(12);
    expect(first[0].conversationId).toBe("conv-1");

    for (let i = 7; i <= 12; i++) {
      store.recordTurn("agent-1", "conv-1", `第 ${i} 问：讨论发布计划`, `第 ${i} 答：周五前完成回归`);
    }
    expect(store.episodic("agent-1")).toHaveLength(2);
  });

  it("不足 6 轮不沉淀；不同会话各自计数", () => {
    const store = newStore();
    for (let i = 0; i < 5; i++) store.recordTurn("agent-1", "conv-1", "问", "答");
    for (let i = 0; i < 3; i++) store.recordTurn("agent-1", "conv-2", "问", "答");
    expect(store.episodic("agent-1")).toEqual([]);
  });

  it("情景摘要上限 400 字、keywords 取自摘要", () => {
    const store = newStore();
    const long = "长".repeat(1000);
    store.addEpisodic({ agentId: "agent-1", conversationId: "conv-1", summary: long, sourceTurns: 6 });
    const [entry] = store.episodic("agent-1");
    expect(entry.summary.length).toBeLessThanOrEqual(400);
    expect(entry.keywords.length).toBeGreaterThan(0);
  });
});

describe("MemoryStore：Episodic 上限与淘汰", () => {
  it("超过 500 条时淘汰 importance × recency 最低者", () => {
    const storage = new FakeStorage();
    const seeded: EpisodicEntry[] = [];
    for (let i = 0; i < 499; i++) seeded.push(episodicFixture(`e${i}`, new Date(T0).toISOString()));
    // 同等重要度但 80 天前 → recency 更低，应被淘汰
    seeded.push(episodicFixture("old", new Date(T0 - 80 * DAY).toISOString()));
    storage.write(MEMORY_KEYS.episodic, { "agent-1": seeded });

    const store = new MemoryStore(storage, () => T0);
    store.addEpisodic({ agentId: "agent-1", conversationId: "conv-1", summary: "新条目", sourceTurns: 6 });

    const kept = storage.read<Record<string, EpisodicEntry[]>>(MEMORY_KEYS.episodic)!["agent-1"];
    expect(kept).toHaveLength(EPISODIC_LIMIT);
    expect(kept.some((e) => e.id === "old")).toBe(false);
    expect(kept.some((e) => e.summary === "新条目")).toBe(true);
  });

  it("重要度低的条目先被淘汰", () => {
    const storage = new FakeStorage();
    const seeded: EpisodicEntry[] = [];
    for (let i = 0; i < 499; i++) seeded.push(episodicFixture(`e${i}`, new Date(T0).toISOString()));
    seeded.push(episodicFixture("weak", new Date(T0).toISOString(), { importance: 0.02 }));
    storage.write(MEMORY_KEYS.episodic, { "agent-1": seeded });

    const store = new MemoryStore(storage, () => T0);
    store.addEpisodic({ agentId: "agent-1", conversationId: "conv-1", summary: "新条目" });
    const kept = storage.read<Record<string, EpisodicEntry[]>>(MEMORY_KEYS.episodic)!["agent-1"];
    expect(kept).toHaveLength(EPISODIC_LIMIT);
    expect(kept.some((e) => e.id === "weak")).toBe(false);
  });

  it("情景记忆按 retentionDays 过滤超期条目（读取时）", () => {
    const storage = new FakeStorage();
    storage.write(MEMORY_KEYS.episodic, {
      "agent-1": [
        episodicFixture("fresh", new Date(T0 - 5 * DAY).toISOString()),
        episodicFixture("stale", new Date(T0 - 200 * DAY).toISOString()),
      ],
    });
    const store = new MemoryStore(storage, () => T0);
    expect(store.episodic("agent-1").map((e) => e.id)).toEqual(["fresh"]);
    store.updateSettings({ retentionDays: 365 });
    expect(store.episodic("agent-1").map((e) => e.id).sort()).toEqual(["fresh", "stale"]);
  });
});

describe("MemoryStore：Semantic 去重与上限", () => {
  it("同 agentId + key upsert：保留 id/createdAt，刷新 value/updatedAt", () => {
    const clock = makeClock();
    const store = new MemoryStore(new FakeStorage(), clock.now);
    const created = store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
    clock.advance(60_000);
    const updated = store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿禾", source: "explicit", confidence: 0.9 });
    const list = store.semantic("agent-1");
    expect(list).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(list[0].value).toBe("阿禾");
    expect(list[0].confidence).toBe(0.9);
    expect(list[0].source).toBe("explicit");
  });

  it("不同 key 各自成条；同键 upsert 保留 pinned", () => {
    const store = newStore();
    store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
    const zt = store.upsertSemantic({ agentId: "agent-1", key: "偏好-语言", value: "简体中文", source: "manual" });
    store.updateSemantic("agent-1", zt.id, { pinned: true });
    store.upsertSemantic({ agentId: "agent-1", key: "偏好-语言", value: "繁体中文", source: "explicit" });
    expect(store.semantic("agent-1")).toHaveLength(2);
    const pinned = store.semantic("agent-1")[0];
    expect(pinned.key).toBe("偏好-语言");
    expect(pinned.pinned).toBe(true);
    expect(pinned.value).toBe("繁体中文");
  });

  it("语义记忆默认落全局桶，所有智能体共享（用户要求长期记忆公用）", () => {
    const store = newStore();
    // 不传 bucket → 落全局
    store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
    // 另一个智能体召回时也能看到同一条
    const seenBy2 = store.semantic("agent-2");
    expect(seenBy2.some((e) => e.value === "阿和")).toBe(true);
    expect(store.semanticGlobal()).toHaveLength(1);
    // 反过来往指定桶写：只该智能体可见，其他人不受影响
    store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual", bucket: "agent-1" });
    expect(store.semantic("agent-1").filter((e) => e.value === "阿和")).toHaveLength(2);
    expect(store.semantic("agent-2").filter((e) => e.value === "阿和")).toHaveLength(1);
  });

  it("findSemantic 跨桶查找：先本智能体再全局，同名以更具体的为准", () => {
    const store = newStore();
    store.upsertSemantic({ agentId: "x", key: "偏好-语言", value: "全局值", source: "manual" });
    store.upsertSemantic({ agentId: "x", key: "偏好-语言", value: "私有值", source: "manual", bucket: "agent-x" });
    expect(store.findSemantic("agent-x", "偏好-语言")?.value).toBe("私有值");
    // 没有私有那份时，回落到全局
    store.upsertSemantic({ agentId: "y", key: "偏好-语言", value: "全局值", source: "manual" });
    expect(store.findSemantic("agent-y", "偏好-语言")?.value).toBe("全局值");
  });

  it("显式指定 bucket 时同桶内 upsert 而非新增", () => {
    const store = newStore();
    store.upsertSemantic({ agentId: "a", key: "称呼", value: "第一次", source: "manual", bucket: "b1" });
    store.upsertSemantic({ agentId: "a", key: "称呼", value: "第二次", source: "manual", bucket: "b1" });
    const list = store.semantic("b1").filter((e) => e.key === "称呼");
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("第二次");
  });

  it("全局桶条目在 semantic(agentId) 里排在本智能体条目之前", () => {
    const store = newStore();
    store.upsertSemantic({ agentId: "a", key: "私有", value: "p", source: "manual", bucket: "agent-a" });
    store.upsertSemantic({ agentId: "a", key: "公用", value: "g", source: "manual" });
    const ids = store.semantic("agent-a").map((e) => e.key);
    expect(ids.indexOf("公用")).toBeLessThan(ids.indexOf("私有"));
  });

  it("超过 300 条时淘汰 confidence × recency 最低的非 pinned 条目", () => {
    const storage = new FakeStorage();
    const seeded: SemanticEntry[] = [semanticFixture("pin", "置顶", { pinned: true, confidence: 0.01, updatedAt: new Date(T0 - 300 * DAY).toISOString() })];
    for (let i = 0; i < 298; i++) seeded.push(semanticFixture(`s${i}`, `键${i}`));
    seeded.push(semanticFixture("weak", "低置信", { confidence: 0.03 }));
    storage.write(MEMORY_KEYS.semantic, { "__global__": seeded });

    const store = new MemoryStore(storage, () => T0);
    store.upsertSemantic({ agentId: "agent-1", key: "新键", value: "新值", source: "manual" });

    // 默认写全局桶，故淘汰也发生在全局桶里
    const kept = storage.read<Record<string, SemanticEntry[]>>(MEMORY_KEYS.semantic)!["__global__"];
    expect(kept).toHaveLength(SEMANTIC_LIMIT);
    expect(kept.some((e) => e.id === "weak")).toBe(false);
    expect(kept.some((e) => e.id === "pin")).toBe(true);
    expect(kept.some((e) => e.key === "新键")).toBe(true);
  });

  it("value 截断到 500 字、key 归一化到 24 字", () => {
    const store = newStore();
    const entry = store.upsertSemantic({
      agentId: "agent-1",
      key: `  ${"很长的键".repeat(20)}  `,
      value: "值".repeat(900),
      source: "manual",
    });
    expect(entry.value.length).toBeLessThanOrEqual(500);
    expect(entry.key.length).toBeLessThanOrEqual(24);
    expect(entry.key).toBe("很长的键".repeat(6)); // 首尾空白已归一化并截断到 24 字
  });

  it("updateSemantic / removeSemantic / removeEpisodic / clearAgent 落盘生效", () => {
    const storage = new FakeStorage();
    const store = new MemoryStore(storage, () => T0);
    const s = store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
    store.updateSemantic("agent-1", s.id, { value: "阿禾", pinned: true });
    expect(store.semantic("agent-1")[0]).toMatchObject({ value: "阿禾", pinned: true });
    store.removeSemantic("agent-1", s.id);
    expect(store.semantic("agent-1")).toEqual([]);

    store.addEpisodic({ agentId: "agent-1", conversationId: "conv-1", summary: "摘要条目" });
    const e = store.episodic("agent-1")[0];
    store.removeEpisodic("agent-1", e.id);
    expect(store.episodic("agent-1")).toEqual([]);

    store.recordTurn("agent-1", "conv-1", "问", "答");
    store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
    store.addEpisodic({ agentId: "agent-1", conversationId: "conv-1", summary: "再沉淀" });
    store.clearAgent("agent-1");
    expect(store.working("conv-1")).toEqual([]);
    expect(store.episodic("agent-1")).toEqual([]);
    // 全局桶里那条也是 agent-1 写的，应一并清掉
    expect(store.semantic("agent-1")).toEqual([]);
    expect(storage.read<Record<string, WorkingTurn[]>>(MEMORY_KEYS.working)).toEqual({});
  });

  it("clearAgent 只清自己的全局条目，别人的公用记忆保留", () => {
    const store = newStore();
    store.upsertSemantic({ agentId: "agent-1", key: "我的偏好", value: "中文", source: "manual" });
    store.upsertSemantic({ agentId: "agent-2", key: "他的偏好", value: "英文", source: "manual" });
    store.clearAgent("agent-1");
    const left = store.semanticGlobal();
    expect(left.map((e) => e.value)).toEqual(["英文"]);
  });

  it("updateSemantic 传未知 id 不抛错（静默）", () => {
    const store = newStore();
    expect(() => store.updateSemantic("agent-1", "nope", { value: "x" })).not.toThrow();
    expect(store.semantic("agent-1")).toEqual([]);
  });
});

describe("MemoryStore：开关语义", () => {
  it("enabled=false 时不记录任何层", () => {
    const store = newStore();
    store.updateSettings({ enabled: false });
    store.recordTurn("agent-1", "conv-1", "记住：我的称呼是阿和", "好的");
    expect(store.working("conv-1")).toEqual([]);
    expect(store.semantic("agent-1")).toEqual([]);
    expect(store.episodic("agent-1")).toEqual([]);
  });

  it("autoCapture=false 时只记 Working，不抽取、不沉淀", () => {
    const store = newStore();
    store.updateSettings({ autoCapture: false });
    for (let i = 1; i <= 6; i++) store.recordTurn("agent-1", "conv-1", "记住：我的称呼是阿和", "好的");
    expect(store.working("conv-1")).toHaveLength(6);
    expect(store.semantic("agent-1")).toEqual([]);
    expect(store.episodic("agent-1")).toEqual([]);
  });

  it("显式指令随 recordTurn 入库（source=explicit、confidence=0.9）", () => {
    const store = newStore();
    store.recordTurn("agent-1", "conv-1", "记住：我的称呼是阿和", "好的，阿和");
    const [entry] = store.semantic("agent-1");
    expect(entry).toMatchObject({ key: "称呼", value: "阿和", source: "explicit", confidence: 0.9, scope: "user" });
  });

  it("updateSettings 打补丁：未提供的字段保持原值并落盘", () => {
    const storage = new FakeStorage();
    const store = new MemoryStore(storage, () => T0);
    store.updateSettings({ retentionDays: 60 });
    expect(store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, retentionDays: 60 });
    expect(storage.read(MEMORY_KEYS.settings)).toEqual({ ...DEFAULT_SETTINGS, retentionDays: 60 });
  });
});

describe("MemoryStore：持久化、损坏回退与配额守卫", () => {
  it("新建实例从 localStorage 水合（模拟刷新）", () => {
    const storage = new FakeStorage();
    const store = new MemoryStore(storage, () => T0);
    store.recordTurn("agent-1", "conv-1", "你好", "你好呀");
    store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });

    const fresh = new MemoryStore(storage, () => T0);
    expect(fresh.working("conv-1")).toHaveLength(1);
    expect(fresh.semantic("agent-1")[0].value).toBe("阿和");
  });

  it("损坏数据回退空集（非法 JSON / 结构不符 / 设置是数组）", () => {
    const storage = new FakeStorage();
    storage.map.set(MEMORY_KEYS.working, "{oops");
    storage.map.set(MEMORY_KEYS.episodic, '"字符串"');
    storage.map.set(MEMORY_KEYS.semantic, JSON.stringify({ "agent-1": 42 }));
    storage.map.set(MEMORY_KEYS.settings, "[]");
    const store = new MemoryStore(storage, () => T0);
    expect(store.working("conv-1")).toEqual([]);
    expect(store.episodic("agent-1")).toEqual([]);
    expect(store.semantic("agent-1")).toEqual([]);
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("结构部分损坏时丢弃坏条目、保留好条目", () => {
    const storage = new FakeStorage();
    const good = semanticFixture("ok", "称呼");
    storage.write(MEMORY_KEYS.semantic, { "agent-1": [good, { id: 1 }, null, "x"] });
    storage.write(MEMORY_KEYS.working, { "conv-1": [{ id: "w1", agentId: "a", userText: "u" }], "conv-2": "坏" });
    const store = new MemoryStore(storage, () => T0);
    expect(store.semantic("agent-1")).toHaveLength(1);
    expect(store.working("conv-1")).toEqual([]); // 缺字段的轮次被丢弃
    expect(store.working("conv-2")).toEqual([]);
  });

  it("写入异常静默：storage 抛配额错误时不炸、内存态仍可用", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const store = new MemoryStore(storage, () => T0);
    expect(() => {
      store.recordTurn("agent-1", "conv-1", "你好", "在的");
      store.addEpisodic({ agentId: "agent-1", conversationId: "conv-1", summary: "摘要" });
      store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
      store.updateSettings({ enabled: false });
    }).not.toThrow();
    expect(storage.map.size).toBe(0);
    expect(store.working("conv-1")).toHaveLength(1);
    expect(store.semantic("agent-1")).toHaveLength(1);
    expect(store.getSettings().enabled).toBe(false);
  });

  it("配额守卫：单键超过 1.2MB 时先淘汰最旧轮次再落盘", () => {
    const storage = new FakeStorage();
    const store = new MemoryStore(storage, () => T0);
    const big = "a".repeat(20_000);
    for (let i = 1; i <= WORKING_LIMIT; i++) {
      store.appendTurn({ conversationId: "conv-1", agentId: "agent-1", userText: `u${i}-${big}`, assistantText: big });
    }
    const saved = storage.getItem(MEMORY_KEYS.working)!;
    expect(utf8Length(saved)).toBeLessThanOrEqual(KEY_SIZE_LIMIT);
    const turns = store.working("conv-1");
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.length).toBeLessThan(WORKING_LIMIT);
    expect(turns[turns.length - 1].userText.startsWith(`u${WORKING_LIMIT}-`)).toBe(true);
  });

  it("writeJson 超过 1.2MB 拒写并返回 false（不抛）", () => {
    const storage = new FakeStorage();
    expect(writeJson(storage, MEMORY_KEYS.settings, { blob: "字".repeat(KEY_SIZE_LIMIT) })).toBe(false);
    expect(storage.map.size).toBe(0);
    expect(writeJson(storage, MEMORY_KEYS.settings, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(storage.read(MEMORY_KEYS.settings)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("MemoryStore：导出与导入", () => {
  it("exportAll → importAll 全量往返", () => {
    const source = new MemoryStore(new FakeStorage(), () => T0);
    for (let i = 1; i <= 6; i++) source.recordTurn("agent-1", "conv-1", `问 ${i}`, `答 ${i}`);
    source.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });
    source.updateSettings({ retentionDays: 60 });

    const json = source.exportAll();
    const parsed = JSON.parse(json) as { version: number; exportedAt: string; data: unknown };
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(new Date(T0).toISOString());

    const target = new MemoryStore(new FakeStorage(), () => T0);
    expect(target.importAll(json)).toEqual({ ok: true });
    expect(target.working("conv-1")).toEqual(source.working("conv-1"));
    expect(target.episodic("agent-1")).toEqual(source.episodic("agent-1"));
    expect(target.semantic("agent-1")).toEqual(source.semantic("agent-1"));
    expect(target.getSettings()).toEqual(source.getSettings());
  });

  it("importAll 校验失败给出具体错误且不破坏现有数据", () => {
    const store = newStore();
    store.upsertSemantic({ agentId: "agent-1", key: "称呼", value: "阿和", source: "manual" });

    const bad = store.importAll("{oops");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("解析");

    const wrongVersion = store.importAll(JSON.stringify({ version: 2, data: {} }));
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.error).toContain("版本");

    const noData = store.importAll(JSON.stringify({ version: 1 }));
    expect(noData.ok).toBe(false);

    const emptyShape = store.importAll(JSON.stringify({ version: 1, data: { working: [] } }));
    expect(emptyShape.ok).toBe(false);

    expect(store.semantic("agent-1")).toHaveLength(1);
  });
});
