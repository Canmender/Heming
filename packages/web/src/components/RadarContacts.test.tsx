import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Agent, User } from "@heming/shared";
import { RadarContacts, layoutSector } from "./RadarContacts.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { createConversation } from "../lib/api.js";

// createConversation 走 store.openDirect 内部：模块级部分 mock，其余导出（requestFriend 等）保持真实
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, createConversation: vi.fn() };
});

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const li: User = { id: "u2", username: "lisi", displayName: "李四", avatar: "data:image/png;base64,AAA" };
const zhang: User = { id: "u3", username: "zhangsan", displayName: "张三" };
const xiaoMing: Agent = { id: "a1", owner_id: null, name: "和小鸣", avatar: null, description: "官方" };
const mine: Agent = { id: "a2", owner_id: "u1", name: "架构师", avatar: null, description: "d" };

/** 注入三扇区数据：群「评审组」(未读2)、好友李四(有 avatar+直聊未读5)/张三(无 avatar)、智能体和小鸣。 */
function seedStore() {
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
  useUiStore.setState({
    page: "workspace",
    navCollapsed: false,
    activeConversationId: null,
    contactsHidden: false,
    detailContact: null,
  });
  useChatStore.setState({
    conversations: [
      { id: "g1", type: "group", name: "评审组", memberCount: 3, unreadCount: 2 },
      { id: "c1", type: "direct", peer: li, unreadCount: 5 },
    ],
    friends: [
      { id: "f1", user: li },
      { id: "f2", user: zhang },
    ],
    incoming: [],
    agents: [],
    agentsRoster: [xiaoMing],
    agentIdsInGroups: new Set(["a1"]),
    messages: {},
  });
}

/** 挂载副作用打桩：不打真实 fetch，store 保持注入数据。 */
function spyEffects() {
  const loadWorkspace = vi
    .spyOn(useChatStore.getState(), "loadWorkspace")
    .mockResolvedValue(undefined);
  const loadAgents = vi.spyOn(useChatStore.getState(), "loadAgents").mockResolvedValue(undefined);
  const loadAgentsRoster = vi
    .spyOn(useChatStore.getState(), "loadAgentsRoster")
    .mockResolvedValue(undefined);
  return { loadWorkspace, loadAgents, loadAgentsRoster };
}

