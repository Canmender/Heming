import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent, User } from "@heming/shared";
import { WorkspacePage } from "./WorkspacePage.js";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const li: User = { id: "u2", username: "lisi", displayName: "李四" };
const xiaoMing: Agent = { id: "a1", owner_id: null, name: "和小鸣", avatar: null, description: "" };

/**
 * 修订说明（原「头像贯穿」整文件作废）：
 * WorkspacePage 已薄容器化为 <RadarContacts />，原好友列表/申请表单/直聊列表
 * 的行级断言迁往 RadarContacts.test.tsx（节点头像 img/首字、加好友面板、三扇区渲染、
 * 名册数据源/新建入口/owner 编辑）。
 * 本文件只锁「工作区 = 雷达主视图」这一层组合关系。
 */
describe("WorkspacePage（薄容器 → 雷达）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useUiStore.setState({
      page: "workspace",
      navCollapsed: false,
      activeConversationId: null,
      contactsHidden: false,
      detailContact: null,
    });
    useChatStore.setState({
      conversations: [{ id: "g1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
      friends: [{ id: "f1", user: li }],
      incoming: [],
      agents: [],
      agentsRoster: [xiaoMing],
      agentIdsInGroups: new Set(["a1"]),
      messages: {},
    });
    vi.spyOn(useChatStore.getState(), "loadWorkspace").mockResolvedValue(undefined);
    vi.spyOn(useChatStore.getState(), "loadAgents").mockResolvedValue(undefined);
    vi.spyOn(useChatStore.getState(), "loadAgentsRoster").mockResolvedValue(undefined);
  });

  it("渲染雷达主视图：标题、圆心、三扇区标签与三类节点", async () => {
    render(<WorkspacePage />);
    await screen.findByText("评审组");
    expect(screen.getByText("通讯录 · 雷达")).toBeInTheDocument();
    expect(screen.getByText("在线")).toBeInTheDocument(); // 圆心「我」在线小字
    expect(screen.getByText("群聊")).toBeInTheDocument();
    expect(screen.getByText("人类")).toBeInTheDocument();
    expect(screen.getByText("智能体")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
  });

  it("detailContact 置位 → 分组竖列 + 详情卡（雷达标题消失、返回雷达可见）", () => {
    useUiStore.setState({ detailContact: { kind: "group", id: "g1" } });
    render(<WorkspacePage />);
    expect(screen.getByLabelText("联系人列")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回雷达" })).toBeInTheDocument();
    expect(screen.queryByText("通讯录 · 雷达")).not.toBeInTheDocument();
    expect(screen.getByLabelText("查看 评审组").getAttribute("aria-current")).toBe("true");
  });
});
