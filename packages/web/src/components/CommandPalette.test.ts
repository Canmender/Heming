import { describe, it, expect } from "vitest";
import type { Conversation } from "@heming/shared";
import { searchAll } from "./CommandPalette";

/**
 * 全局搜索的排序与范围。
 *
 * 抽成纯函数就是为了能这样测：不挂载 UI、不碰键盘事件，
 * 只验证「给一个关键词，出什么结果、按什么顺序」。
 */

function conv(
  id: string,
  name: string,
  archivedAt?: string | null,
  type: "direct" | "group" | "agent" = "direct",
): Conversation {
  if (type === "group") {
    return {
      id,
      type: "group",
      name,
      memberCount: 2,
      unreadCount: 0,
      archivedAt: archivedAt ?? null,
    } as unknown as Conversation;
  }
  if (type === "agent") {
    return {
      id,
      type: "agent",
      agent: { id: `a-${id}`, owner_id: null, name, avatar: null, description: "" },
      unreadCount: 0,
      archivedAt: archivedAt ?? null,
    } as unknown as Conversation;
  }
  return {
    id,
    type: "direct",
    peer: { id: `u-${id}`, username: `u-${id}`, displayName: name, avatar: undefined },
    unreadCount: 0,
    archivedAt: archivedAt ?? null,
  } as unknown as Conversation;
}

describe("searchAll", () => {
  it("空关键词不出结果（避免打开面板就倒一屏东西）", () => {
    expect(searchAll("", [conv("1", "张三")])).toEqual([]);
    expect(searchAll("   ", [conv("1", "张三")])).toEqual([]);
  });

  it("按名字包含匹配", () => {
    const out = searchAll("张", [conv("1", "张三"), conv("2", "李四")]);
    expect(out.map((r) => r.name)).toEqual(["张三"]);
  });

  it("前缀命中排在包含命中之前", () => {
    const out = searchAll("张三", [
      conv("1", "群里的张三丰"), // 包含
      conv("2", "张三"), // 前缀
    ]);
    expect(out[0].name).toBe("张三");
  });

  it("未归档的排在已归档之前（当下要处理的优先）", () => {
    const out = searchAll("评审", [
      conv("1", "评审组-旧", "2026-10-01T00:00:00.000Z"),
      conv("2", "评审组-新"),
    ]);
    expect(out[0].name).toBe("评审组-新");
  });

  it("已归档的会话**仍然搜得到**（归档不等于藏起来）", () => {
    // 找不到的东西才会被归档，所以它必须能被搜到
    const out = searchAll("老项目", [conv("1", "老项目", "2026-09-01T00:00:00.000Z")]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("conversation");
    if (out[0].kind === "conversation") {
      expect(out[0].archived).toBe(true);
      expect(out[0].detail).toContain("已归档");
    }
  });

  it("结果里区分类型（群聊/智能体/好友）", () => {
    const out = searchAll("x", [
      conv("1", "x群", null, "group"),
      conv("2", "x助手", null, "agent"),
      conv("3", "x好友", null, "direct"),
    ]);
    const details = out.map((r) => (r.kind === "conversation" ? r.detail : ""));
    expect(details.some((d) => d.includes("群聊"))).toBe(true);
    expect(details.some((d) => d.includes("智能体"))).toBe(true);
    expect(details.some((d) => d.includes("好友"))).toBe(true);
  });

  it("大小写不敏感", () => {
    const out = searchAll("alice", [conv("1", "Alice")]);
    expect(out).toHaveLength(1);
  });

  it("会话结果最多 8 条（不让一屏被同类结果占满）", () => {
    const many = Array.from({ length: 20 }, (_, i) => conv(`c${i}`, `测试${i}`));
    const out = searchAll("测试", many);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it("能搜到内置技能（名称命中）", () => {
    // 内置技能池必然含「去 AI 味」，用它验证技能分支接上了
    const out = searchAll("AI", []);
    expect(out.some((r) => r.kind === "skill")).toBe(true);
  });
});