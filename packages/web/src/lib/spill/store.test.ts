import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SPILL_ITEMS,
  MAX_SPILL_TOTAL_CHARS,
  SPILL_PREVIEW_CHARS,
  SPILL_READ_MAX,
  listSpills,
  readSpill,
  resetSpills,
  spillText,
  spillTotalChars,
} from "./store.js";

beforeEach(() => {
  resetSpills();
});

describe("溢出存储（spill）", () => {
  it("存一条后能按字符窗口读回，且 hasMore 正确", () => {
    const text = "0123456789";
    const { id, chars, preview } = spillText(text);
    expect(chars).toBe(10);
    expect(preview).toBe(text);

    const first = readSpill(id, 0, 4);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toBe("0123");
    expect(first.total).toBe(10);
    expect(first.hasMore).toBe(true);

    const rest = readSpill(id, 4, 100);
    expect(rest.ok).toBe(true);
    if (!rest.ok) return;
    expect(rest.text).toBe("456789");
    expect(rest.hasMore).toBe(false);
  });

  it("默认窗口是 8000，超过上限会被压到 40000", () => {
    const id = spillText("x".repeat(SPILL_READ_MAX + 5000)).id;
    const def = readSpill(id);
    expect(def.ok).toBe(true);
    if (def.ok) expect(def.limit).toBe(8000);
    const big = readSpill(id, 0, 999_999);
    expect(big.ok).toBe(true);
    if (big.ok) expect(big.limit).toBe(SPILL_READ_MAX);
  });

  it("id 不存在时必须报错，不能返回空串（空串会被模型当成「读过了」）", () => {
    const gone = readSpill("spill-999", 0, 10);
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.error_code).toBe("spill-not-found");
    expect(gone.hint).toContain("重新取");
  });

  it("offset 越界与非法 limit 都报参数错，并说明范围", () => {
    const id = spillText("abc").id;
    const past = readSpill(id, 10);
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.error_code).toBe("spill-invalid-args");
      expect(past.hint).toContain("共 3 字符");
    }
    const zero = readSpill(id, 0, 0);
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error_code).toBe("spill-invalid-args");
  });

  it("缺 id 时报参数错", () => {
    const empty = readSpill("  ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error_code).toBe("spill-invalid-args");
  });

  it("预览只给头部 1200 字符（不把全文塞回上下文）", () => {
    const { preview } = spillText("A".repeat(SPILL_PREVIEW_CHARS + 500));
    expect(preview).toHaveLength(SPILL_PREVIEW_CHARS);
  });

  it("条数超过上限时淘汰最旧的（先存的先丢）", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_SPILL_ITEMS + 3; i += 1) ids.push(spillText(`item-${i}`).id);
    expect(listSpills()).toHaveLength(MAX_SPILL_ITEMS);
    expect(readSpill(ids[0]).ok).toBe(false);
    expect(readSpill(ids[ids.length - 1]).ok).toBe(true);
  });

  it("总字符超过上限时按最旧淘汰，直到回到上限内", () => {
    const chunk = "z".repeat(MAX_SPILL_TOTAL_CHARS / 4 + 10);
    for (let i = 0; i < 5; i += 1) spillText(chunk);
    expect(spillTotalChars()).toBeLessThanOrEqual(MAX_SPILL_TOTAL_CHARS);
    expect(listSpills().length).toBeGreaterThan(0);
    expect(listSpills().length).toBeLessThan(5);
  });

  it("reset 之后连 id 序列也从头开始（测试可复现）", () => {
    spillText("a");
    resetSpills();
    expect(spillText("b").id).toBe("spill-1");
  });
});
