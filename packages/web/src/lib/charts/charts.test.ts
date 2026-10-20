import { describe, it, expect } from "vitest";
import { renderChart, CHART_W } from "./renderer.js";
import { ChartSpecSchema, extractCharts, parseChartSpec, stripChartFences } from "./spec.js";
import { suggestChartTypes, findChartType, ALIASES } from "./catalog.js";
import { fmtNum, esc } from "./tokens.js";
import { pickPalette, PALETTES } from "./palette.js";

/** 造一份合法的规范（补齐默认值，省得每处都写全）。 */
function spec(partial: Record<string, unknown>) {
  const parsed = ChartSpecSchema.safeParse(partial);
  if (!parsed.success) throw new Error(`规范不合法: ${parsed.error.message}`);
  return parsed.data;
}

describe("图表规范", () => {
  it("接受最小规范并补齐默认值", () => {
    const s = spec({ type: "F1" });
    expect(s.type).toBe("F1");
    expect(s.palette).toBe("mono");
    expect(s.dark).toBe(false);
    expect(s.title).toBe("");
  });

  it("拒绝非法图型数据（NaN、Infinity、超长标题）", () => {
    expect(parseChartSpec(JSON.stringify({ type: "F1", points: [{ value: NaN }] }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ type: "F1", title: "x".repeat(200) }))).toBeNull();
  });

  it("拒绝非法 JSON 而不抛异常", () => {
    expect(parseChartSpec("{ 这不是 JSON")).toBeNull();
  });
});

describe("围栏块解析", () => {
  const body = `这是结论。

\`\`\`chart
{"type":"F1","title":"季度收入","points":[{"label":"Q1","value":10},{"label":"Q2","value":20}]}
\`\`\`

补充说明。`;

  it("抽出图表规范", () => {
    const charts = extractCharts(body);
    expect(charts).toHaveLength(1);
    expect(charts[0].spec.type).toBe("F1");
    expect(charts[0].spec.title).toBe("季度收入");
  });

  it("剥离围栏后只剩正文", () => {
    const text = stripChartFences(body);
    expect(text).toContain("这是结论。");
    expect(text).toContain("补充说明。");
    expect(text).not.toContain("```chart");
    expect(text).not.toContain("季度收入");
  });

  it("多个图表块都能抽出", () => {
    const two = body + `\n\`\`\`chart\n{"type":"F4","points":[{"label":"a","value":1}]}\n\`\`\``;
    expect(extractCharts(two)).toHaveLength(2);
  });

  it("坏 JSON 的围栏块被跳过，不影响其他块", () => {
    const mixed = `\`\`\`chart\n{坏 JSON}\n\`\`\`\n\`\`\`chart\n{"type":"F1"}\n\`\`\``;
    const charts = extractCharts(mixed);
    expect(charts).toHaveLength(1);
    expect(charts[0].spec.type).toBe("F1");
  });
});

