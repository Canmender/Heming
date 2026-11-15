import { describe, it, expect } from "vitest";
import type { Conversation, Workspace } from "@heming/shared";
import { UNGROUPED_ID, groupConversations, workspaceLabel } from "./group.js";

const agent = { id: "a1", owner_id: null, name: "和鸣", avatar: null, description: "" };

/** 最简化会话：只关心 id / workspace / lastMessageAt（分组只看这三样）。 */
function conv(id: string, workspace?: string | null, lastMessageAt: string | null = null): Conversation {
  return {
    id,
    type: "agent",
    agent,
    unreadCount: 0,
    lastMessageAt,
    ...(workspace ? { workspace } : {}),
  } as Conversation;
}

const ws = (path: string): Workspace => ({ path, updatedAt: "2026-11-15T00:00:00.000Z" });

describe("workspaceLabel", () => {
  it("取路径最后一段作为组名", () => {
    expect(workspaceLabel("D:/项目/和鸣")).toBe("和鸣");
    expect(workspaceLabel("/home/me/work/heming")).toBe("heming");
  });

  it("尾部斜杠/反斜杠都吃掉，不留空组名", () => {
    expect(workspaceLabel("D:/项目/和鸣/")).toBe("和鸣");
    expect(workspaceLabel("D:\\项目\\和鸣\\")).toBe("和鸣");
    expect(workspaceLabel("D:/项目/和鸣///")).toBe("和鸣");
  });

  it("反斜杠路径同样按最后一段取", () => {
    expect(workspaceLabel("D:\\Heming\\packages\\web")).toBe("web");
  });

  it("根路径原样返回（没有最后一段可切）", () => {
    expect(workspaceLabel("/")).toBe("/");
  });
});

describe("groupConversations", () => {
  it("空输入得到空分组", () => {
    expect(groupConversations([], [])).toEqual([]);
  });

  it("未分组组固定 id 是 __none__（路径不可能撞上）", () => {
    expect(UNGROUPED_ID).toBe("__none__");
  });

  it("组内会话按最近活跃降序", () => {
    const groups = groupConversations(
      [
        conv("c1", "D:/项目/和鸣", "2026-11-14T10:00:00.000Z"),
        conv("c2", "D:/项目/和鸣", "2026-11-15T09:00:00.000Z"),
        conv("c3", "D:/项目/和鸣", "2026-11-13T09:00:00.000Z"),
      ],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
    expect(groups[0].lastActivityAt).toBe(Date.parse("2026-11-15T09:00:00.000Z"));
  });

  it("组间按组内最近活跃降序", () => {
    const groups = groupConversations(
      [
        conv("c1", "D:/项目/和鸣", "2026-11-14T10:00:00.000Z"),
        conv("c2", "D:/项目/其他", "2026-11-15T09:00:00.000Z"),
      ],
      [],
    );
    expect(groups.map((g) => g.name)).toEqual(["其他", "和鸣"]);
  });

  it("组间最近活跃并列时按组名排序", () => {
    const groups = groupConversations(
      [conv("c1", "D:/b-proj"), conv("c2", "D:/a-proj")],
      [],
    );
    expect(groups.map((g) => g.path)).toEqual(["D:/a-proj", "D:/b-proj"]);
  });

  it("工作区清单里的空组也显示（刚选的文件夹不能消失）", () => {
    const groups = groupConversations([], [ws("D:/项目/和鸣")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ path: "D:/项目/和鸣", name: "和鸣", conversations: [], lastActivityAt: 0 });
  });

  it("会话里出现但清单没有的路径也成组（目录被删/别的设备加的）", () => {
    const groups = groupConversations([conv("c1", "D:/项目/散装")], []);
    expect(groups.map((g) => g.path)).toEqual(["D:/项目/散装"]);
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["c1"]);
  });

  it("清单与会话的路径合并，不重复成组", () => {
    const groups = groupConversations([conv("c1", "D:/项目/和鸣")], [ws("D:/项目/和鸣")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["c1"]);
  });

  it("未分组永远最后——即使它的会话最新", () => {
    const groups = groupConversations(
      [
        conv("c1", "D:/项目/和鸣", "2026-11-10T10:00:00.000Z"),
        conv("c2", null, "2026-11-15T09:00:00.000Z"),
      ],
      [ws("D:/项目/和鸣")],
    );
    expect(groups.map((g) => g.path)).toEqual(["D:/项目/和鸣", null]);
    expect(groups[1]).toMatchObject({ name: "未分组" });
    expect(groups[1].conversations.map((c) => c.id)).toEqual(["c2"]);
  });

  it("没有未分组会话时不出现「未分组」组", () => {
    const groups = groupConversations([conv("c1", "D:/项目/和鸣")], []);
    expect(groups.some((g) => g.path === null || g.name === "未分组")).toBe(false);
  });

  it("空白 workspace 当成未分组", () => {
    const groups = groupConversations([conv("c1", "   "), conv("c2", null)], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].path).toBeNull();
    expect(groups[0].conversations.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("Windows 反斜杠路径按同一工作区分组，并取最后一段做组名", () => {
    const groups = groupConversations(
      [
        conv("c1", "D:\\项目\\和鸣", "2026-11-14T10:00:00.000Z"),
        conv("c2", "D:\\项目\\和鸣", "2026-11-15T10:00:00.000Z"),
      ],
      [ws("D:\\项目\\和鸣")],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("和鸣");
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["c2", "c1"]);
  });
  it("有会话的组排在空工作区之前（即使会话还没有消息）", () => {
    const groups = groupConversations(
      [conv("c1", "D:/work/demo")],
      [ws("D:/work/demo"), ws("D:/work/empty")],
    );
    expect(groups.map((g) => g.name)).toEqual(["demo", "empty"]);
  });
});
