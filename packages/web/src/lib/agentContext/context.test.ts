import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../llmClient.js";
import type { StorageLike } from "../memory/types.js";
import { estimateRowsTokens, estimateTokens } from "./tokens.js";
import { DEFAULT_RESERVED_TOKENS, planContext } from "./budget.js";
import { SUMMARY_HEADER, buildSummaryPrompt, deterministicSummary } from "./summary.js";
import {
  CONTEXT_KEYS,
  DEFAULT_CONTEXT_SETTINGS,
  loadContextSettings,
  normalizeContextSettings,
  saveContextSettings,
} from "./settings.js";
import { SUMMARY_CACHE_LIMIT, SummaryCache } from "./store.js";
import { prepareHistory } from "./history.js";

/**
 * 上下文预算核心库测试（计划 Task A）。
 * 纯逻辑、无网络、无 React：token 估算 / 预算切分与原子组保护 / 确定性摘要 /
 * 设置读写 / 摘要缓存 / prepareHistory 五条分支。
 */

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

/** 单条消息成本（含结构开销），与实现同口径，便于精确推算预算。 */
function cost(m: ChatMessage): number {
  return estimateTokens(m.content) + 4;
}

function total(rows: ChatMessage[]): number {
  return rows.reduce((sum, m) => sum + cost(m), 0);
}

/** `n` 轮对话：每轮 user + assistant，内容定长（token 数可精确推算）。 */
function conversation(turns: number, pad = 28): ChatMessage[] {
  const fill = "x".repeat(pad);
  const rows: ChatMessage[] = [];
  for (let i = 1; i <= turns; i++) {
    const label = String(i).padStart(2, "0");
    rows.push(msg("user", `u${label}${fill}`));
    rows.push(msg("assistant", `a${label}${fill}`));
  }
  return rows;
}

describe("estimateTokens：零依赖、CJK 感知", () => {
  it("空串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("CJK 一字一 token（含扩展区）", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("上下文预算管理")).toBe(7);
    expect(estimateTokens("㐀")).toBe(1); // CJK 扩展 A
    expect(estimateTokens("𠀀")).toBe(1); // CJK 扩展 B（代理对算 1 token）
    expect(estimateTokens("。，、")).toBe(3); // CJK 标点同样按字计（宁可高估）
  });

  it("ASCII 每 4 字符 1 token，向上取整", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("hello world")).toBe(3); // 11 字符 → ceil(11/4)
  });

  it("中英混排：中文按字、ASCII 连续段合并后向上取整", () => {
    expect(estimateTokens("你好abc")).toBe(3); // 2 + ceil(3/4)
    expect(estimateTokens("abc你好defg")).toBe(1 + 2 + 1);
  });

  it("其余字符 2 字符 1 token", () => {
    expect(estimateTokens("Привет")).toBe(3); // 6 字符
    expect(estimateTokens("😀😀")).toBe(1); // emoji 按码点计
  });

  it("宁高估：任何非空串至少 1 token", () => {
    expect(estimateTokens(" ")).toBe(1);
    expect(estimateTokens("\n")).toBe(1);
  });
});

describe("estimateRowsTokens：每条 +4 结构开销", () => {
  it("空数组为 0；单条空内容 = 4", () => {
    expect(estimateRowsTokens([])).toBe(0);
    expect(estimateRowsTokens([msg("user", "")])).toBe(4);
  });

  it("逐条累加：内容 token + 4", () => {
    expect(estimateRowsTokens([msg("user", "abcd"), msg("assistant", "你好")])).toBe(1 + 4 + 2 + 4);
  });

  it("与逐条 cost() 口径一致", () => {
    const rows = conversation(4);
    expect(estimateRowsTokens(rows)).toBe(total(rows));
  });
});