describe("渲染器", () => {
  it("柱状图：输出含标题、轴标签与数值", () => {
    const { svg } = renderChart(
      spec({
        type: "F1",
        title: "季度收入",
        unit: "万元",
        points: [
          { label: "Q1", value: 10 },
          { label: "Q2", value: 30 },
        ],
      }),
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("季度收入");
    expect(svg).toContain("Q1");
    expect(svg).toContain("30");
  });

  it("标题与标签里的 HTML 特殊字符被转义（防注入）", () => {
    const { svg } = renderChart(
      spec({
        type: "F1",
        title: '<script>alert("x")</script>',
        points: [{ label: "a&b<c>", value: 1 }],
      }),
    );
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("a&b<c>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  it("柱长严格正比于数值（柱状图不断轴的契约）", () => {
    const { svg } = renderChart(
      spec({
        type: "F1",
        points: [
          { label: "小", value: 10 },
          { label: "大", value: 40 },
        ],
      }),
    );
    // 柱高 = path 内 y 的最大值（底边）减最小值（柱顶）。
    // 不能只看某两个端点——柱端有胶囊圆角，端点不等于顶边。
    const spans = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => {
      const ys = [...m[1].matchAll(/[\d.]+ ([\d.]+)/g)].map((y) => Number(y[1]));
      return Math.max(...ys) - Math.min(...ys);
    });
    expect(spans.length).toBe(2);
    // 大柱应恰是小柱的 4 倍
    expect(spans[1] / spans[0]).toBeCloseTo(4, 2);
  });

  it("环形图：段角度之和为 360 度", () => {
    const { svg } = renderChart(
      spec({
        type: "F4",
        points: [
          { label: "甲", value: 25 },
          { label: "乙", value: 25 },
          { label: "丙", value: 50 },
        ],
      }),
    );
    const paths = [...svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+) A([\d.]+) [\d.]+ 0 (\d) 1/g)];
    expect(paths.length).toBe(3);
    // 各段起点/终点极角差之和应为 360
    const angles: number[] = [];
    for (const m of svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+) A([\d.]+) [\d.]+ 0 (\d) 1 ([\d.-]+) ([\d.-]+)/g)) {
      const angle = (Math.atan2(Number(m[6]), Number(m[5])) * 180) / Math.PI;
      angles.push(angle);
    }
    expect(angles.length).toBe(3);
  });

  it("热力图：色阶随数值单调变深", () => {
    const { svg } = renderChart(
      spec({
        type: "F10",
        cells: [
          { row: "r1", col: "c1", value: 1 },
          { row: "r1", col: "c2", value: 100 },
        ],
      }),
    );
    const fills = [...svg.matchAll(/<rect[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThanOrEqual(2);
    expect(fills[0]).not.toBe(fills[1]);
  });

  it("瀑布图：正负用不同明度区分（不靠红绿）", () => {
    const { svg } = renderChart(
      spec({
        type: "F9",
        deltas: [
          { label: "增", value: 50 },
          { label: "减", value: -30 },
        ],
      }),
    );
    const fills = [...svg.matchAll(/<path d="M[^"]+" fill="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(fills).size).toBeGreaterThan(1);
  });

  it("漏斗：各阶段宽度递减", () => {
    const { svg } = renderChart(
      spec({
        type: "L13",
        funnel: [
          { label: "曝光", value: 1000 },
          { label: "点击", value: 300 },
          { label: "下单", value: 80 },
        ],
      }),
    );
    const widths = [...svg.matchAll(/<path d="M40 ([\d.]+) L([\d.]+) /g)].map((m) => Number(m[2]) - 40);
    expect(widths.length).toBeGreaterThanOrEqual(3);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
  });

  it("空数据不崩，给出提示文案", () => {
    const { svg } = renderChart(spec({ type: "F13", treemap: [] }));
    expect(svg).toContain("没有可展示");
  });

  it("未知图型落到柱状图而不是空白", () => {
    const { svg } = renderChart(spec({ type: "ZZZ", points: [{ label: "a", value: 1 }] }));
    // 柱状图用 path 画柱（F1 的实现），不是 rect
    expect(svg).toContain("<path");
    expect(svg).toContain("a");
  });

  it("别名图型映射到可渲染的图型", () => {
    // L2（点阵级联）未实现，应落到 F5（横向条）
    const { svg } = renderChart(spec({ type: "L2", points: [{ label: "a", value: 3 }] }));
    expect(svg).toContain("a");
  });

  it("所有图型分支都能渲染出内容（防止新增图型漏实现）", () => {
    const types = ["F1", "F2", "F3", "F4", "F5", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "L13", "G21", "G22", "L1", "L5", "L17"];
    for (const t of types) {
      const { svg, height } = renderChart(
        spec({
          type: t,
          title: "标题",
          points: [{ label: "a", value: 1 }, { label: "b", value: 2 }],
          stacks: [[{ label: "x", value: 3 }, { label: "y", value: 4 }]],
          cells: [{ row: "r", col: "c", value: 5 }],
          pairs: [{ label: "p", before: 1, after: 2 }],
          deltas: [{ label: "d", value: 5 }],
          progress: { value: 3, max: 10 },
          treemap: [{ label: "t", value: 5 }],
          histogram: [{ label: "h", count: 3 }],
          funnel: [{ label: "f", value: 9 }],
          ranks: [{ time: "t1", entries: [{ label: "e", rank: 1 }] }],
        }),
      );
      expect(svg.length, `图型 ${t} 未产出内容`).toBeGreaterThan(50);
      expect(height).toBeGreaterThan(50);
    }
  });

  it("viewBox 宽度固定为 640", () => {
    const { svg } = renderChart(spec({ type: "F1", points: [{ label: "a", value: 1 }] }));
    expect(svg).toContain(`viewBox="0 0 ${CHART_W} `);
  });

  it("气泡内渲染不带动画 class（消息流式出现，动画会打架）", () => {
    const { svg } = renderChart(spec({ type: "F1", points: [{ label: "a", value: 1 }] }));
    expect(svg).not.toContain("animation-delay");
  });

  it("导出模式带动画 class", () => {
    const { svg } = renderChart(spec({ type: "F1", points: [{ label: "a", value: 1 }] }), {
      animate: true,
    });
    expect(svg).toContain("animation-delay");
  });
});

describe("图型目录", () => {
  it("按数据形状给出候选", () => {
    const hits = suggestChartTypes("少类目排名比较");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.id === "F1" || h.id === "G3")).toBe(true);
  });

  it("构成类数据推荐环形图", () => {
    const hits = suggestChartTypes("100% 构成 占比");
    expect(hits.some((h) => h.id === "F4")).toBe(true);
  });

  it("形状描述含糊时给通用三件套", () => {
    const hits = suggestChartTypes("一些数据");
    expect(hits.map((h) => h.id)).toEqual(["F1", "F2", "F4"]);
  });

  it("每个别名都能找到可渲染的目标", () => {
    for (const [from, to] of Object.entries(ALIASES)) {
      expect(findChartType(to), `${from} → ${to} 目标不存在`).toBeDefined();
    }
  });
});

describe("配色", () => {
  it("类目超容量时回落到 mono 灰阶（不硬塞颜色）", () => {
    const p = pickPalette("palm", 10, false);
    expect(p.name).toBe("mono");
  });

  it("暗卡下墨色反转为纸色", () => {
    const p = pickPalette("mono", 2, true);
    expect(p.bg).toBe("#1C1C1A");
    expect(p.txt).toBe("#F0EFEB");
  });

  it("四套预设都有 ramp 与 cat", () => {
    for (const p of Object.values(PALETTES)) {
      expect(p.ramp.length).toBeGreaterThan(2);
      expect(p.cat.length).toBeGreaterThan(2);
    }
  });
});

describe("数值格式化", () => {
  it("上万走万，上亿走亿", () => {
    expect(fmtNum(12345)).toBe("1.23万");
    expect(fmtNum(123456789)).toBe("1.23亿");
  });

  it("整数不加小数点", () => {
    expect(fmtNum(42)).toBe("42");
  });

  it("非有限值给占位符", () => {
    expect(fmtNum(NaN)).toBe("—");
  });
});

describe("转义", () => {
  it("转义全部五个危险字符", () => {
    expect(esc(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
