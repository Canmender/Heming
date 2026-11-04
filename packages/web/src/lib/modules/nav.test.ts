import { describe, it, expect } from "vitest";
import { defaultModuleState, type ModuleState } from "./store.js";
import { fallbackPage, filterNavOrder, filterPalettePages, isPageAvailable } from "./nav.js";
import { PALETTE_PAGES } from "../palette/pages.js";
import { BUILTIN_MODULES } from "./registry.js";
import type { NavPage } from "../../store/ui.js";

const all: NavPage[] = [
  "home",
  "team",
  "chat",
  "staff",
  "infohub",
  "automations",
  "plugins",
  "memory",
  "settings",
];

const off = (patch: Partial<ModuleState["enabled"]>): ModuleState => {
  const state = defaultModuleState();
  Object.assign(state.enabled, patch);
  return state;
};

describe("模块开关 · 导航与路由过滤", () => {
  it("全开时 9 页都在（与改造前一致）", () => {
    expect(filterNavOrder(all, defaultModuleState())).toEqual(all);
  });

  it("停用幕僚/信息中枢/自动化后，只撤下这三页，其余页顺序不变", () => {
    const state = off({ staff: false, infohub: false, automations: false });
    expect(filterNavOrder(all, state)).toEqual(["home", "team", "chat", "plugins", "memory", "settings"]);
  });

  it("自动化依赖信息中枢：只停信息中枢时自动化页也不可用", () => {
    const state = off({ infohub: false });
    expect(isPageAvailable("infohub", state)).toBe(false);
    expect(isPageAvailable("automations", state)).toBe(false);
    expect(isPageAvailable("staff", state)).toBe(true);
    expect(filterNavOrder(all, state)).toContain("staff");
    expect(filterNavOrder(all, state)).not.toContain("automations");
  });

  it("非模块页恒可用", () => {
    for (const page of ["home", "team", "chat", "plugins", "memory", "settings"] as NavPage[]) {
      expect(isPageAvailable(page, off({ staff: false, infohub: false, automations: false }))).toBe(
        true,
      );
    }
  });

  it("命令面板页面目录同样过滤（停用页不出现）", () => {
    const state = off({ staff: false, infohub: false, automations: false });
    const pages = filterPalettePages(PALETTE_PAGES, state).map((p) => p.page);
    expect(pages).toEqual(["home", "team", "chat", "plugins", "memory", "settings"]);
  });

  it("当前页被停用时落到主页；可用时原样返回", () => {
    const state = off({ infohub: false });
    expect(fallbackPage("infohub", state)).toBe("home");
    expect(fallbackPage("staff", state)).toBe("staff");
  });
});

describe("模块注册表与导航目录同源", () => {
  it("模块页的显示名与页面目录一致（改一处不会两处漂移）", () => {
    for (const mod of BUILTIN_MODULES) {
      const page = PALETTE_PAGES.find((p) => p.page === mod.page);
      expect(page, `${mod.id} 的页面必须在页面目录里`).toBeTruthy();
      expect(page?.label).toBe(mod.name);
      // 模块页不占用数字快捷键（当前三个都没有；沿用「新页不抢老键位」口径）
      expect(page?.digit).toBeUndefined();
    }
  });
});
