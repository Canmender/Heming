import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_ORDER } from "../store/ui.js";
import { BUILTIN_MODULES } from "./modules/registry.js";
import { NAV_GROUP_LABEL, NAV_GROUP_OF, navGroupOf, needsGroupDivider } from "./navGroups.js";

/**
 * 导航分组：分组是视觉分隔，不是权限/顺序约束。
 * 这里只钉住三条容易漂移的约定：覆盖全页、默认顺序里同组连续、分隔线只在组变化时出现。
 */
describe("导航分组", () => {
  it("每个导航页/模块入口恰好属于一个分组，没有多余项", () => {
    // d.119 起模块入口会随安装进轨（插在「插件」之后），所以分组表也要覆盖这 4 个模块页；
    // 但它们的**可见性**由 modules/nav.ts 决定，不属于本表。
    const allPages = [...DEFAULT_NAV_ORDER, ...BUILTIN_MODULES.map((mod) => mod.page)];
    expect(Object.keys(NAV_GROUP_OF).sort()).toEqual([...allPages].sort());
    for (const page of allPages) {
      expect(NAV_GROUP_LABEL[navGroupOf(page)]).toBeTruthy();
    }
    // 模块入口与「插件」同组：它们就是从插件页装出来的能力，不该另起一段
    for (const mod of BUILTIN_MODULES) expect(navGroupOf(mod.page as never)).toBe("capability");
  });

  it("默认顺序按「工作台 / 能力 / 资料 / 系统」连续排布", () => {
    const runs: string[] = [];
    for (const page of DEFAULT_NAV_ORDER) {
      const group = navGroupOf(page);
      if (runs[runs.length - 1] !== group) runs.push(group);
    }
    expect(runs).toEqual(["work", "capability", "resources", "system"]);
  });

  it("分组细线：首项与同组相邻不画；跨组才画", () => {
    expect(needsGroupDivider(null, "home")).toBe(false);
    expect(needsGroupDivider("home", "team")).toBe(false);
    expect(needsGroupDivider("team", "chat")).toBe(false);
    // 工作台 → 能力
    expect(needsGroupDivider("chat", "plugins")).toBe(true);
    // 能力 → 资料
    expect(needsGroupDivider("plugins", "memory")).toBe(true);
    expect(needsGroupDivider("memory", "vault")).toBe(false);
    expect(needsGroupDivider("vault", "model")).toBe(false);
    // 资料 → 系统
    expect(needsGroupDivider("model", "settings")).toBe(true);
    // 已装模块插在「插件」之后：与插件同组（不画线），与后面的资料之间画线
    expect(needsGroupDivider("plugins", "workflows")).toBe(false);
    expect(needsGroupDivider("workflows", "memory")).toBe(true);
  });
});
