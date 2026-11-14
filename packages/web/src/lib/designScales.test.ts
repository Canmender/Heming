import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * 设计刻度的回归守卫（d.141）。
 *
 * 背景：审计（docs/UIUX-AUDIT-2026-11-13.md）里最难收的是「六维度无刻度」——
 * 字号 `text-[11px]/[12px]/[13px]` 混写到 641 处、动效 100/150/160/200/280/300/500 七值、
 * 图标 10/11/13/15/17/22 散落。d.141 用 codemod 一次性换成刻度类
 * （`text-ui-*` / `text-num-*` / `duration-fast|base|slow` / 图标 12·14·16·18·20·24），
 * 但「换一次」不等于「以后不再写」——这类回归没有任何运行时表现，只有下一个读到
 * 那一行的人才会发现，所以钉成测试。
 *
 * 刻度定义在 `src/index.css` 的 `@theme`；新增刻度请先加 token，再用刻度类。
 */

const SRC = "src";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      // generated/ 是构建产物（changelog 快照），历史文本里允许出现旧类名。
      // 注意：按目录名判断，不要拿拼好的路径去匹配 `generated[\\/]`——
      // 目录自身结尾没有分隔符（Windows 反斜杠），会漏。
      if (ent.name === "generated") continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = sourceFiles(join(process.cwd(), SRC));

