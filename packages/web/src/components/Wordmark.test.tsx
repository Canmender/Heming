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

  it("按书写顺序分组：H→e→m→i→n→g，且 m/n 一笔写完、i 的点最后落", () => {
    const letters = WORDMARK_STROKES.map((s) => s.letter);
    expect(letters).toEqual([
      "H", "H", "H",
      "e",
      "m",
      "i", "i",
      "n",
      "g", "g",
    ]);
    // m 与 n 各为一笔（手写时一笔连写，不是「竖 + 若干拱」分开画）
    expect(WORDMARK_STROKES.filter((s) => s.letter === "m")).toHaveLength(1);
    expect(WORDMARK_STROKES.filter((s) => s.letter === "n")).toHaveLength(1);
    // i 的两笔：先竖（高），后点（极短）；点必须排在竖之后
    const iStrokes = WORDMARK_STROKES.filter((s) => s.letter === "i");
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

// ── 两个踩过的坑，用几何断言钉死 ──

/** 沿 path 密集采样（只处理绝对 M/L/C），用于判断「某条边上有没有留空」。 */
function denseSample(d: string, perSeg = 24): Array<[number, number]> {
  const tk = d.match(/[MLC]|-?\d*\.?\d+/g) || [];
  const out: Array<[number, number]> = [];
  let i = 0;
  let cur: [number, number] = [0, 0];
  const num = () => Number(tk[i++]);
  const cubic = (
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    t: number,
  ): [number, number] => {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  };
  let cmd: string | null = null;
  while (i < tk.length) {
    if (/^[MLC]$/.test(tk[i])) cmd = tk[i++];
    else if (cmd === null) break;
    if (cmd === "M") {
      cur = [num(), num()];
      out.push(cur);
    } else if (cmd === "L") {
      const p: [number, number] = [num(), num()];
      for (let s = 1; s <= perSeg; s++) {
        out.push([cur[0] + ((p[0] - cur[0]) * s) / perSeg, cur[1] + ((p[1] - cur[1]) * s) / perSeg]);
      }
      cur = p;
    } else if (cmd === "C") {
      const c1: [number, number] = [num(), num()];
      const c2: [number, number] = [num(), num()];
      const p: [number, number] = [num(), num()];
      for (let s = 1; s <= perSeg; s++) out.push(cubic(cur, c1, c2, p, s / perSeg));
      cur = p;
    } else break;
  }
  return out;
}

describe("字形回归（两个已修缺陷）", () => {
  it("e 的右下必须开口：右腰在中横与底部起笔之间留空（连通就成了「8」）", () => {
    const d = WORDMARK_STROKES.find((s) => s.letter === "e")!.d;
    const pts = denseSample(d);
    const maxX = Math.max(...pts.map(([x]) => x));
    // 只看最右侧一条窄带上的点：正常 e 在这里分成上下两簇（上簇＝眼右壁，下簇＝起笔端）
    const rightYs = pts
      .filter(([x]) => x >= maxX - 4)
      .map(([, y]) => y)
      .sort((a, b) => a - b);
    let gap = 0;
    for (let i = 1; i < rightYs.length; i++) gap = Math.max(gap, rightYs[i] - rightYs[i - 1]);
    expect(gap, `最右窄带上的最大 y 间隔只有 ${gap}，右腰可能上下连通成「8」`).toBeGreaterThan(5);
  });

  it("m/n 的肩弧要有足够弧高（太浅会变成竖笔上的小凸起，整字像栅栏）", () => {
    for (const letter of ["m", "n"]) {
      const d = WORDMARK_STROKES.find((s) => s.letter === letter)!.d;
      // 形状无关的判据：path 里必须存在一段**纵向跨度足够大**的曲线 —— 那就是肩弧。
      // 逐段解析而不是看整体 bbox，否则「竖笔拉长」会把浅肩的缺陷掩盖掉。
      const tk = d.match(/[MLC]|-?\d*\.?\d+/g) || [];
      let i = 0;
      let cur: [number, number] = [0, 0];
      let maxArc = 0;
      const num = () => Number(tk[i++]);
      let cmd: string | null = null;
      while (i < tk.length) {
        if (/^[MLC]$/.test(tk[i])) cmd = tk[i++];
        else if (cmd === null) break;
        if (cmd === "M") cur = [num(), num()];
        else if (cmd === "L") cur = [num(), num()];
        else if (cmd === "C") {
          const c1: [number, number] = [num(), num()];
          const c2: [number, number] = [num(), num()];
          const p: [number, number] = [num(), num()];
          const ys: number[] = [];
          for (let s = 0; s <= 24; s++) {
            const t = s / 24;
            const u = 1 - t;
            ys.push(
              u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1],
            );
          }
          maxArc = Math.max(maxArc, Math.max(...ys) - Math.min(...ys));
          cur = p;
        } else break;
      }
      expect(
        maxArc,
        `${letter} 最"高"的一段曲线只有 ${maxArc.toFixed(1)} 单位纵向跨度，肩太浅`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it("e/m/n 的顶部齐 x-height（不齐会显得大小不一）", () => {
    const tops = ["e", "m", "n"].map((letter) => {
      const d = WORDMARK_STROKES.find((s) => s.letter === letter)!.d;
      return Math.min(...coords(d).map(([, y]) => y));
    });
    const spread = Math.max(...tops) - Math.min(...tops);
    expect(spread, `e/m/n 的顶高相差 ${spread} 单位`).toBeLessThanOrEqual(3);
  });
});
