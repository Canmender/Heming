/**
 * 暗色主题的基元回归守卫（d.68 自检）。
 *
 * 背景：d.68 自检在真浏览器里发现「暗色下按钮/输入框是白底近白字、热力图 30 个白方块」。
 * 根因是**组件基元把亮色写进 @layer components**（`@apply bg-white`/内联 hex），
 * 而 d.67 的暗色兼容层只按**类名**覆盖 JSX 里的字面量类（`[data-theme="dark"] .bg-white`），
 * 匹配不到 `.ui-btn-ghost` 这种组件类，也不会命中内联 style。
 *
 * 这类问题 jsdom 测不出来（测试不加载真实 CSS），所以用源码守卫钉住：
 * 组件基元的底色/文字色必须走 CSS 变量，暗色对应规则必须存在。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/index.css", "utf8");
const heatmap = readFileSync("src/components/TokenHeatmap.tsx", "utf8");

/** 取某个选择器后的第一段 `{ ... }`（组件规则都是平铺声明，够用），并去掉注释。 */
function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `${selector} 应存在于 index.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}

describe("组件基元的底色必须走变量（暗色不白底）", () => {
  it.each([
    [".ui-input", "var(--surface)"],
    [".ui-btn-ghost", "var(--surface)"],
    [".ui-chip", "var(--subtle)"],
  ])("%s 用主题变量，不再 @apply bg-white / 字面量", (selector, expected) => {
    const body = block(selector);
    expect(body).toContain(expected);
    expect(body).not.toMatch(/bg-white/);
    expect(body).not.toMatch(/bg-\[#/);
  });

  it("列表行/表格 hover 用变量，暗色下不会闪浅灰", () => {
    expect(block(".ui-list-row:hover")).toContain("var(--subtle)");
    expect(block(".ui-table tbody tr:hover td")).toContain("var(--subtle)");
  });

  it(".ui-card 有独立的暗色覆盖（它不带 bg-white 类，兼容层匹配不到）", () => {
    expect(css).toContain('[data-theme="dark"] .ui-card');
  });
});

describe("暗色字面量兼容层覆盖常用 hover（自检发现的悬停闪白）", () => {
  it.each(["#fafafa", "#f3f3f3", "#f0f0f0", "#f5f5f5", "#f7f7f7", "#fbfbfb"])(
    "hover:bg-[%s] 有暗色映射",
    (hex) => {
      expect(css).toContain(`.hover\\:bg-\\[\\#${hex.slice(1)}\\]:hover`);
    },
  );
});

describe("用量热力图配色跟随主题", () => {
  it("5 档颜色在亮/暗两套 :root 里都有定义", () => {
    expect(css.match(/--heat-0:/g)?.length).toBe(2);
    expect(css.match(/--heat-4:/g)?.length).toBe(2);
  });

  it("组件不得内联亮色 hex，统一引用 --heat-N", () => {
    expect(heatmap).not.toContain("#f1f4f7");
    expect(heatmap).toContain("var(--heat-0)");
    expect(heatmap).toContain("var(--heat-4)");
  });

  it("当天格子的描边用 token（暗色有对比）", () => {
    expect(heatmap).not.toContain("ring-[#1a1a1a]");
    expect(heatmap).toContain("var(--line-strong)");
  });
});

describe("开关（Switch）配色跟随主题", () => {
  // d.138：上下文设置卡 / 记忆页 / 技能页三份「逐字节相同」的开关已收口到
  // ui/Switch.tsx（三份拷贝正是本命 bug 的温床：改一处漏两处，同一应用两种开关）。
  // 所以变量守卫钉在基元上，页面侧改为守卫「必须用基元，不许再复制一份」。
  const switchFiles = ["src/components/ui/Switch.tsx", "src/components/plugins/shared.tsx"];
  const sources = switchFiles.map((f) => [f, readFileSync(f, "utf8")] as const);

  it("轨道/滑块变量亮暗各一套", () => {
    expect(css.match(/--switch-off:/g)?.length).toBe(2);
    expect(css.match(/--switch-knob:/g)?.length).toBe(2);
  });

  it.each(sources)("%s 的开关使用变量，不再用 #d8d8d8 / bg-white", (file, src) => {
    expect(src, file).toContain("var(--switch-off)");
    expect(src, file).toContain("var(--switch-knob)");
    expect(src, file).not.toContain("bg-[#d8d8d8]");
  });

  it.each([
    "src/components/ContextSettingsCard.tsx",
    "src/components/MemoryPage.tsx",
    "src/components/SkillsPage.tsx",
  ])("%s 使用统一开关基元，不再各自复制一套", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src, file).toContain('from "./ui/Switch');
    expect(src, file).not.toContain("bg-[#d8d8d8]");
  });
});