describe("planContext：预算切分", () => {
  it("预算够放全部：older 为空、usedTokens 为全量", () => {
    const rows = conversation(3);
    const result = planContext(rows, { budgetTokens: 10_000, keepRecentTurns: 8 });
    expect(result.recent).toEqual(rows);
    expect(result.older).toEqual([]);
    expect(result.usedTokens).toBe(total(rows));
    expect(result.overflowTokens).toBe(0);
  });

  it("空 rows 返回全空结果", () => {
    expect(planContext([], { budgetTokens: 6000, keepRecentTurns: 8 })).toEqual({
      recent: [],
      older: [],
      usedTokens: 0,
      overflowTokens: 0,
    });
  });

  it("从末尾累计：超预算的更早消息进 older（不切原子组时切点落在 user）", () => {
    const rows = conversation(6); // 12 条
    const per = cost(rows[0]);
    // 恰好放得下最后 3 轮（6 条），且第 7 条（从后数）是 user → 无需原子组保护
    const result = planContext(rows, { budgetTokens: per * 6, keepRecentTurns: 99 });
    expect(result.recent).toEqual(rows.slice(6));
    expect(result.older).toEqual(rows.slice(0, 6));
    expect(result.usedTokens).toBe(total(rows.slice(6)));
    expect(result.overflowTokens).toBe(total(rows.slice(0, 6)));
  });

  it("原子组保护：切点使 recent 以 assistant 开头 → 紧邻的 user 一并移入", () => {
    const rows = conversation(6);
    const per = cost(rows[0]);
    const result = planContext(rows, { budgetTokens: per * 5, keepRecentTurns: 99 });
    // 纯按预算只会放最后 5 条（以 a04 开头）→ 把紧邻的 u04 一并移入
    expect(result.recent.map((m) => m.content.slice(0, 3))).toEqual([
      "u04",
      "a04",
      "u05",
      "a05",
      "u06",
      "a06",
    ]);
    expect(result.recent[0].role).toBe("user");
    expect(result.older).toEqual(rows.slice(0, 6));
    // 保护会让 recent 略微超预算（宁可高估、不拆轮次）
    expect(result.usedTokens).toBeGreaterThan(per * 5);
    expect(result.usedTokens).toBe(total(result.recent));
  });

  it("reservedTokens 从预算中扣除", () => {
    const rows = conversation(6);
    const per = cost(rows[0]);
    const result = planContext(rows, { budgetTokens: per * 6, reservedTokens: per * 2, keepRecentTurns: 99 });
    expect(result.recent).toEqual(rows.slice(8));
    expect(result.older).toEqual(rows.slice(0, 8));
  });

  it("预算装不下任何一条 → recent 空、older 全量", () => {
    const rows = conversation(2);
    const result = planContext(rows, { budgetTokens: 1, keepRecentTurns: 8 });
    expect(result.recent).toEqual([]);
    expect(result.older).toEqual(rows);
    expect(result.usedTokens).toBe(0);
    expect(result.overflowTokens).toBe(total(rows));
  });

  it("预算为负 / 非有限值按 0 处理（不抛错）", () => {
    const rows = conversation(1);
    expect(planContext(rows, { budgetTokens: -100, keepRecentTurns: 8 }).recent).toEqual([]);
    expect(planContext(rows, { budgetTokens: Number.NaN, keepRecentTurns: 8 }).recent).toEqual([]);
  });
});

describe("planContext：keepRecentTurns 轮数上限", () => {
  it("口径：一轮 = 一条 user + 其后到下一条 user 之前的全部消息", () => {
    const rows = conversation(6);
    const result = planContext(rows, { budgetTokens: 100_000, keepRecentTurns: 2 });
    expect(result.recent.map((m) => m.content.slice(0, 3))).toEqual(["u05", "a05", "u06", "a06"]);
    expect(result.older).toEqual(rows.slice(0, 8));
  });

  it("轮数上限按 user 计：尾部未回复的 user 单独占一轮", () => {
    const rows = [...conversation(2), msg("user", "u03待回复")];
    const result = planContext(rows, { budgetTokens: 100_000, keepRecentTurns: 1 });
    expect(result.recent).toEqual([msg("user", "u03待回复")]);
    expect(result.older).toEqual(rows.slice(0, 4));
  });

  it("先按预算取、再按轮数截断（两者取更严的结果）", () => {
    const rows = conversation(6);
    const capped = planContext(rows, { budgetTokens: 100_000, keepRecentTurns: 3 });
    expect(capped.recent).toHaveLength(6);
    expect(capped.older).toEqual(rows.slice(0, 6));

    // 预算比轮数更严 → 结果与纯预算切分一致
    const per = cost(rows[0]);
    const budgeted = planContext(rows, { budgetTokens: per * 4, keepRecentTurns: 8 });
    expect(budgeted.recent).toHaveLength(4);
  });

  it("轮数上限为 0 或负数时至少保留最后一轮", () => {
    const rows = conversation(3);
    const result = planContext(rows, { budgetTokens: 100_000, keepRecentTurns: 0 });
    expect(result.recent).toEqual(rows.slice(-2));
    expect(result.older).toEqual(rows.slice(0, 4));
  });
});

