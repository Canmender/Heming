import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_ORDER } from "../store/ui.js";
import { NAV_GROUP_LABEL, NAV_GROUP_OF, navGroupOf, needsGroupDivider } from "./navGroups.js";

/**
 * 导航分组（d.73）：分组是视觉分隔，不是权限/顺序约束。
 * 这里只钉住三条容易漂移的约定：覆盖全页、默认顺序里同组连续、分隔线只在组变化时出现。
 */
describe("导航分组", () => {
  it("每个宿主页恰好属于一个分组，没有多余项", () => {
    expect(Object.keys(NAV_GROUP_OF).sort()).toEqual([...DEFAULT_NAV_ORDER].sort());
    for (const page of DEFAULT_NAV_ORDER) {
      expect(NAV_GROUP_LABEL[navGroupOf(page)]).toBeTruthy();
    }
  });

  it("默认顺序按「工作台 / 智能模块 / 资料与能力 / 系统」连续排布", () => {
    const runs: string[] = [];
    for (const page of DEFAULT_NAV_ORDER) {
      const group = navGroupOf(page);
      if (runs[runs.length - 1] !== group) runs.push(group);
    }
    expect(runs).toEqual(["work", "modules", "resources", "system"]);
  });

  it("分组细线：首项与同组相邻不画；跨组才画（模块停用后按可见相邻项算）", () => {
    expect(needsGroupDivider(null, "home")).toBe(false);
    expect(needsGroupDivider("home", "chat")).toBe(false);
    expect(needsGroupDivider("chat", "team")).toBe(false);
    // 工作台 → 智能模块
    expect(needsGroupDivider("team", "staff")).toBe(true);
    // 智能模块整组停用：团队直接接插件区（资料与能力）→ 仍是一条线，不是两条
    expect(needsGroupDivider("team", "plugins")).toBe(true);
    expect(needsGroupDivider("plugins", "memory")).toBe(false);
    expect(needsGroupDivider("memory", "settings")).toBe(true);
  });
});