describe("layoutSector 扇区落位（纯函数、无随机）", () => {
  it("给定 5 项输出 5 组 {x,y,far}：两次调用完全一致", () => {
    const a = layoutSector(270, ["a", "b", "c", "d", "e"]);
    const b = layoutSector(270, ["a", "b", "c", "d", "e"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    expect(a.map((p) => p.far)).toEqual([false, false, false, false, true]);
  });

  it("序号 0/1 内圈（半径≈105）、2/3 中圈（≈155）、4+ 外圈（≈195）且上扇区在屏幕上半", () => {
    const pts = layoutSector(270, [0, 1, 2, 3, 4]);
    const r = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    expect(Math.round(r(pts[0]))).toBe(105);
    expect(Math.round(r(pts[1]))).toBe(105);
    expect(Math.round(r(pts[2]))).toBe(155);
    expect(Math.round(r(pts[3]))).toBe(155);
    expect(Math.round(r(pts[4]))).toBe(195);
    expect(pts[0].y).toBeLessThan(0); // 上扇区（270°）y 为负 → 屏幕上方
    // 角偏 ±12°：0/1 分居中线两侧
    expect(pts[0].x * pts[1].x).toBeLessThan(0);
  });
});

describe("RadarContacts 雷达通讯录", () => {
  let effects: {
    loadWorkspace: MockInstance;
    loadAgents: MockInstance;
    loadAgentsRoster: MockInstance;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    // vi.mock 工厂里的 vi.fn 不受 restoreAllMocks 影响（vitest 1.6），逐用例显式复位
    vi.mocked(createConversation).mockReset();
    seedStore();
    effects = spyEffects();
  });

  it("挂载即 loadWorkspace → loadAgents + loadAgentsRoster", async () => {
    render(<RadarContacts />);
    await waitFor(() => expect(effects.loadWorkspace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(effects.loadAgents).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(effects.loadAgentsRoster).toHaveBeenCalledTimes(1));
  });

  it("三扇区节点名全部渲染（群聊/人类/智能体）＋ 新建智能体按钮可用", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
    expect(screen.getByText("群聊")).toBeInTheDocument();
    expect(screen.getByText("人类")).toBeInTheDocument();
    expect(screen.getByText("智能体")).toBeInTheDocument();
    expect(screen.getByText("通讯录 · 雷达")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ 新建智能体" })).toBeEnabled();
  });

  it("未读徽标：群 2、李四直聊 5", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("节点头像：有 avatar 渲染 <img>，无 avatar 首字圆底", async () => {
    const { container } = render(<RadarContacts />);
    await screen.findByText("张三");
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(screen.getByText("张")).toBeInTheDocument(); // 张三无 avatar → 首字
  });

  it("搜索实时过滤：输入「李四」后仅人类扇区命中", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    fireEvent.change(screen.getByPlaceholderText("搜索联系人…"), { target: { value: "李四" } });
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.queryByText("评审组")).not.toBeInTheDocument();
    expect(screen.queryByText("和小鸣")).not.toBeInTheDocument();
    // 清空恢复
    fireEvent.change(screen.getByPlaceholderText("搜索联系人…"), { target: { value: "" } });
    expect(screen.getByText("评审组")).toBeInTheDocument();
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
  });

  it("鼠标悬浮节点弹出信息卡（名称/类型/最近消息/按钮）", async () => {
    render(<RadarContacts />);
    await screen.findByText("李四");
    fireEvent.mouseOver(screen.getByText("李四"));
    // 信息卡内名称（节点 + 卡片各一处）
    expect(await screen.findAllByText("李四")).toHaveLength(2);
    expect(screen.getByText("@lisi · 好友")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发消息" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "历史会话" })).toBeEnabled();
  });

  it("悬浮卡最近消息：纯附件消息（text 空串）显示「(附件)」", async () => {
    useChatStore.setState({
      messages: {
        c1: [
          {
            id: "m1",
            conversationId: "c1",
            senderType: "user" as const,
            senderId: "u2",
            payload: {
              text: "",
              file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
            },
            replyTo: null,
            createdAt: new Date().toISOString(),
            recalledAt: null,
          },
        ],
      },
    });
    render(<RadarContacts />);
    await screen.findByText("李四");
    fireEvent.mouseOver(screen.getByText("李四"));
    expect(await screen.findByText("(附件)")).toBeInTheDocument(); // 空串 `??` 走不到回退 → `||` 口径
  });

  it("非 overlay 点击群节点：打开群详情（不直进会话，overlay 直进会话另测）", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    fireEvent.click(screen.getByText("评审组"));
    const s = useUiStore.getState();
    expect(s.detailContact).toEqual({ kind: "group", id: "g1" });
    expect(s.page).toBe("workspace");
    expect(s.contactsHidden).toBe(false);
  });

  it("非 overlay 点击人类节点：打开详情（不直进会话、不触发 openDirect）", async () => {
    render(<RadarContacts />);
    await screen.findByText("张三");
    fireEvent.click(screen.getByText("张三"));
    const s = useUiStore.getState();
    expect(s.detailContact).toEqual({ kind: "human", id: "u3" });
    expect(s.page).toBe("workspace");
    expect(s.activeConversationId).toBeNull();
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("F6 悬浮卡「发消息」（快速通道）：人类无既有直聊 → openDirect 链路（createConversation → 进会话）", async () => {
    // 张三是好友但 conversations 无其直聊 → enter 分支走 openDirect
    vi.mocked(createConversation).mockResolvedValue({ id: "c2", type: "direct", peer: zhang });
    render(<RadarContacts />);
    await screen.findByText("张三");
    fireEvent.mouseOver(screen.getByText("张三"));
    fireEvent.click(await screen.findByRole("button", { name: "发消息" }));
    await waitFor(() => expect(createConversation).toHaveBeenCalledWith("u3"));
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c2"));
    const s = useUiStore.getState();
    expect(s.contactsHidden).toBe(true);
    expect(s.page).toBe("chat");
  });

  it("F8 悬浮卡「发消息」openDirect 失败：面板恢复（未停在隐藏态）+ 顶部错误提示可见", async () => {
    vi.mocked(createConversation).mockRejectedValue(new Error("network down"));
    render(<RadarContacts />);
    await screen.findByText("张三");
    fireEvent.mouseOver(screen.getByText("张三"));
    fireEvent.click(await screen.findByRole("button", { name: "发消息" }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent("无法打开与 张三 的会话");
    const s = useUiStore.getState();
    expect(s.contactsHidden).toBe(false); // hideContacts 之后被 showContacts 拉回
    expect(s.page).toBe("workspace"); // 未进入任何会话
    expect(s.activeConversationId).toBeNull();
  });

  it("智能体节点：点开发消息按钮 disabled（title「M3 开放对话」）", async () => {
    render(<RadarContacts />);
    await screen.findByText("和小鸣");
    fireEvent.mouseOver(screen.getByText("和小鸣"));
    const send = await screen.findByRole("button", { name: "发消息" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "M3 开放对话");
    // 卡片打开后名称两处（节点 + 卡片）：点节点本体（DOM 在前）
    fireEvent.click(screen.getAllByText("和小鸣")[0]);
    // 点击智能体不进入会话、不隐藏通讯录，打开智能体详情
    expect(useUiStore.getState().page).toBe("workspace");
    expect(useUiStore.getState().contactsHidden).toBe(false);
    expect(useUiStore.getState().detailContact).toEqual({ kind: "agent", id: "a1" });
  });

  it("overlay 模式：点群节点隐藏后「呼出」按钮拉回（不改页）", async () => {
    render(<RadarContacts overlay />);
    await screen.findByText("评审组");
    fireEvent.click(screen.getByText("评审组"));
    expect(useUiStore.getState().contactsHidden).toBe(true);
    const recall = await screen.findByTitle("呼出通讯录");
    fireEvent.click(recall);
    expect(useUiStore.getState().contactsHidden).toBe(false);
    expect(useUiStore.getState().page).toBe("chat"); // showContacts 不改页
  });

  it("overlay 隐藏态面板 inert + aria-hidden（屏外不可 Tab 聚焦），拉回后移除", async () => {
    render(<RadarContacts overlay />);
    await screen.findByText("评审组");
    const panel = () => document.querySelector(".radar")!.parentElement!;
    expect(panel()).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByText("评审组"));
    await screen.findByTitle("呼出通讯录");
    expect(panel()).toHaveAttribute("inert");
    expect(panel()).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByTitle("呼出通讯录"));
    expect(panel()).not.toHaveAttribute("inert");
    expect(panel()).not.toHaveAttribute("aria-hidden");
  });

  it("「＋ 加好友」面板可达：申请表单与待处理申请列表", async () => {
    useChatStore.setState({
      incoming: [{ id: "r1", from: zhang }],
    });
    render(<RadarContacts />);
    await screen.findByText("评审组");
    fireEvent.click(screen.getByRole("button", { name: "＋ 加好友" }));
    expect(await screen.findByPlaceholderText("按用户名加好友")).toBeInTheDocument();
    expect(screen.getByText("待处理申请")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接受" })).toBeInTheDocument();
  });

  it("「＋ 新建群」打开 GroupCreateModal", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建群" }));
    expect(await screen.findByText("新建群聊")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("群名称")).toBeInTheDocument();
  });

  it("「＋ 新建智能体」打开 AgentFormModal（create）", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建智能体" }));
    expect(await screen.findByText("新建智能体")).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toBeInTheDocument();
  });

  it("自己拥有的名册项悬浮卡显示「编辑」（打开 edit 弹窗），他人/系统不显示", async () => {
    useChatStore.setState({
      agentsRoster: [xiaoMing, mine],
      agentIdsInGroups: new Set(["a1", "a2"]),
    });
    render(<RadarContacts />);
    await screen.findByText("架构师");
    fireEvent.mouseOver(screen.getByText("架构师"));
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByText("编辑智能体")).toBeInTheDocument();
    expect(screen.getByDisplayValue("架构师")).toBeInTheDocument();
    fireEvent.mouseOver(screen.getByText("和小鸣"));
    expect(screen.getByRole("button", { name: "发消息" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("名册为空时智能体扇区显示空态文案（含自建入口，I2 后不再只提播种）", async () => {
    useChatStore.setState({ agentsRoster: [], agentIdsInGroups: new Set<string>() });
    render(<RadarContacts />);
    await screen.findByText("评审组");
    expect(
      screen.getByText("暂无智能体：可点右上角「＋ 新建智能体」自建，或重启服务端由预设群播种"),
    ).toBeInTheDocument();
    expect(screen.queryByText("和小鸣")).not.toBeInTheDocument();
  });

  it("群内出现过 || 自己拥有 才上雷达（未入群的自有项也显示）", async () => {
    useChatStore.setState({
      agentsRoster: [xiaoMing, mine],
      agentIdsInGroups: new Set(["a1"]), // a2 未入任何群，但 owner 是我
    });
    render(<RadarContacts />);
    await screen.findByText("和小鸣");
    expect(screen.getByText("架构师")).toBeInTheDocument();
  });

  it("I7 状态文案按入群与否区分：已入群「群内 @ 对话」、未入群提示可在新建群时勾选", async () => {
    useChatStore.setState({
      agentsRoster: [xiaoMing, mine],
      agentIdsInGroups: new Set(["a1"]), // a1 已入群、a2（自有）未入群
    });
    render(<RadarContacts />);
    await screen.findByText("和小鸣");

    fireEvent.mouseOver(screen.getByText("和小鸣"));
    expect(await screen.findByText("智能体 · 群内 @ 对话")).toBeInTheDocument();

    fireEvent.mouseOver(screen.getAllByText("架构师")[0]);
    expect(await screen.findByText("智能体 · 未入群，可在新建群时勾选")).toBeInTheDocument();
  });
});
