import { describe, expect, it } from "vitest";
import { FOCUS_RING, FOCUS_RING_TIGHT, hasFocusRing, withFocusRing } from "./focus.js";

/**
 * 焦点环口径（③-2）：v4 的 `outline-hidden` 会把焦点环抹掉，
 * 凡是抹掉的地方都必须补一条 `focus-visible:outline-*` 才符合 2.4.7。
 */

describe("焦点环工具", () => {
  it("标准环是 focus-visible + outline-2 + offset + ink（不依赖鼠标悬停态）", () => {
    expect(FOCUS_RING).toContain("focus-visible:outline-2");
    expect(FOCUS_RING).toContain("focus-visible:outline-offset-2");
    expect(FOCUS_RING).toContain("focus-visible:outline-ink");
    // 不能用 focus: 前缀：鼠标点击也会出环，反而干扰；键盘才该看到
    expect(FOCUS_RING).not.toMatch(/(^|\s)focus:outline/);
  });

  it("紧凑环保留 outline-2 但不偏移（密集列表不被裁）", () => {
    expect(FOCUS_RING_TIGHT).toContain("focus-visible:outline-2");
    expect(FOCUS_RING_TIGHT).not.toContain("outline-offset");
  });

  it("withFocusRing 追加且不重复追加", () => {
    const base = "rounded-lg border border-line outline-hidden";
    const once = withFocusRing(base);
    expect(hasFocusRing(once)).toBe(true);
    expect(withFocusRing(once)).toBe(once);
  });

  it("hasFocusRing 只认可见环，不把 outline-hidden 当焦点环", () => {
    expect(hasFocusRing("outline-hidden")).toBe(false);
    expect(hasFocusRing("outline-none")).toBe(false);
    expect(hasFocusRing("focus-visible:outline-2")).toBe(true);
  });

  it("禁止使用 v4 的 outline-none（连高对比模式焦点也抹掉）", async () => {
    // 源码扫描守卫：components 里不得出现 `outline-none`（旧的 outline-none 已统一改名 outline-hidden）
    const mods = import.meta.glob("../../components/**/*.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    /** 去掉注释再扫：注释里写「不要用 outline-none」不算违规。 */
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const offenders = Object.entries(mods)
      .filter(([path]) => !path.includes(".test."))
      .filter(([, src]) => /(^|[\s"'`])outline-none(?=[\s"'`]|$)/m.test(stripComments(src)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