/* ---------------------------------------------------------------- 假存储/时钟 */

/** 假存储：既能断言落盘，也能模拟配额爆掉（setItem 抛错）。 */
class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
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

/** 可注入时钟：LRU 淘汰顺序靠它推进。 */
function makeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    tick: (ms = 1) => {
      now += ms;
    },
  };
}

/** 指纹用例素材：pad 不同 → 内容长度不同 → 指纹互不相同。 */
function olderOf(tag: number): ChatMessage[] {
  return conversation(1, 8 + tag);
}

/* ------------------------------------------------------------------- 摘要 */

describe("deterministicSummary：零成本回落骨架", () => {
  it("无有效内容返回空串", () => {
    expect(deterministicSummary([])).toBe("");
    expect(deterministicSummary([msg("system", "系统提示")])).toBe("");
    expect(deterministicSummary([msg("user", "   "), msg("assistant", "")])).toBe("");
  });

  it("固定骨架：标题 + 意图/结论/待办三段", () => {
    const out = deterministicSummary([
      msg("user", "帮我规划下周的发布"),
      msg("assistant", "好的，先梳理范围。再排期。"),
    ]);
    expect(out.split("\n")).toEqual([
      SUMMARY_HEADER,
      "意图：帮我规划下周的发布",
      "结论：好的，先梳理范围",
      "待办：（未提及）",
    ]);
  });

  it("用户意图：折叠空白、截前 80 字、最多最早 3 条", () => {
    const users = [1, 2, 3, 4].map((i) => msg("user", `第${i}问\n${"很长的补充".repeat(30)}`));
    const intent = deterministicSummary(users).split("\n")[1].slice("意图：".length);
    const parts = intent.split("；");
    expect(parts).toHaveLength(3);
    expect(parts[0].startsWith("第1问 很长的补充")).toBe(true); // 换行被折叠为空格
    expect(parts[1].startsWith("第2问")).toBe(true);
    expect(parts[2].startsWith("第3问")).toBe(true);
    for (const part of parts) expect(part).toHaveLength(80);
  });

  it("助手结论：只取首句、最多 3 条", () => {
    const out = deterministicSummary([
      msg("assistant", "第一句。第二句不取。"),
      msg("assistant", "甲！乙？"),
      msg("assistant", "三"),
      msg("assistant", "第四条不取"),
    ]);
    const conclusion = out.split("\n")[2].slice("结论：".length);
    expect(conclusion).toBe("第一句；甲；三");
    expect(out).not.toContain("第二句");
    expect(out).not.toContain("第四条");
  });

  it("助手回复无句末标点时截 80 字", () => {
    const out = deterministicSummary([msg("assistant", "很长的结论".repeat(50))]);
    expect(out.split("\n")[2]).toBe(`结论：${"很长的结论".repeat(50).slice(0, 80)}`);
  });

  it("只有助手消息时意图为占位，骨架仍完整", () => {
    const lines = deterministicSummary([msg("assistant", "在的。")]).split("\n");
    expect(lines[0]).toBe(SUMMARY_HEADER);
    expect(lines[1]).toBe("意图：（未提及）");
    expect(lines[2]).toBe("结论：在的");
    expect(lines[3]).toBe("待办：（未提及）");
  });
});