describe("设计刻度：字号只用 text-ui-* / text-num-*", () => {
  it("源码里不再出现 text-[Npx] 字面量（除测试与 generated）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/text-\[\d+px\]/g);
      if (matches) offenders.push(`${file}: ${[...new Set(matches)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("index.css 的主题里确实声明了刻度 token（防止类名还在、token 被删）", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    for (const token of [
      "--text-ui-xs",
      "--text-ui-sm",
      "--text-ui-md",
      "--text-ui-base",
      // 2026-11-14 审计 A4：第二级标题（16px）不再是「一次性字号」。
      "--text-ui-block",
      "--text-ui-lg",
      "--text-ui-xl",
      "--text-num-sm",
      "--text-num-md",
      "--text-num-lg",
      "--transition-duration-fast",
      "--transition-duration-base",
      "--transition-duration-slow",
      "--ease-out-soft",
    ]) {
      expect(css, `缺少 @theme token ${token}`).toContain(token);
    }
  });
});

describe("设计刻度：动效只用三档", () => {
  it("源码里不再出现 duration-100/150/160/200/280/300/500", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/\bduration-(?:100|150|160|200|280|300|500)\b/g);
      if (matches) offenders.push(`${file}: ${[...new Set(matches)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  /* 2026-11-14 第二轮新增：`duration-[160ms]` 这类 arbitrary 值能绕过上面那条按类名匹配的守卫。
   * 导航轨曾经就是 duration-[160ms] 与 NAV_MOTION_MS=160 双写，值不在 120/180/280 三档里，
   * 改一处忘一处时没有任何东西会红。现在只允许 duration-{fast,base,slow}。 */
  it("不允许 arbitrary 毫秒值（duration-[NNNms]）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/\bduration-\[\d+m?s\]/g);
      if (matches) offenders.push(`${file}: ${[...new Set(matches)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("设计刻度：行高只走命名档", () => {
  /*
   * A5（d.146）：行高从 5 种手写像素值（14/17/26/1.75 等）收成
   * leading-tight/snug/normal + 长文 `leading-reading`（@theme 里的 --leading-reading: 1.75）。
   * 手写 `leading-[17px]` 的问题是：它跟着字号一起漂——字号从 11 改到 12 以后，
   * 17px 这段行高就不再是原来那个视觉密度，而且没人会去回过头改它。
   *
   * 字面量行高一律禁止：长文要 1.75 就写 leading-reading（token 化过一次），
   * 其余用 Tailwind 的命名档。
   */
  it("不再出现 leading-[…] 字面量", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = [...new Set(readFileSync(file, "utf8").match(/\bleading-\[[^\]]+\]/g) ?? [])];
      if (hits.length > 0) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("@theme 里登记了 --leading-reading（长文行高）", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    expect(css).toMatch(/--leading-reading:\s*1\.75;/);
  });
});

describe("设计刻度：图标尺寸落在 12/14/16/18/20/24", () => {
  it("width/height 成对出现时同值且落在栅格上", () => {
    const grid = new Set([12, 14, 16, 18, 20, 24]);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/width=\{(\d+)\}\s+height=\{(\d+)\}/g)) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (w !== h || !grid.has(w)) offenders.push(`${file}: width={${w}} height={${h}}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/*
 * ── 2026-11-14 审计后新增的守卫（P1-9）──────────────────────────────
 *
 * 上面三组守的是「刻度不许写死」；下面四组守的是**已经收口的东西不许再分叉**：
 * 字重、第二级标题、键帽、分段控件。每一条都对应审计里一处「同一语义三套外观」。
 */

describe("设计刻度：字重不许回到 700（口径 = 500/600）", () => {
  it("font-bold 最多 5 处（键帽数字/表格首列等豁免位）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const count = (text.match(/\bfont-bold\b/g) ?? []).length;
      if (count > 0) offenders.push(`${file}: ${count}`);
    }
    // 报错信息要能直接看出「还剩哪几处」，所以打整个列表而不是只打数量
    expect(offenders.join("\n")).toBe("");
  });
});

describe("设计刻度：页内第二级标题必须有层级", () => {
  it("<h2> 不许用元信息字号（ui-micro / text-ui-xs）——标题不能比正文小", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/<h2\b[^>]*>/g)) {
        if (/ui-micro|text-ui-xs/.test(m[0])) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("设计刻度：键帽只有一份实现", () => {
  it("除 ui/Kbd.tsx 外不许手写 <kbd>", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(`ui${sep}Kbd.tsx`)) continue;
      const text = readFileSync(file, "utf8");
      if (/<kbd\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("设计刻度：分段控件只有一份实现", () => {
  it("不再出现 .plugin-segment（plugin-segment / plugin-segment-item 类名）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const hits = [...new Set(text.match(/\bplugin-segment[a-z-]*/g) ?? [])];
      if (hits.length > 0) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("设计刻度：语义色只走命名类", () => {
  /*
   * C5（d.145）：颜色 token 以前有一部分只存在于 CSS 变量，ClassName 写不出来，
   * 于是全仓攒了 567 处 `bg-[var(--surface)]` 之类的字面量。tailwind.config.js 补齐
   * token 后用 codemod 换成命名类（`bg-surface` / `text-danger` / `border-warn-line`），
   * 编译结果完全等价，但类名能被 Tailwind 的排序、变体与阅读者理解。
   *
   * 这条守卫拦的是「新写的代码又回到字面量」：token 已在 config 里登记，
   * 就没有理由再手拼 arbitrary value。
   */
  it("已登记的语义色不许再写 bg-/text-/border-[var(--…)] 字面量", () => {
    const tokens = [
      "line", "line-soft", "line-strong", "muted", "ink", "panel", "surface",
      "subtle", "subtle-2", "subtle-3", "subtle-4", "body", "placeholder",
      "danger", "danger-soft", "danger-line", "danger-on",
      "warn", "warn-soft", "warn-line",
      "success", "success-soft", "success-line", "success-on",
      "info", "info-soft", "info-line", "scrim",
      "console-bg", "console-ink", "mark-bg", "mark-ink",
      "chart-1", "chart-2", "chart-grid", "chart-label",
      "avatar-1", "avatar-2", "avatar-3", "avatar-4", "avatar-5", "avatar-6",
      "heming-accent", "heming-on-accent",
    ];
    const utility = "(?:bg|text|border|ring|ring-offset|outline|fill|stroke|divide|from|via|to)";
    const re = new RegExp(`${utility}-\\[var\\(--(?:${tokens.join("|")})\\)\\]`, "g");
    // 先自检正则本身：否则写错一个转义，这条守卫会永远绿。
    expect("bg-[var(--surface)]".match(re)).not.toBeNull();
    expect("border-[var(--warn-line)]".match(re)).not.toBeNull();
    expect("bg-[var(--chat-gutter)]".match(re)).toBeNull(); // 间距 token 不在此列

    const offenders: string[] = [];
    for (const file of files) {
      const hits = [...new Set(readFileSync(file, "utf8").match(re) ?? [])];
      if (hits.length > 0) offenders.push(`${file}: ${hits.slice(0, 4).join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
