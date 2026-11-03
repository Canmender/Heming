import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAV_MODE,
  NAV_HIDE_DELAY_MS,
  NAV_HOTZONE_PX,
  NAV_MODE_KEY,
  NAV_MOTION_MS,
  normalizeNavMode,
  otherNavMode,
  parseNavMode,
  persistNavMode,
  readStoredNavMode,
} from "./navPrefs.js";

/**
 * 导航栏显示模式（d.68）：
 * - 纯函数：解析 / 坏值回落 / 落盘（不依赖 React 与 DOM）；
 * - 交互默认值守卫：热区 8px、退出延迟 300ms、动效 160ms（与规格、调研文档同口径）；
 * - 源码守卫：auto 浮层只动 transform/opacity（绝不改 width）；字体栈拉丁在前、不联网。
 */

/** 内存版 Storage：覆盖读/写/抛错三条路径。 */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

describe("navPrefs · 模式解析与坏值回落", () => {
  it("默认常显（老用户升级后导航不会突然不见）", () => {
    expect(DEFAULT_NAV_MODE).toBe("pinned");
    expect(normalizeNavMode(undefined)).toBe("pinned");
    expect(normalizeNavMode(null)).toBe("pinned");
    expect(normalizeNavMode("")).toBe("pinned");
    expect(normalizeNavMode("AUTO")).toBe("pinned");
    expect(normalizeNavMode(1)).toBe("pinned");
    expect(normalizeNavMode({ mode: "auto" })).toBe("pinned");
  });

  it("两档合法值原样返回", () => {
    expect(normalizeNavMode("pinned")).toBe("pinned");
    expect(normalizeNavMode("auto")).toBe("auto");
    expect(parseNavMode("auto")).toBe("auto");
    expect(parseNavMode("  pinned  ")).toBe("pinned");
  });

  it("parseNavMode 兼容早期 JSON.stringify 落盘写法", () => {
    expect(parseNavMode('"auto"')).toBe("auto");
    expect(parseNavMode('"pinned"')).toBe("pinned");
    // 合法 JSON 但不是两档字符串 → 回落
    expect(parseNavMode('"docked"')).toBe("pinned");
    expect(parseNavMode("{not json")).toBe("pinned");
  });

  it("otherNavMode 在两档之间来回", () => {
    expect(otherNavMode("pinned")).toBe("auto");
    expect(otherNavMode("auto")).toBe("pinned");
    expect(otherNavMode("bogus" as never)).toBe("auto"); // 坏值先归一成 pinned，再取反
  });
});

describe("navPrefs · 存储读写", () => {
  it("没有存储 / 没写过 → pinned", () => {
    expect(readStoredNavMode(null)).toBe("pinned");
    expect(readStoredNavMode(fakeStorage())).toBe("pinned");
  });

  it("读回写入的值；坏字符串回落 pinned", () => {
    expect(readStoredNavMode(fakeStorage({ [NAV_MODE_KEY]: "auto" }))).toBe("auto");
    expect(readStoredNavMode(fakeStorage({ [NAV_MODE_KEY]: "bogus" }))).toBe("pinned");
    expect(readStoredNavMode(fakeStorage({ [NAV_MODE_KEY]: "" }))).toBe("pinned");
  });

  it("getItem 抛错（隐私模式）也回落 pinned，不抛给调用方", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredNavMode(broken)).toBe("pinned");
  });

  it("persistNavMode 写盘并返回归一后的值；写失败不抛", () => {
    const store = fakeStorage();
    expect(persistNavMode("auto", store)).toBe("auto");
    expect(store.data.get(NAV_MODE_KEY)).toBe("auto");

    const broken = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => persistNavMode("auto", broken)).not.toThrow();
  });
});