describe("buildSummaryPrompt：发给模型的固定骨架提示词", () => {
  it("空 older 返回空数组（无内容可压缩）", () => {
    expect(buildSummaryPrompt([])).toEqual([]);
  });

  it("system 指令 + user 转写：要求只输出三段、不寒暄", () => {
    const prompt = buildSummaryPrompt([msg("user", "你好"), msg("assistant", "在的")]);
    expect(prompt).toHaveLength(2);
    expect(prompt[0].role).toBe("system");
    expect(prompt[0].content).toContain("只输出");
    expect(prompt[0].content).toContain("不要寒暄");
    expect(prompt[0].content).toContain(SUMMARY_HEADER);
    expect(prompt[0].content).toContain("意图");
    expect(prompt[0].content).toContain("结论");
    expect(prompt[0].content).toContain("待办");
    expect(prompt[1].role).toBe("user");
    expect(prompt[1].content).toContain("用户：你好");
    expect(prompt[1].content).toContain("助手：在的");
  });

  it("maxChars 截断转写并保留最靠近 recent 的尾部", () => {
    const older = conversation(4);
    const full = buildSummaryPrompt(older)[1].content;
    const short = buildSummaryPrompt(older, 40)[1].content;
    expect(short.length).toBeLessThan(full.length);
    expect(short.slice(-40)).toBe(full.slice(-40));
  });

  it("maxChars 为非有限值时回落默认上限（不抛错）", () => {
    const older = conversation(2);
    expect(buildSummaryPrompt(older, Number.NaN)).toEqual(buildSummaryPrompt(older));
  });
});

/* ------------------------------------------------------------------- 设置 */

