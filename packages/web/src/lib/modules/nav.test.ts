import { describe, it, expect } from "vitest";
import { defaultModuleState, type ModuleState } from "./store.js";
import {
  fallbackPage,
  filterNavOrder,
  filterPalettePages,
  isPageAvailable,
  moduleNavPages,
  withModuleNav,
} from "./nav.js";
import { PALETTE_PAGES } from "../palette/pages.js";
import { BUILTIN_MODULES, MODULE_IDS } from "./registry.js";
import { DEFAULT_NAV_ORDER, type NavPage } from "../../store/ui.js";

/** 已安装的模块状态；patch 用来单独关掉某个模块的总开关。 */
const on = (patch: Partial<ModuleState["enabled"]> = {}): ModuleState => {
  const state = defaultModuleState();
  for (const id of MODULE_IDS) state.installed[id] = true;
  for (const id of MODULE_IDS) state.enabled[id] = true;
  Object.assign(state.enabled, patch);
  return state;
};

/** 历史列表（含不在导航里的模块页）：用来验证过滤仍会撤下不可用页。 */
const legacyList: NavPage[] = [
  "home",
  "team",
  "chat",
  "staff",
  "infohub",
  "automations",
  "modelroute",
  "plugins",
  "memory",
  "settings",
];

describe("模块安装/开关 · 导航与路由过滤", () => {
  it("导航默认顺序固定 8 项（模块页不在其中）", () => {
    expect(DEFAULT_NAV_ORDER).toEqual([
      "home",
      "team",
      "chat",
      "plugins",
      "memory",
      "vault",
      "model",
      "settings",
    ]);
  });

  it("已安装且启用时，历史列表里的模块页仍可用（但不会被默认顺序带进导航）", () => {
    expect(filterNavOrder(legacyList, on())).toEqual(legacyList);
    expect(DEFAULT_NAV_ORDER).not.toContain("staff");
    expect(DEFAULT_NAV_ORDER).not.toContain("infohub");
    expect(DEFAULT_NAV_ORDER).not.toContain("automations");
  });

  it("未安装/停用的模块页从过滤结果里撤下，其余页顺序不变", () => {
    const state = on({ staff: false, infohub: false, automations: false });
    expect(filterNavOrder(legacyList, state)).toEqual([
      "home",
      "team",
      "chat",
      "modelroute",
      "plugins",
      "memory",
      "settings",
    ]);
  });

  it("自动化不依赖信息中枢：只停信息中枢时自动化仍可用", () => {
    const state = on({ infohub: false });
    expect(isPageAvailable("infohub", state)).toBe(false);
    expect(isPageAvailable("automations", state)).toBe(true);
    expect(isPageAvailable("staff", state)).toBe(true);
    expect(filterNavOrder(legacyList, state)).toContain("automations");
    expect(filterNavOrder(legacyList, state)).not.toContain("infohub");
  });

  it("未安装时即使总开关为 true 也不可用", () => {
    const state = defaultModuleState();
    for (const id of MODULE_IDS) state.enabled[id] = true;
    expect(isPageAvailable("staff", state)).toBe(false);
    expect(isPageAvailable("automations", state)).toBe(false);
  });

  it("非模块页恒可用", () => {
    for (const page of DEFAULT_NAV_ORDER) {
      expect(isPageAvailable(page, defaultModuleState())).toBe(true);
    }
  });

  it("命令面板页面目录只有 8 个导航页，且不受模块状态影响", () => {
    expect(PALETTE_PAGES.map((p) => p.page)).toEqual(DEFAULT_NAV_ORDER);
    expect(filterPalettePages(PALETTE_PAGES, defaultModuleState())).toEqual(PALETTE_PAGES);
  });

  it("当前页被停用时落到主页；可用时原样返回", () => {
    const state = on({ infohub: false });
    expect(fallbackPage("infohub", state)).toBe("home");
    expect(fallbackPage("staff", state)).toBe("staff");
    expect(fallbackPage("automations", state)).toBe("automations");
  });
});

describe("模块注册表与页面目录同源", () => {
  it("模块页都保留独立的 Palette 描述（不在固定导航目录里，但可被模块卡打开）", () => {
    for (const mod of BUILTIN_MODULES) {
      expect(mod.page).toBeTruthy();
      expect(DEFAULT_NAV_ORDER).not.toContain(mod.page);
      expect(PALETTE_PAGES.some((p) => p.page === mod.page)).toBe(false);
    }
  });
});

describe("已装模块的导航入口（d.119）", () => {
  it("未安装/停用的模块不给入口", () => {
    expect(moduleNavPages(defaultModuleState())).toEqual([]);
    expect(withModuleNav(DEFAULT_NAV_ORDER, defaultModuleState())).toEqual(DEFAULT_NAV_ORDER);
    const off = on({ workflows: false });
    expect(moduleNavPages(off)).not.toContain("workflows");
    expect(withModuleNav(DEFAULT_NAV_ORDER, off)).not.toContain("workflows");
  });

  it("已装且启用的模块追加在导航最后，8 个宿主页顺序原样不动", () => {
    const state = on();
    const order = withModuleNav(DEFAULT_NAV_ORDER, state);
    // 前 8 项仍是用户期望的固定顺序（主页 → 设置），模块只挂在末尾
    expect(order.slice(0, DEFAULT_NAV_ORDER.length)).toEqual(DEFAULT_NAV_ORDER);
    // d.134：幕僚/工作流并入自动化插件，导航只多「信息中枢 + 自动化」两项
    expect(order.slice(DEFAULT_NAV_ORDER.length)).toEqual(["infohub", "automations"]);
    // 模块入口不写进个性化顺序
    expect(DEFAULT_NAV_ORDER).not.toContain("automations");
  });

  it("只装一个模块时只多一项（不多塞未装的）", () => {
    const state = defaultModuleState();
    state.installed.automations = true;
    state.enabled.automations = true;
    expect(moduleNavPages(state)).toEqual(["automations"]);
    expect(withModuleNav(DEFAULT_NAV_ORDER, state)).toEqual([...DEFAULT_NAV_ORDER, "automations"]);
  });

  it("幂等：顺序里已有模块页时不重复插", () => {
    const state = on();
    const once = withModuleNav(DEFAULT_NAV_ORDER, state);
    expect(withModuleNav(once, state)).toEqual(once);
  });
});
