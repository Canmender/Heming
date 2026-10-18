import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Wordmark } from "./Wordmark.js";
import { WORDMARK_STROKES, WORDMARK_VIEWBOX } from "./wordmarkGlyphs.js";

/**
 * 把 path 里的数字按「偶数为 x、奇数为 y」切成坐标点。
 * 成立前提：字形数据只用绝对命令（M/C/L），每个数字都是绝对坐标分量。
 */
function coords(d: string): Array<[number, number]> {
  const nums = (d.match(/-?\d*\.?\d+/g) || []).map(Number);
  expect(nums.length % 2).toBe(0);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

describe("Wordmark", () => {
  it("渲染为可访问的图形（role=img + aria-label）", () => {
    render(<Wordmark />);
    expect(screen.getByRole("img", { name: "Heming" })).toBeTruthy();
  });

  it("笔画数与字形数据一致，且 d 原样落到 path 上", () => {
    const { container } = render(<Wordmark />);
    const paths = [...container.querySelectorAll("path")];
    expect(paths).toHaveLength(WORDMARK_STROKES.length);
    WORDMARK_STROKES.forEach((s, i) => {
      expect(paths[i].getAttribute("d")).toBe(s.d);
    });
  });

  it("用 currentColor 描边（颜色交给使用处的 text-* 类）", () => {
    const { container } = render(<Wordmark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
  });

  it("按 8:3 比例缩放（宽高一致，不拉伸字形）", () => {
    const { container } = render(<Wordmark width={400} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("400");
    expect(svg.getAttribute("height")).toBe("150");
    expect(svg.getAttribute("viewBox")).toBe(WORDMARK_VIEWBOX);
  });
});

describe("字形数据", () => {
  it("所有坐标落在 viewBox 0 0 400 150 内（含 8px 安全边距）", () => {
    for (const s of WORDMARK_STROKES) {
      for (const [x, y] of coords(s.d)) {
        expect(x, `${s.letter} 的 x=${x} 越界`).toBeGreaterThanOrEqual(8);
        expect(x, `${s.letter} 的 x=${x} 越界`).toBeLessThanOrEqual(392);
        expect(y, `${s.letter} 的 y=${y} 越界`).toBeGreaterThanOrEqual(8);
        expect(y, `${s.letter} 的 y=${y} 越界`).toBeLessThanOrEqual(142);
      }
    }
  });

  it("按书写顺序分组：H→e→m→i→n→g，且 i 的点最后落", () => {
    const letters = WORDMARK_STROKES.map((s) => s.letter);
    expect(letters).toEqual([
      "H", "H", "H",
      "e",
      "m", "m", "m", "m",
      "i", "i",
      "n", "n",
      "g", "g",
    ]);
    // i 的两笔：先竖（高），后点（极短）；点必须排在竖之后
    const iStrokes = WORDMARK_STROKES.filter((s) => s.letter === "i");
    expect(iStrokes).toHaveLength(2);
    const dotY = coords(iStrokes[1].d).map(([, y]) => y);
    const stemY = coords(iStrokes[0].d).map(([, y]) => y);
    expect(Math.min(...dotY)).toBeLessThan(Math.min(...stemY));
  });

  it("序列化后的数据可被 font 无关地渲染（每条 path 语法闭合）", () => {
    for (const s of WORDMARK_STROKES) {
      expect(s.d.trim().startsWith("M ")).toBe(true);
      // 不允许出现相对命令或 Z（书写顺序与描边动效都依赖绝对坐标）
      expect(s.d).not.toMatch(/[mlcz]/);
    }
  });
});
