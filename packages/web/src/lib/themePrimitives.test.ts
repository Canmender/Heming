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
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

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

/**
 * d.141：字面量颜色工具类清零后，暗色兼容层（按类名覆盖 `bg-[#fafafa]` 的桥接规则）
 * 整体删除。守卫改为两条更强的约束：
 *   1. 源码里不许再出现字面量颜色工具类（出现时要么换 token，要么说明为什么例外）；
 *   2. index.css 里不许再长出「按字面量类名覆盖暗色」的桥接规则。
 * 这比原来「钉住 6 条 hover 映射」更难绕过：旧写法只保护 6 个类名，新写法保护整类问题。
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) out.push(p);
  }
  return out;
}

describe("字面量颜色工具类不得回流（d.141）", () => {
  // 只扫组件源码：测试自己会断言这些字面量，generated/changelog.ts 是历史文本。
  const files = sourceFiles("src").filter(
    (f) => !/\.test\.tsx?$/.test(f) && !/generated[\\/]/.test(f),
  );

  // 这条守卫要递归读 src 下全部源文件；全量并行（304 个文件抢 CPU）时
  // 默认 5s 会偶发超时（本会话复现一次、单跑不红）。放宽到 20s：它本来就是
  // 一次全仓扫描，不是被测逻辑变慢了。
  it("源码里没有 text-/bg-/border-/ring-[#…] 这类字面量颜色类", { timeout: 20000 }, () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const hit = src.match(/\b(?:text|bg|border|ring|divide|fill|stroke)-\\?\[#[0-9a-fA-F]{3,8}\]/g);
      if (hit) offenders.push(`${file}: ${[...new Set(hit)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("index.css 不再有按字面量类名覆盖暗色的桥接规则", () => {
    expect(css).not.toContain('[data-theme="dark"] .bg-\\[\\#');
    expect(css).not.toContain('[data-theme="dark"] .text-\\[\\#');
    expect(css).not.toContain('[data-theme="dark"] .border-\\[\\#');
    expect(css).not.toContain('[data-theme="dark"] .hover\\:bg-\\[\\#');
  });

  it("保留的暗色语义覆盖仍在（基元/骨架屏/原生控件）", () => {
    for (const selector of [
      '[data-theme="dark"] .ui-card',
      '[data-theme="dark"] .ui-skeleton',
      '[data-theme="dark"] .shadow-card',
      '[data-theme="dark"] input',
    ]) {
      expect(css, selector).toContain(selector);
    }
  });
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