describe("navPrefs · 交互默认值（与规格 / 调研同口径）", () => {
  it("热区 8px（窗口内边缘 8–12px 区间）、退出延迟 300ms、动效 160ms", () => {
    expect(NAV_HOTZONE_PX).toBe(8);
    expect(NAV_HIDE_DELAY_MS).toBe(300);
    expect(NAV_MOTION_MS).toBe(160);
    expect(NAV_HIDE_DELAY_MS).toBeGreaterThanOrEqual(250);
    expect(NAV_MOTION_MS).toBeGreaterThanOrEqual(120);
    expect(NAV_MOTION_MS).toBeLessThanOrEqual(200);
  });

  it("源码守卫：浮层只动 transform/opacity，不写 width 动画、不推挤内容", () => {
    const src = readFileSync("src/components/NavRail.tsx", "utf8");
    // 动效属性只允许 transform/opacity
    expect(src).toContain("transition-[transform,opacity]");
    expect(src).toContain("duration-[160ms]");
    expect(src).toContain("motion-reduce:transition-none");
    // 不能出现会触发 reflow 的写法（Tip 的 transition-all 只作用于浮签，不在此列）
    expect(src).not.toContain("transition-[width]");
    expect(src).not.toMatch(/\bw-0\b/);
    // auto 态不参与布局宽度：用 absolute（脱离文档流）而不是 shrink-0 占位
    expect(src).toContain('className="absolute inset-y-0 left-0 z-20');
    expect(src).toContain("absolute inset-y-0 left-0 z-30");
    // 浮层阴影用专门的语义类（亮/暗两档），不复用「贴纸」阴影 shadow-float
    expect(src).toContain("ui-overlay-shadow");
    expect(src).not.toContain("shadow-float");
  });

  it("auto 下热区 8px 与内容之间有同宽空档，热区不压内容最左侧", () => {
    // 助手页/团队页的列表行是整行按钮，左边缘就是可点区；
    // App 在 auto 模式下给壳层内容行留一条与热区同宽（NAV_HOTZONE_PX）的 padding。
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain('navMode === "auto" ? { paddingLeft: NAV_HOTZONE_PX }');
  });

  it("浮层阴影亮/暗两档都在 index.css 里定义（暗色不刺眼）", () => {
    const css = readFileSync("src/index.css", "utf8");
    expect(css).toContain(".ui-overlay-shadow {");
    expect(css).toContain("box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14)");
    expect(css).toContain('[data-theme="dark"] .ui-overlay-shadow');
    expect(css).toContain("box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55)");
  });
});

describe("字体与排版 token（index.css 源码守卫）", () => {
  const css = readFileSync("src/index.css", "utf8");
  // 只看「首个暗色块之前」的 light 变量段（注释里也会出现 [data-theme="dark"] 字样，不能用 indexOf 找注释）
  const root = css.slice(0, css.search(/\[data-theme="dark"\]\s*\{/));

  it("根部定义 --heming-font-sans / --heming-font-mono，body 引用它", () => {
    expect(css).toContain("--heming-font-sans:");
    expect(css).toContain("--heming-font-mono:");
    expect(css).toContain("font-family: var(--heming-font-sans)");
    // Tailwind 工具类（font-sans / font-mono）也接到同一套 token
    expect(css).toContain("--font-sans: var(--heming-font-sans)");
    expect(css).toContain("--font-mono: var(--heming-font-mono)");
  });

  it("字体栈拉丁在前、CJK 在后（中文字体放最前会让英文变宽变糊）", () => {
    const sans = /--heming-font-sans:\s*([^;]+);/.exec(css)?.[1] ?? "";
    const latin = sans.indexOf("Segoe UI");
    const cjk = sans.indexOf("Microsoft YaHei UI");
    expect(latin).toBeGreaterThanOrEqual(0);
    expect(cjk).toBeGreaterThan(latin);
    expect(sans).toContain('"PingFang SC"');
  });

  it("等宽栈带中文等宽回退（日志里的中文列才能对齐）", () => {
    const mono = /--heming-font-mono:\s*([^;]+);/.exec(css)?.[1] ?? "";
    expect(mono).toContain("Consolas");
    expect(mono).toContain("Sarasa Mono SC");
    expect(mono).toContain("Noto Sans Mono CJK SC");
  });

  it("不加载外部字体：字体 token 段里没有 http(s) 链接", () => {
    expect(root).not.toMatch(/https?:\/\//i);
    expect(css).not.toMatch(/@import\s+url\(/i);
    expect(css).not.toMatch(/@font-face/i);
  });

  it("占位符对比度已提到 WCAG AA（light #767676 / dark #8b9199）", () => {
    expect(root).toContain("--placeholder: #767676");
    expect(css).toContain("--placeholder: #8b9199");
  });

  it("四档字号语义类名保持不变（只有行高微调）", () => {
    for (const cls of [
      ".ui-page-title",
      ".ui-page-sub",
      ".ui-section-title",
      ".ui-body",
      ".ui-body-sm",
      ".ui-caption",
      ".ui-micro",
      ".ui-numeric",
    ]) {
      expect(css).toContain(cls);
    }
    expect(css).toMatch(/\.ui-page-title\s*\{[^}]*text-\[18px\][^}]*leading-\[26px\]/);
    expect(css).toMatch(/\.ui-caption\s*\{[^}]*text-\[11px\][^}]*leading-\[17px\]/);
  });
});
