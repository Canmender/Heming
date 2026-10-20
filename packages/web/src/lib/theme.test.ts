import { describe, it, expect, beforeEach } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  applyAccent,
  clearAccent,
  hexToRgb,
  normalizeHex,
  readableOn,
  relativeLuminance,
} from "./theme.js";
import { THEME_KEY, readStoredAccent, useThemeStore } from "../store/theme.js";

describe("normalizeHex", () => {
  it("补 #、三位展开六位、统一小写", () => {
    expect(normalizeHex("#2F5BD7")).toBe("#2f5bd7");
    expect(normalizeHex("2f5bd7")).toBe("#2f5bd7");
    expect(normalizeHex("  #abc ")).toBe("#aabbcc");
  });

  it("非法输入返回 null（调用方据此不改现有色）", () => {
    for (const bad of ["", "#12", "red", "#12345", "rgb(0,0,0)", "#gggggg"]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe("hexToRgb / relativeLuminance", () => {
  it("解析 RGB 分量", () => {
    expect(hexToRgb("#2f5bd7")).toEqual([0x2f, 0x5b, 0xd7]);
    expect(hexToRgb("nope")).toBeNull();
  });

  it("亮度：白 > 灰 > 黑", () => {
    expect(relativeLuminance("#ffffff")).toBeGreaterThan(relativeLuminance("#888888"));
    expect(relativeLuminance("#888888")).toBeGreaterThan(relativeLuminance("#000000"));
  });
});

describe("readableOn", () => {
  it("亮底配近黑字、暗底配白字", () => {
    expect(readableOn("#f5f5f5")).toBe("#101010");
    expect(readableOn("#1a1a1a")).toBe("#ffffff");
    expect(readableOn("#2f5bd7")).toBe("#ffffff");
  });
});

describe("applyAccent / clearAccent", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("写入 --heming-accent 与按亮度算出的前景色", () => {
    applyAccent("#f0f0f0");
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--heming-accent")).toBe("#f0f0f0");
    expect(root.getPropertyValue("--heming-on-accent")).toBe("#101010");
  });

  it("清掉内联变量即回到 index.css 的默认墨色", () => {
    applyAccent("#2f5bd7");
    clearAccent();
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("");
  });
});

describe("readStoredAccent", () => {
  const makeStorage = (raw: string | null) => ({ getItem: () => raw });

  it("无记录 / 脏数据 → 默认墨色", () => {
    expect(readStoredAccent(makeStorage(null))).toBe(DEFAULT_ACCENT);
    expect(readStoredAccent(makeStorage("不是 JSON"))).toBe(DEFAULT_ACCENT);
    expect(readStoredAccent(makeStorage('{"accent":"red"}'))).toBe(DEFAULT_ACCENT);
    expect(readStoredAccent(makeStorage('[1,2]'))).toBe(DEFAULT_ACCENT);
  });

  it("正常值规整后返回；三位缩写也认", () => {
    expect(readStoredAccent(makeStorage('{"accent":"#2F5BD7"}'))).toBe("#2f5bd7");
    expect(readStoredAccent(makeStorage('{"accent":"abc"}'))).toBe("#aabbcc");
  });

  it("无 storage（SSR/隐私模式）→ 默认", () => {
    expect(readStoredAccent(null)).toBe(DEFAULT_ACCENT);
  });
});

describe("useThemeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    useThemeStore.setState({ accent: DEFAULT_ACCENT });
  });

  it("设置合法色 → 状态、DOM 变量、localStorage 三处同步", () => {
    expect(useThemeStore.getState().setAccent("#2f5bd7")).toBe(true);
    expect(useThemeStore.getState().accent).toBe("#2f5bd7");
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("#2f5bd7");
    expect(JSON.parse(localStorage.getItem(THEME_KEY) as string).accent).toBe("#2f5bd7");
  });

  it("设置非法色 → 返回 false 且不改动现状", () => {
    useThemeStore.getState().setAccent("#2f5bd7");
    expect(useThemeStore.getState().setAccent("红色")).toBe(false);
    expect(useThemeStore.getState().accent).toBe("#2f5bd7");
  });

  it("恢复默认 → 回墨色、清 DOM 变量与存储", () => {
    useThemeStore.getState().setAccent("#2f5bd7");
    useThemeStore.getState().resetAccent();
    expect(useThemeStore.getState().accent).toBe(DEFAULT_ACCENT);
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
});

describe("ACCENT_PRESETS", () => {
  it("每个预设都是合法色且不重复", () => {
    const colors = ACCENT_PRESETS.map((p) => p.color);
    expect(new Set(colors).size).toBe(colors.length);
    for (const p of ACCENT_PRESETS) {
      expect(normalizeHex(p.color)).toBe(p.color);
      expect(readableOn(p.color)).toMatch(/^#/);
    }
  });
});
