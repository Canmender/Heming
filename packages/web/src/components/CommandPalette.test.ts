import { describe, it, expect } from "vitest";
import type { TeamMember } from "@heming/shared";
import { searchAll, searchAllDetailed } from "./CommandPalette";

/**
 * 全局搜索的排序与范围（团队系统版）。
 *
 * 去 IM 后不再有会话可搜：输入关键词出「团队成员（名册）+ 内置技能」。
 * 抽成纯函数就是为了能这样测：不挂载 UI、不碰键盘事件。
 */

function member(
  id: string,
  displayName: string,
  over: Partial<TeamMember> = {},
): TeamMember {
  return {
    user: { id, username: id, displayName },
    lastSeenAt: null,
    online: false,
    ...over,
  };
}

describe("searchAll", () => {
  it("空关键词不出结果（避免打开面板就倒一屏东西）", () => {
    expect(searchAll("", [member("u1", "张三")])).toEqual([]);
    expect(searchAll("   ", [member("u1", "张三")])).toEqual([]);
  });

  it("按显示名或用户名包含匹配", () => {
    expect(searchAll("张", [member("u1", "张三"), member("u2", "李四")]).map((r) => r.name)).toEqual([
      "张三",
    ]);
    expect(searchAll("lisi", [member("u1", "张三"), member("lisi", "李四")]).map((r) => r.name)).toEqual([
      "李四",
    ]);
  });

  it("前缀命中排在包含命中之前", () => {
    const out = searchAll("张三", [
      member("u1", "群里的张三丰"), // 包含
      member("u2", "张三"), // 前缀
    ]);
    expect(out[0].name).toBe("张三");
  });

  it("同一前缀内，在线成员优先", () => {
    const out = searchAll("王", [
      member("u1", "王五", { lastSeenAt: "2026-10-01T00:00:00.000Z" }),
      member("u2", "王六", { online: true }),
    ]);
    expect(out[0].name).toBe("王六");
  });

  it("结果带 @用户名与活跃度说明", () => {
    const out = searchAll("张三", [member("u1", "张三", { online: true })]);
    expect(out[0].kind).toBe("member");
    expect(out[0].detail).toContain("@u1");
    expect(out[0].detail).toContain("在线");

    const never = searchAll("张三", [member("u1", "张三")]);
    expect(never[0].detail).toContain("从未登录");
  });

  it("大小写不敏感", () => {
    expect(searchAll("alice", [member("alice", "Alice")])).toHaveLength(1);
  });

  it("成员结果最多 8 条（不让一屏被同类结果占满）", () => {
    const many = Array.from({ length: 20 }, (_, i) => member(`u${i}`, `测试${i}`));
    expect(searchAll("测试", many).length).toBeLessThanOrEqual(8);
  });

  it("能搜到内置技能（名称命中）", () => {
    // 内置技能池必然含「去 AI 味」，用它验证技能分支接上了
    const out = searchAll("AI", []);
    expect(out.some((r) => r.kind === "skill")).toBe(true);
  });
});

describe("searchAllDetailed（超上限提示）", () => {
  it("返回命中总数：展示被截断，但 total 反映全部命中", () => {
    const many = Array.from({ length: 20 }, (_, i) => member(`u${i}`, `测试${i}`));
    const out = searchAllDetailed("测试", many);
    expect(out.results).toHaveLength(8);
    expect(out.total).toBe(20);
    // UI 里的「还有 N 条」= total − results.length
    expect(out.total - out.results.length).toBe(12);
  });

  it("未超上限时 total 等于展示条数（不提示还有）", () => {
    const out = searchAllDetailed("张三", [member("u1", "张三")]);
    expect(out.results).toHaveLength(1);
    expect(out.total).toBe(1);
  });

  it("空关键词 total 为 0（与 results 一致，不触发提示）", () => {
    expect(searchAllDetailed("", [member("u1", "张三")])).toEqual({ results: [], total: 0 });
  });
});
