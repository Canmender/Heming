import { describe, it, expect, beforeEach } from "vitest";
import {
  DRAFT_PREFIX,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  clearDraft,
  clipDraft,
  createMemoryDraftStorage,
  getDraft,
  pruneDrafts,
  setDraft,
  setDraftStorage,
  type DraftStorage,
} from "./drafts.js";

/**
 * 草稿按会话持久（d.31 · P2-1）。
 *
 * 钉三件事：
 * 1. **不串会话**——A 的草稿不能出现在 B；
 * 2. **不无限长**——单条截尾、会话数 LRU；
 * 3. **不抛**——坏数据 / 存储异常都只是「这条没存上」，不能拦住人打字。
 */
describe("drafts（草稿按会话持久）", () => {
  let memory: ReturnType<typeof createMemoryDraftStorage>;

  beforeEach(() => {
    memory = createMemoryDraftStorage();
    setDraftStorage(memory);
  });

  it("按会话各存各的", () => {
    setDraft("conv-a", "给 A 的草稿");
    setDraft("conv-b", "给 B 的草稿");

    expect(getDraft("conv-a")).toBe("给 A 的草稿");
    expect(getDraft("conv-b")).toBe("给 B 的草稿");
    expect(getDraft("conv-c")).toBe("");
  });

  it("空串 / 纯空白视为删除（发完不留空壳）", () => {
    setDraft("conv-a", "内容");
    setDraft("conv-a", "");
    expect(getDraft("conv-a")).toBe("");
    expect(memory.getItem(`${DRAFT_PREFIX}conv-a`)).toBeNull();

    setDraft("conv-a", "内容");
    setDraft("conv-a", "   \n  ");
    expect(memory.getItem(`${DRAFT_PREFIX}conv-a`)).toBeNull();
  });

  it("清除某会话不影响其它会话", () => {
    setDraft("conv-a", "A");
    setDraft("conv-b", "B");
    clearDraft("conv-a");

    expect(getDraft("conv-a")).toBe("");
    expect(getDraft("conv-b")).toBe("B");
  });

  it("超长草稿截尾到上限并留省略标记", () => {
    const long = "字".repeat(MAX_DRAFT_CHARS + 500);
    setDraft("conv-a", long);

    const stored = getDraft("conv-a");
    expect([...stored].length).toBe(MAX_DRAFT_CHARS);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("clipDraft 按码点切，不把 emoji 劈成半个", () => {
    const emoji = "🙂".repeat(MAX_DRAFT_CHARS + 10);
    const clipped = clipDraft(emoji);
    expect([...clipped].length).toBe(MAX_DRAFT_CHARS);
    // 没有孤立代理项（劈开的半个 emoji 会产生）
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
  });

  it("会话数超过上限时淘汰最久未修改的那条", () => {
    for (let i = 0; i <= MAX_DRAFTS; i += 1) {
      setDraft(`conv-${i}`, `草稿 ${i}`);
    }
    // conv-0 最旧 ⇒ 被淘汰；其余都在
    expect(getDraft("conv-0")).toBe("");
    expect(getDraft("conv-1")).toBe("草稿 1");
    expect(getDraft(`conv-${MAX_DRAFTS}`)).toBe(`草稿 ${MAX_DRAFTS}`);
  });

  it("重新修改会刷新 LRU 顺序", () => {
    for (let i = 0; i < MAX_DRAFTS; i += 1) {
      setDraft(`conv-${i}`, `草稿 ${i}`);
    }
    // 再动一次 conv-0（它就不再是最旧的了），然后新增一条触发淘汰
    setDraft("conv-0", "草稿 0（改过）");
    setDraft("conv-new", "新草稿");

    expect(getDraft("conv-0")).toBe("草稿 0（改过）");
    expect(getDraft("conv-1")).toBe(""); // 现在它最旧
  });

  it("坏 JSON → 读回空串，不抛", () => {
    memory.setItem(`${DRAFT_PREFIX}conv-a`, "{ 不是 json");
    expect(() => getDraft("conv-a")).not.toThrow();
    expect(getDraft("conv-a")).toBe("");
  });

  it("形状不对（不是对象 / text 不是字符串）→ 空串", () => {
    memory.setItem(`${DRAFT_PREFIX}conv-a`, JSON.stringify(["x"]));
    expect(getDraft("conv-a")).toBe("");
    memory.setItem(`${DRAFT_PREFIX}conv-a`, JSON.stringify({ text: 42 }));
    expect(getDraft("conv-a")).toBe("");
  });

  it("存储抛错（配额满 / 隐私模式）→ 不抛", () => {
    const throwing: DraftStorage = {
      get length(): number {
        throw new Error("SecurityError");
      },
      key: () => {
        throw new Error("SecurityError");
      },
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    setDraftStorage(throwing);

    expect(() => setDraft("conv-a", "x")).not.toThrow();
    expect(() => getDraft("conv-a")).not.toThrow();
    expect(() => clearDraft("conv-a")).not.toThrow();
    expect(() => pruneDrafts()).not.toThrow();
  });
});
