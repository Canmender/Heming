import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../llmClient.js";
import type { StorageLike } from "../memory/types.js";
import { IMAGE_TOKEN_COST, estimateRowTokens, estimateRowsTokens, estimateTokens } from "./tokens.js";
import { DEFAULT_RESERVED_TOKENS, planContext } from "./budget.js";
import { SUMMARY_HEADER, buildSummaryPrompt, deterministicSummary } from "./summary.js";
import {
  CONTEXT_KEYS,
  DEFAULT_CONTEXT_SETTINGS,
  loadContextSettings,
  normalizeContextSettings,
  saveContextSettings,
} from "./settings.js";
import { SUMMARY_CACHE_BYTES, SUMMARY_CACHE_LIMIT, SummaryCache, summaryDataByteLength } from "./store.js";
import { utf8Length } from "../memory/storage.js";
import type { SummaryCacheData } from "./types.js";
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

  // d.412.4.183：estimateTokens 从 for...of 改成下标循环后，用一个独立的参考实现
  // （就是原来的算法）钉住「口径逐字节不变」——覆盖全 BMP、补充平面边界、孤立代理
  // 与随机混合串，防止将来再改实现时悄悄改变估算口径（那会让压缩切点漂移）。
  it("下标循环版与 for...of 参考实现逐字节等价（d.412.4.183）", () => {
    const isWide = (cp: number): boolean =>
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303f) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3ffff);
    const reference = (text: string): number => {
      if (!text) return 0;
      let tokens = 0;
      let ascii = 0;
      let other = 0;
      const flush = () => {
        tokens += Math.ceil(ascii / 4) + Math.ceil(other / 2);
        ascii = 0;
        other = 0;
      };
      for (const ch of text) {
        const cp = ch.codePointAt(0) as number;
        if (isWide(cp)) {
          flush();
          tokens += 1;
        } else if (cp < 0x80) {
          ascii += 1;
        } else {
          other += 1;
        }
      }
      flush();
      return tokens;
    };

    // 全 BMP 逐码点
    for (let cp = 0; cp < 0x10000; cp += 1) {
      const s = String.fromCharCode(cp);
      expect(estimateTokens(s), `BMP U+${cp.toString(16)}`).toBe(reference(s));
    }
    // 补充平面边界 + 孤立代理
    const special = [0x10000, 0x1f600, 0x20000, 0x2ffff, 0x30000, 0x3ffff, 0x40000, 0x10ffff];
    for (const cp of special) {
      const s = String.fromCodePoint(cp);
      expect(estimateTokens(s), `astral U+${cp.toString(16)}`).toBe(reference(s));
    }
    for (const s of ["\ud800", "\udc00", "a\ud800b", "\ud800\ud800", "x\udc00y"]) {
      expect(estimateTokens(s)).toBe(reference(s));
    }
    // 随机混合串（固定种子，可复现）
    let seed = 20261121;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 3000; k += 1) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 40);
      for (let j = 0; j < len; j += 1) {
        const r = rnd();
        let cp: number;
        if (r < 0.4) cp = 32 + Math.floor(rnd() * 95);
        else if (r < 0.7) cp = 0x4e00 + Math.floor(rnd() * 0x100);
        else if (r < 0.85) cp = 0x3041 + Math.floor(rnd() * 0x100);
        else if (r < 0.95) cp = 0x1f300 + Math.floor(rnd() * 0x100);
        else cp = 1 + Math.floor(rnd() * 0x3000);
        s += String.fromCodePoint(cp);
      }
      expect(estimateTokens(s), `random #${k}`).toBe(reference(s));
    }
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

  it("带图的历史行按图片成本计（不再按 4 token 算成免费）", () => {
    const withImage = {
      role: "user" as const,
      content: "",
      contentParts: [
        { type: "image" as const, mime: "image/png", data: "AAA" },
        { type: "text" as const, text: "看看这张" },
      ],
    };
    // 图片固定成本 + 文字 token + 结构开销
    expect(estimateRowTokens(withImage)).toBe(IMAGE_TOKEN_COST + estimateTokens("看看这张") + 4);
    expect(estimateRowsTokens([withImage])).toBe(estimateRowTokens(withImage));
    // 纯文本行口径没变
    expect(estimateRowsTokens([msg("user", "abcd")])).toBe(1 + 4);
  });

  it("内容片只有文本时按文本计，不额外叠正文", () => {
    const row = {
      role: "user" as const,
      content: "这段正文不该再算一遍",
      contentParts: [{ type: "text" as const, text: "abc" }],
    };
    expect(estimateRowTokens(row)).toBe(1 + 4);
  });

  it("assistant 的工具调用参数也计入预算（历史里 arguments 可能几万字符）", () => {
    const args = JSON.stringify({ path: "a.md", patch: "x".repeat(4000) });
    const row = {
      role: "assistant" as const,
      content: "我改一下",
      tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "self__edit", arguments: args } }],
    };
    // 结构 + 正文 + 调用结构 + 工具名 + 参数
    const expected = 4 + estimateTokens("我改一下") + 8 + estimateTokens("self__edit") + estimateTokens(args);
    expect(estimateRowTokens(row)).toBe(expected);
    // 参数长到几千字符时，估算必须明显大于「只看正文」——正是以前漏掉的那部分
    expect(estimateRowTokens(row)).toBeGreaterThan(4 + estimateTokens("我改一下") + 1000);
  });

  it("工具结果行的 name 与 tool_call_id 也计入（虽然不大，但口径要一致）", () => {
    const row = {
      role: "tool" as const,
      content: "结果",
      tool_call_id: "call_1",
      name: "echo",
    };
    expect(estimateRowTokens(row)).toBe(4 + estimateTokens("结果") + estimateTokens("call_1") + estimateTokens("echo"));
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

  it("切点按整条成本算：正文短但 tool_calls 巨大的消息不能当成便宜行塞进 recent（d.412 回归）", () => {
    // assistant 正文只有「好的」，但 tool_calls.arguments 4000 字符 ≈ 1000 token。
    // 旧口径只看 content，把它当 2 token 的便宜行保留 → recent 实际 1000+ token 远超预算。
    const heavy = msg("assistant", "好的");
    heavy.tool_calls = [
      {
        id: "call_1",
        type: "function" as const,
        function: { name: "f", arguments: "x".repeat(4000) },
      },
    ];
    const rows = [msg("user", "问题"), heavy];

    // 预算只够放一条便宜消息；超重的 assistant 行必须进 older（连同它的 user 轮）
    const result = planContext(rows, { budgetTokens: 20, keepRecentTurns: 8, reservedTokens: 0 });
    expect(result.recent).toEqual([]);
    expect(result.older).toEqual(rows);
    // 与对外报数口径一致：recent 的估算成本真的在预算内
    expect(estimateRowsTokens(result.recent)).toBeLessThanOrEqual(20);
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

  it("英文句点作句末也能断首句，且不把小数/版本号劈开", () => {
    const out = deterministicSummary([msg("assistant", "Done. Next step is to deploy.")]);
    expect(out.split("\n")[2]).toBe("结论：Done");
    const versioned = deterministicSummary([msg("assistant", "升级到 d.412.4 版本。然后重启。")]);
    expect(versioned.split("\n")[2]).toBe("结论：升级到 d.412.4 版本");
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

  it("工具结果进转写且署名「工具」，超长截断（P2-10：摘要不再丢工具结论）", () => {
    const toolRow = {
      role: "tool" as const,
      tool_call_id: "c1",
      name: "srv__query",
      content: `查询到 42 条记录：${"字".repeat(500)}`,
    };
    const prompt = buildSummaryPrompt([msg("user", "查一下"), toolRow]);
    const body = prompt[1].content;
    // 工具输出以「工具：」署名进提示词（以前会标成「其他」或被整段丢掉）
    expect(body).toContain("工具：查询到 42 条记录");
    expect(body).toContain("工具输出已截断");
    expect(body).not.toContain("字".repeat(300));
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
      autoBudget: true,
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
    expect(saved).toEqual({ enabled: false, budgetTokens: 6000, keepRecentTurns: 4, llmSummary: false, autoBudget: true });
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
      autoBudget: true,
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

  it("指纹含工具调用与内容片：正文相同但 tool_calls 不同也不能复用旧摘要（d.412 回归）", () => {
    const cache = new SummaryCache(new FakeStorage());
    // 两条正文完全一样，但工具调用一个是读文件、一个是删文件——语义完全不同
    const tool = (name: string, args: string) => [
      { id: "call_1", type: "function" as const, function: { name, arguments: args } },
    ];
    const readHistory = [msg("user", "帮我看看"), { ...msg("assistant", "好的"), tool_calls: tool("read_file", '{"path":"/etc/passwd"}') }];
    const deleteHistory = [msg("user", "帮我看看"), { ...msg("assistant", "好的"), tool_calls: tool("delete_file", '{"path":"important.txt"}') }];
    expect(cache.fingerprint("c", readHistory)).not.toBe(cache.fingerprint("c", deleteHistory));
    // tool_call_id / name 变化也要区分
    const withCallId = [msg("user", "帮我看看"), { ...msg("assistant", "好的"), tool_call_id: "tc-1" }];
    expect(cache.fingerprint("c", [msg("user", "帮我看看"), msg("assistant", "好的")])).not.toBe(cache.fingerprint("c", withCallId));
    // 图片内容片与纯文本正文的指纹必须不同（同样 1 行、同样正文，只有内容片不同）
    const textOnly = [{ ...msg("user", "abc") }];
    const withImage = [{ ...msg("user", "abc"), contentParts: [{ type: "image" as const, mime: "image/png", data: "AAAA" }] }];
    expect(cache.fingerprint("c", textOnly)).not.toBe(cache.fingerprint("c", withImage));
  });

  it("指纹含中间消息的 role：正文相同但助手/工具角色不同也不能复用旧摘要（d.412 回归）", () => {
    const cache = new SummaryCache(new FakeStorage());
    // 首末都是 user 且正文逐字相同，只有中间一条的 role 不同。
    // 摘要按角色归类（用户意图/助手结论/工具输出），角色不同摘要就不同，
    // 指纹必须区分开——否则缓存命中会把另一类角色的摘要套用过来。
    const withAssistant = [msg("user", "开头"), msg("assistant", "中间正文"), msg("user", "结尾")];
    const withTool = [msg("user", "开头"), msg("tool", "中间正文"), msg("user", "结尾")];
    expect(cache.fingerprint("c", withAssistant)).not.toBe(cache.fingerprint("c", withTool));
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

  it("summaryDataByteLength 与 utf8Length(JSON.stringify) 逐字节一致（d.412.4.181 增量记账正确性）", () => {
    const samples: SummaryCacheData[] = [
      {},
      { "conv-1": { fp1: { summary: "摘要", at: 1000 } } },
      {
        "会话-甲": {
          a: { summary: "x".repeat(500), at: 1 },
          "指纹|带\\引号\"": { summary: "中文😀emoji", at: 1234567890 },
        },
        conv2: { b: { summary: "", at: 0 }, c: { summary: "line\nbreak\t|\"{}", at: -5 } },
      },
    ];
    for (const data of samples) {
      expect(summaryDataByteLength(data)).toBe(utf8Length(JSON.stringify(data)));
    }
    // 多桶、多条目、随机长度再交叉验证一次
    const big: SummaryCacheData = {};
    for (let c = 0; c < 5; c++) {
      const bucket: Record<string, { summary: string; at: number }> = {};
      for (let f = 0; f < 7; f++) {
        bucket[`fp-${c}-${f}`] = { summary: "字".repeat((c + f) * 3), at: (c * 7 + f) * 1000 };
      }
      big[`conv-${c}`] = bucket;
    }
    expect(summaryDataByteLength(big)).toBe(utf8Length(JSON.stringify(big)));
  });

  it("全局淘汰后：实际落盘字节 ≤ 上限，且淘汰的是最旧条目（顺序语义不变）", () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const cache = new SummaryCache(storage, clock.now);
    const big = "a".repeat(40_000);
    const aFps: string[] = [];
    for (let i = 0; i < SUMMARY_CACHE_LIMIT; i++) {
      const fp = cache.fingerprint("conv-a", olderOf(i));
      aFps.push(fp);
      cache.set("conv-a", fp, `${i}-${big}`);
      clock.tick();
    }
    const bFps: string[] = [];
    for (let i = 0; i < SUMMARY_CACHE_LIMIT; i++) {
      const fp = cache.fingerprint("conv-b", olderOf(50 + i));
      bFps.push(fp);
      cache.set("conv-b", fp, `b${i}-${big}`);
      clock.tick();
    }
    // 新写入的 conv-b 末尾条目一定在；最旧的 conv-a[0] 已被淘汰
    expect(cache.get("conv-b", bFps[bFps.length - 1])).toBe(`b${SUMMARY_CACHE_LIMIT - 1}-${big}`);
    expect(cache.get("conv-a", aFps[0])).toBeUndefined();
    // 落盘字节不超上限，且增量记账与真实序列化一致
    const raw = storage.getItem(CONTEXT_KEYS.summaries)!;
    expect(utf8Length(raw)).toBeLessThanOrEqual(SUMMARY_CACHE_BYTES);
    const parsed = JSON.parse(raw) as SummaryCacheData;
    expect(summaryDataByteLength(parsed)).toBe(utf8Length(raw));
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

  it("溢出重试必须真的变短：历史本来就放得下时，aggressive 强制只留最后一轮原文", async () => {
    const rows = conversation(2); // 4 条，按 PLAN_SETTINGS 预算全放得下
    const first = await prepareHistory(rows, { settings: PLAN_SETTINGS, reservedTokens: 0 });
    expect(first).toBe(rows); // 首次：不需要压缩

    const retried = await prepareHistory(rows, {
      settings: PLAN_SETTINGS,
      reservedTokens: 0,
      aggressive: 1,
    });
    // 重试轮不能原样再发一遍（那样只会撞同一个 400）：摘要 + 最后一轮
    expect(retried).not.toBe(rows);
    expect(retried[0].role).toBe("system");
    expect(retried[0].content).toContain("意图：");
    expect(retried.slice(1)).toEqual(rows.slice(2));
  });

  it("切点保护：recent 以 role=tool 开头时丢掉孤儿工具行（供应商会 400）", async () => {
    const rows: ChatMessage[] = [
      msg("user", "旧问题"),
      {
        role: "assistant",
        content: "我查一下",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", name: "f", content: "工具结果" },
      msg("user", "新问题"),
      msg("assistant", "新回答"),
    ];
    // 预算刚好放得下最后三条（tool + user + assistant），切点落在 assistant(tool_calls) 之后：
    // 那条 assistant 进了摘要，如果原样把 tool 发出去，就是「没有对应 tool_call 的 tool 消息」。
    const budget = total(rows.slice(2));
    const out = await prepareHistory(rows, {
      settings: { ...PLAN_SETTINGS, budgetTokens: budget, keepRecentTurns: 8 },
      reservedTokens: 0,
    });

    expect(out[0].role).toBe("system");
    expect(out.slice(1).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out[1].content).toBe("新问题");
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