describe("上下文设置：读写与损坏回退", () => {
  it("默认值：启用、6000、8 轮、LLM 摘要开", () => {
    expect(DEFAULT_CONTEXT_SETTINGS).toEqual({
      enabled: true,
      budgetTokens: 6000,
      keepRecentTurns: 8,
      llmSummary: true,
    });
    expect(loadContextSettings(new FakeStorage())).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it("补丁落盘 heming.context.v1，并可往返读取", () => {
    const storage = new FakeStorage();
    expect(CONTEXT_KEYS.settings).toBe("heming.context.v1");
    const saved = saveContextSettings({ budgetTokens: 8000 }, storage);
    expect(saved).toEqual({ ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 8000 });
    expect(storage.read(CONTEXT_KEYS.settings)).toEqual(saved);
    expect(loadContextSettings(storage)).toEqual(saved);
  });

  it("多次补丁累加：未提供的字段保持原值", () => {
    const storage = new FakeStorage();
    saveContextSettings({ enabled: false, keepRecentTurns: 4 }, storage);
    const saved = saveContextSettings({ llmSummary: false }, storage);
    expect(saved).toEqual({ enabled: false, budgetTokens: 6000, keepRecentTurns: 4, llmSummary: false });
  });

  it("整体损坏回退默认（非法 JSON / 数组 / 字符串）", () => {
    const storage = new FakeStorage();
    storage.map.set(CONTEXT_KEYS.settings, "{oops");
    expect(loadContextSettings(storage)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    storage.map.set(CONTEXT_KEYS.settings, "[]");
    expect(loadContextSettings(storage)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    storage.map.set(CONTEXT_KEYS.settings, '"开"');
    expect(loadContextSettings(storage)).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it("字段级损坏逐项回退默认（类型不符 / 非有限值 / 轮数 < 1）", () => {
    const storage = new FakeStorage();
    storage.write(CONTEXT_KEYS.settings, {
      enabled: "yes",
      budgetTokens: Number.NaN,
      keepRecentTurns: 0,
      llmSummary: 1,
    });
    expect(loadContextSettings(storage)).toEqual(DEFAULT_CONTEXT_SETTINGS);

    storage.write(CONTEXT_KEYS.settings, {
      enabled: false,
      budgetTokens: 12000,
      keepRecentTurns: 12,
      llmSummary: false,
    });
    expect(loadContextSettings(storage)).toEqual({
      enabled: false,
      budgetTokens: 12000,
      keepRecentTurns: 12,
      llmSummary: false,
    });
  });

  it("save 传入非法值不会写坏（逐项回退默认）", () => {
    const storage = new FakeStorage();
    const saved = saveContextSettings({ budgetTokens: Number.NaN, keepRecentTurns: -3 }, storage);
    expect(saved.budgetTokens).toBe(DEFAULT_CONTEXT_SETTINGS.budgetTokens);
    expect(saved.keepRecentTurns).toBe(DEFAULT_CONTEXT_SETTINGS.keepRecentTurns);
  });

  it("storage 抛错时不炸：load 回默认、save 返回合并结果", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    expect(loadContextSettings(storage)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    let saved = DEFAULT_CONTEXT_SETTINGS;
    expect(() => {
      saved = saveContextSettings({ enabled: false }, storage);
    }).not.toThrow();
    expect(saved).toEqual({ ...DEFAULT_CONTEXT_SETTINGS, enabled: false });
    expect(storage.map.size).toBe(0);
  });
});

/* --------------------------------------------------------------- 摘要缓存 */

describe("SummaryCache：本机摘要缓存", () => {
  it("键名与往返：set 后 get 命中，未命中返回 undefined", () => {
    const storage = new FakeStorage();
    const cache = new SummaryCache(storage, makeClock().now);
    expect(CONTEXT_KEYS.summaries).toBe("heming.contextSummaries.v1");
    const fp = cache.fingerprint("conv-1", olderOf(1));
    expect(cache.get("conv-1", fp)).toBeUndefined();
    cache.set("conv-1", fp, "摘要正文");
    expect(cache.get("conv-1", fp)).toBe("摘要正文");
    expect(storage.read(CONTEXT_KEYS.summaries)).toEqual({
      "conv-1": { [fp]: { summary: "摘要正文", at: 1000 } },
    });
  });

  it("新建实例从本机水合（模拟刷新）", () => {
    const storage = new FakeStorage();
    const fp = new SummaryCache(storage).fingerprint("conv-1", olderOf(1));
    new SummaryCache(storage).set("conv-1", fp, "摘要");
    expect(new SummaryCache(storage).get("conv-1", fp)).toBe("摘要");
  });

  it("会话隔离：同指纹在不同会话互不可见", () => {
    const cache = new SummaryCache(new FakeStorage());
    const fp = cache.fingerprint("conv-1", olderOf(1));
    cache.set("conv-1", fp, "摘要");
    expect(cache.get("conv-2", fp)).toBeUndefined();
  });

  it("指纹：稳定、含会话与条数、内容变了就变", () => {
    const cache = new SummaryCache(new FakeStorage());
    const older = conversation(2, 10);
    expect(cache.fingerprint("c", older)).toBe(cache.fingerprint("c", older));
    expect(cache.fingerprint("c", older)).not.toBe(cache.fingerprint("c", conversation(3, 10)));
    expect(cache.fingerprint("c1", older)).not.toBe(cache.fingerprint("c2", older));
    expect(cache.fingerprint("c", [])).toBeTruthy();
    // 条数/总长完全相同、内容不同 → 仍须区分（否则会复用过期摘要）
    const a = [msg("user", "aaaa"), msg("assistant", "bbbb")];
    const b = [msg("user", "bbbb"), msg("assistant", "aaaa")];
    expect(cache.fingerprint("c", a)).not.toBe(cache.fingerprint("c", b));
  });

  it(`每会话上限 ${SUMMARY_CACHE_LIMIT} 条：按 at 最旧先淘汰`, () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const cache = new SummaryCache(storage, clock.now);
    const fps: string[] = [];
    for (let i = 1; i <= SUMMARY_CACHE_LIMIT; i++) {
      const fp = cache.fingerprint("conv-1", olderOf(i));
      fps.push(fp);
      cache.set("conv-1", fp, `摘要 ${i}`);
      clock.tick();
    }
    expect(cache.get("conv-1", fps[0])).toBe("摘要 1"); // 命中不改变淘汰顺序
    const newest = cache.fingerprint("conv-1", olderOf(SUMMARY_CACHE_LIMIT + 1));
    cache.set("conv-1", newest, "最新摘要");

    const saved = storage.read<Record<string, Record<string, { summary: string }>>>(CONTEXT_KEYS.summaries)!;
    expect(Object.keys(saved["conv-1"])).toHaveLength(SUMMARY_CACHE_LIMIT);
    expect(cache.get("conv-1", fps[0])).toBeUndefined();
    expect(cache.get("conv-1", fps[1])).toBe("摘要 2");
    expect(cache.get("conv-1", newest)).toBe("最新摘要");
  });

  it("总 JSON 超 1.2MB 时全局淘汰最旧（跨会话）", () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const cache = new SummaryCache(storage, clock.now);
    const big = "a".repeat(60_000);
    const aFps: string[] = [];
    for (let i = 0; i < SUMMARY_CACHE_LIMIT; i++) {
      const fp = cache.fingerprint("conv-a", olderOf(i));
      aFps.push(fp);
      cache.set("conv-a", fp, `${i}-${big}`);
      clock.tick();
    }
    const bFp = cache.fingerprint("conv-b", olderOf(99));
    cache.set("conv-b", bFp, big);

    expect(cache.get("conv-b", bFp)).toBe(big); // 新写入的不被自己挤掉
    expect(cache.get("conv-a", aFps[0])).toBeUndefined(); // 全局最旧先走
    expect(cache.get("conv-a", aFps[SUMMARY_CACHE_LIMIT - 1])).toBe(`${SUMMARY_CACHE_LIMIT - 1}-${big}`);
    expect(storage.getItem(CONTEXT_KEYS.summaries)!.length).toBeLessThanOrEqual(Math.floor(1.2 * 1024 * 1024));
  });

  it("clear：按会话清 vs 全清", () => {
    const storage = new FakeStorage();
    const cache = new SummaryCache(storage);
    const fp1 = cache.fingerprint("conv-1", olderOf(1));
    const fp2 = cache.fingerprint("conv-2", olderOf(2));
    cache.set("conv-1", fp1, "一");
    cache.set("conv-2", fp2, "二");

    cache.clear("conv-1");
    expect(cache.get("conv-1", fp1)).toBeUndefined();
    expect(cache.get("conv-2", fp2)).toBe("二");

    cache.clear();
    expect(cache.get("conv-2", fp2)).toBeUndefined();
    expect(storage.getItem(CONTEXT_KEYS.summaries)).toBeNull();
  });

  it("损坏回退空缓存（非法 JSON / 数组 / 条目结构不符）", () => {
    const storage = new FakeStorage();
    storage.map.set(CONTEXT_KEYS.summaries, "{oops");
    expect(new SummaryCache(storage).get("conv-1", "fp")).toBeUndefined();

    storage.map.set(CONTEXT_KEYS.summaries, '"字符串"');
    expect(new SummaryCache(storage).get("conv-1", "fp")).toBeUndefined();

    storage.write(CONTEXT_KEYS.summaries, { "conv-1": { fp: { summary: 42, at: 1 } } });
    expect(new SummaryCache(storage).get("conv-1", "fp")).toBeUndefined();

    storage.write(CONTEXT_KEYS.summaries, { "conv-1": [] });
    expect(new SummaryCache(storage).get("conv-1", "fp")).toBeUndefined();
  });

  it("写入异常静默：配额爆掉时不炸、内存态仍可用", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const cache = new SummaryCache(storage, () => 1000);
    const fp = cache.fingerprint("conv-1", olderOf(1));
    expect(() => cache.set("conv-1", fp, "摘要")).not.toThrow();
    expect(cache.get("conv-1", fp)).toBe("摘要");
    expect(storage.map.size).toBe(0);
  });
});

/* -------------------------------------------------------------- 上下文准备 */

/** 压缩档设置：钱够、轮数收紧到 2 轮 → older 必非空。 */
const PLAN_SETTINGS = { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 100_000, keepRecentTurns: 2 };

describe("prepareHistory：五条分支", () => {
  it("分支一：关闭预算 / rows 为空 → 原样返回（同一数组）", async () => {
    const rows = conversation(6);
    const off = await prepareHistory(rows, {
      settings: { ...DEFAULT_CONTEXT_SETTINGS, enabled: false },
    });
    expect(off).toBe(rows);

    const empty: ChatMessage[] = [];
    expect(await prepareHistory(empty, { settings: PLAN_SETTINGS })).toBe(empty);
  });

  it("分支二：older 为空（全放得下）→ 原样返回", async () => {
    const rows = conversation(2);
    const out = await prepareHistory(rows, { settings: PLAN_SETTINGS, reservedTokens: 0 });
    expect(out).toBe(rows);
  });

  it("分支三：压缩 → [system 摘要, ...recent]，骨架标题只出现一次", async () => {
    const rows = conversation(6);
    const snapshot = JSON.parse(JSON.stringify(rows)) as ChatMessage[];
    const out = await prepareHistory(rows, { settings: PLAN_SETTINGS, reservedTokens: 0 });

    expect(out).toHaveLength(5); // 1 条摘要 + 最后 2 轮（4 条）
    expect(out[0].role).toBe("system");
    expect(out[0].content.startsWith(SUMMARY_HEADER)).toBe(true);
    expect(out[0].content).toContain("意图：");
    expect(out[0].content).toContain("结论：");
    expect(out[0].content).toContain("仅作背景");
    expect(out[0].content.split(SUMMARY_HEADER)).toHaveLength(2);
    expect(out.slice(1)).toEqual(rows.slice(8));
    expect(rows).toEqual(snapshot); // 不修改入参
  });

  it("分支三：LLM 摘要命中缓存 → 第二次不再请求", async () => {
    const storage = new FakeStorage();
    const cache = new SummaryCache(storage, makeClock().now);
    const rows = conversation(6);
    let calls = 0;
    let prompts: ChatMessage[][] = [];
    const summarize = async (messages: ChatMessage[]) => {
      calls += 1;
      prompts = [...prompts, messages];
      return "LLM 摘要正文";
    };
    const deps = { settings: PLAN_SETTINGS, cache, reservedTokens: 0, conversationId: "conv-1", summarize };

    const first = await prepareHistory(rows, deps);
    expect(calls).toBe(1);
    expect(first[0].content).toContain("LLM 摘要正文");
    expect(prompts[0][0].content).toContain("只输出"); // 入参即 buildSummaryPrompt 的结果
    expect(prompts[0][1].content).toContain("用户：");

    const second = await prepareHistory(rows, deps);
    expect(calls).toBe(1); // 命中缓存
    expect(second[0].content).toContain("LLM 摘要正文");
    expect(cache.get("conv-1", cache.fingerprint("conv-1", rows.slice(0, 8)))).toBe("LLM 摘要正文");
  });

  it("分支四：LLM 摘要失败 / 返回 null / 空白 → 确定性摘要（不写缓存）", async () => {
    const storage = new FakeStorage();
    const cases = [
      async () => null,
      async () => "   ",
      async () => {
        throw new Error("provider_error: HTTP 400 maximum context length");
      },
      async () => {
        throw new Error("未绑定 LLM 连接");
      },
    ];
    for (const summarize of cases) {
      const cache = new SummaryCache(storage);
      const out = await prepareHistory(conversation(6), {
        settings: PLAN_SETTINGS,
        cache,
        reservedTokens: 0,
        conversationId: "conv-1",
        summarize,
      });
      expect(out[0].content).toContain("意图：");
      expect(out[0].content).toContain("待办：（未提及）"); // 确定性骨架
      expect(storage.getItem(CONTEXT_KEYS.summaries)).toBeNull();
    }
  });

  it("分支四：llmSummary=false 时不发请求，直接用确定性摘要", async () => {
    const rows = conversation(6);
    let calls = 0;
    const out = await prepareHistory(rows, {
      settings: { ...PLAN_SETTINGS, llmSummary: false },
      reservedTokens: 0,
      summarize: async () => {
        calls += 1;
        return "不该被用到";
      },
    });
    expect(calls).toBe(0);
    expect(out[0].content).not.toContain("不该被用到");
    expect(out[0].content).toContain("意图：");
  });

  it("摘要为空串时丢弃摘要，只发 recent（不留空的 system 消息）", async () => {
    const rows = [
      msg("system", "甲"),
      msg("system", "乙"),
      msg("system", "丙"),
      msg("user", "最近一条"),
    ];
    const out = await prepareHistory(rows, {
      settings: { ...PLAN_SETTINGS, keepRecentTurns: 1 },
      reservedTokens: 0,
    });
    expect(out).toEqual([msg("user", "最近一条")]);
    expect(out.some((m) => m.role === "system")).toBe(false);
  });

  it("分支五：任何异常 → 原样返回（缓存指纹抛错 / 设置访问抛错）", async () => {
    const rows = conversation(6);
    class ThrowingCache extends SummaryCache {
      override fingerprint(): string {
        throw new Error("boom");
      }
    }
    const byCache = await prepareHistory(rows, {
      settings: PLAN_SETTINGS,
      reservedTokens: 0,
      cache: new ThrowingCache(new FakeStorage()),
    });
    expect(byCache).toBe(rows);

    const evil = new Proxy({} as Record<string, unknown>, {
      get() {
        throw new Error("boom");
      },
    });
    const bySettings = await prepareHistory(rows, { settings: evil as never });
    expect(bySettings).toBe(rows);
  });

  it("conversationId 缺省也能跑（缓存落在空桶）", async () => {
    const storage = new FakeStorage();
    const cache = new SummaryCache(storage);
    const out = await prepareHistory(conversation(6), {
      settings: PLAN_SETTINGS,
      cache,
      reservedTokens: 0,
      summarize: async () => "无会话键的摘要",
    });
    expect(out[0].content).toContain("无会话键的摘要");
    expect(Object.keys(storage.read<Record<string, unknown>>(CONTEXT_KEYS.summaries) ?? {})).toEqual([""]);
  });
});

describe("prepareHistory：预算与溢出重试收紧", () => {
  it("reservedTokens 从预算里扣除（越多越早进 older）", async () => {
    const rows = conversation(4, 2000);
    const settings = { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 6000, keepRecentTurns: 8 };
    const noReserve = await prepareHistory(rows, { settings, reservedTokens: 0 });
    const withReserve = await prepareHistory(rows, { settings, reservedTokens: 4000 });
    expect(noReserve).toBe(rows); // 全放得下 → 原样
    expect(withReserve.length).toBe(5); // 1 摘要 + 4 条 recent
  });

  it("reservedTokens 缺省按设计上界 900 计", async () => {
    const rows = conversation(4, 2000);
    const settings = { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 4000, keepRecentTurns: 8 };
    expect(DEFAULT_RESERVED_TOKENS).toBe(900);
    expect(await prepareHistory(rows, { settings })).toEqual(
      await prepareHistory(rows, { settings, reservedTokens: DEFAULT_RESERVED_TOKENS }),
    );
    expect((await prepareHistory(rows, { settings })).length).toBe(7);
  });

  it("aggressive=1 半预算半轮数、aggressive=2 四分之一预算 2 轮（逐级更紧）", async () => {
    const rows = conversation(12, 2000);
    const settings = { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 6000, keepRecentTurns: 12 };
    const base = await prepareHistory(rows, { settings, reservedTokens: 0 });
    const once = await prepareHistory(rows, { settings, reservedTokens: 0, aggressive: 1 });
    const twice = await prepareHistory(rows, { settings, reservedTokens: 0, aggressive: 2 });
    expect(once.length).toBeLessThan(base.length);
    expect(twice.length).toBeLessThan(once.length);
    expect(twice.slice(1).map((m) => m.role)).toEqual(["user", "assistant"]); // 只留最后一轮
    expect(twice[0].role).toBe("system"); // 无论多紧，摘要都在
  });
});

describe("normalizeContextSettings：字段级校验", () => {
  it("非对象 / 缺字段回退默认，好字段照用", () => {
    expect(normalizeContextSettings(undefined)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(normalizeContextSettings("开")).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(normalizeContextSettings({ enabled: false, budgetTokens: 8000 })).toEqual({
      ...DEFAULT_CONTEXT_SETTINGS,
      enabled: false,
      budgetTokens: 8000,
    });
  });
});
