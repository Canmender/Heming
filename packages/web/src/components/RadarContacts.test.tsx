import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Agent, User } from "@heming/shared";
import { RadarContacts, layoutSector , clampRadarZoom, clampRadarPan } from "./RadarContacts.js";
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
    // 已有数据：雷达正常渲染，不显示「正在加载/加载失败」条
    workspaceReady: true,
    workspaceError: null,
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
  // 智能体一对一：点智能体走 openAgent（服务端幂等），打桩避免真发请求
  const openAgent = vi
    .spyOn(useChatStore.getState(), "openAgent")
    .mockResolvedValue("ca1");
  return { loadWorkspace, loadAgents, loadAgentsRoster, openAgent };
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

  it("搜索无结果：说明「没有匹配「x」的联系人」并可一键清除", async () => {
    render(<RadarContacts />);
    await screen.findByText("评审组");
    const input = screen.getByPlaceholderText("搜索联系人…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "查无此人" } });
    expect(screen.getByText("没有匹配「查无此人」的联系人")).toBeInTheDocument();
    expect(screen.queryByText("评审组")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(input.value).toBe("");
    expect(screen.getByText("评审组")).toBeInTheDocument();
    expect(screen.queryByText(/没有匹配/)).not.toBeInTheDocument();
  });

  it("首帧加载中显示「正在加载通讯录」，不冒充空通讯录", async () => {
    useChatStore.setState({ workspaceReady: false, workspaceError: null });
    render(<RadarContacts />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载通讯录…");
    await screen.findByText("评审组"); // 数据仍在时节点照常渲染，加载条只是状态提示
  });

  it("首帧失败显示「加载失败 + 重试」；重试重新拉取并恢复", async () => {
    useChatStore.setState({ workspaceReady: false, workspaceError: "网络中断" });
    render(<RadarContacts />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("加载失败：网络中断");

    effects.loadWorkspace.mockImplementationOnce(async () => {
      useChatStore.setState({ workspaceReady: true, workspaceError: null });
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(effects.loadWorkspace).toHaveBeenCalledTimes(2); // 挂载一次 + 重试一次
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
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
            enc: "plain",
          },
        ],
      },
    });
    render(<RadarContacts />);
    await screen.findByText("李四");
    fireEvent.mouseOver(screen.getByText("李四"));
    expect(await screen.findByText("(附件)")).toBeInTheDocument(); // 空串 `??` 走不到回退 → `||` 口径
  });

  it("悬浮卡最近消息：已撤回显示「消息已撤回」，不泄漏原文", async () => {
    useChatStore.setState({
      messages: {
        c1: [
          {
            id: "m1",
            conversationId: "c1",
            senderType: "user" as const,
            senderId: "u2",
            payload: { text: "不该外泄的原文" },
            replyTo: null,
            createdAt: new Date().toISOString(),
            recalledAt: "2026-10-17T00:00:00.000Z",
            enc: "plain",
          },
        ],
      },
    });
    render(<RadarContacts />);
    await screen.findByText("李四");
    fireEvent.mouseOver(screen.getByText("李四"));
    expect(await screen.findByText("消息已撤回")).toBeInTheDocument(); // 与气泡文案一致
    expect(screen.queryByText("不该外泄的原文")).not.toBeInTheDocument();
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

  it("智能体节点：「发消息」可用，点开进入一对一（agent 会话已开放）", async () => {
    render(<RadarContacts />);
    await screen.findByText("和小鸣");
    fireEvent.mouseOver(screen.getByText("和小鸣"));
    const send = await screen.findByRole("button", { name: "发消息" });
    // 智能体一对一已开放：按钮不再禁用，也没有「M3 开放对话」这类占位提示
    expect(send).not.toBeDisabled();
    expect(send).not.toHaveAttribute("title", "M3 开放对话");
    fireEvent.click(send);
    // openAgent 成功后进入该智能体的一对一会话
    await waitFor(() => {
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a1");
    });
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
    // 系统 agent 没有「编辑」入口（owner 不是我）；但「发消息」可用——一对一已开放
    expect(screen.getByRole("button", { name: "发消息" })).not.toBeDisabled();
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

  it("智能体状态文案：已有一对一会话 / 已入群 / 未入群三态区分", async () => {
    useChatStore.setState({
      agentsRoster: [xiaoMing, mine],
      agentIdsInGroups: new Set(["a1"]), // a1 已入群、a2（自有）未入群
      // a1 额外有一个已存在的一对一会话 → 文案应优先显示「一对一」
      conversations: [
        { id: "ca1", type: "agent", agent: xiaoMing, unreadCount: 0 },
      ] as never,
    });
    render(<RadarContacts />);
    await screen.findByText("和小鸣");

    fireEvent.mouseOver(screen.getByText("和小鸣"));
    expect(await screen.findByText("智能体 · 一对一对话")).toBeInTheDocument();

    fireEvent.mouseOver(screen.getAllByText("架构师")[0]);
    expect(await screen.findByText("智能体 · 未入群，可一对一私聊")).toBeInTheDocument();
  });
});

describe("雷达缩放（clampRadarZoom）", () => {
  it("夹在 0.6–1.8 之间，四舍五入到 0.1", () => {
    expect(clampRadarZoom(1)).toBe(1);
    expect(clampRadarZoom(0.1)).toBe(0.6);
    expect(clampRadarZoom(5)).toBe(1.8);
    expect(clampRadarZoom(1.24)).toBe(1.2);
    expect(clampRadarZoom(1.26)).toBe(1.3);
  });

  it("非法输入回落 1 倍", () => {
    expect(clampRadarZoom(Number.NaN)).toBe(1);
  });
});

/**
 * jsdom 没有 PointerEvent，testing-library 会退化成普通 Event —— button/clientX 全丢，
 * 指针拖动就测不了。这里用 MouseEvent 顶替（类型名仍是 pointerdown，React 能收到）。
 */
if (typeof window !== "undefined" && typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (window as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
}

describe("雷达拖动平移（clampRadarPan）", () => {
  it("未放大或内容比可视区小：不允许位移（免得拖出空白）", () => {
    expect(clampRadarPan({ x: 80, y: 60 }, 1, 800, 600)).toEqual({ x: 0, y: 0 });
    // 放大 1.2 倍但可视区仍大于内容 → 依旧锁死
    expect(clampRadarPan({ x: 50, y: 50 }, 1.2, 900, 800)).toEqual({ x: 0, y: 0 });
  });

  it("放大到内容超出可视区：按超出量夹取", () => {
    // 内容半径 190 × 1.8 = 342；可视区半宽 250 → 允许 92
    const out = clampRadarPan({ x: 400, y: -400 }, 1.8, 500, 500);
    expect(out.x).toBeCloseTo(92, 5);
    expect(out.y).toBeCloseTo(-92, 5);
    // 反方向同理
    const back = clampRadarPan({ x: -400, y: 400 }, 1.8, 500, 500);
    expect(back.x).toBeCloseTo(-92, 5);
    expect(back.y).toBeCloseTo(92, 5);
  });

  it("宽扁容器按各轴分别夹（横向能挪、纵向锁死）", () => {
    const out = clampRadarPan({ x: 999, y: 999 }, 1.8, 400, 900);
    expect(out.x).toBeCloseTo(190 * 1.8 - 200, 5);
    expect(out.y).toBe(0);
  });

  it("非法输入回落 0，不产出 NaN transform", () => {
    expect(clampRadarPan({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, 1.8, 400, 400)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("雷达缩放 + 拖动交互", () => {
  it("放大后可拖动：舞台 transform 跟着位移，双击复位", () => {
    render(<RadarContacts />);
    const radar = document.querySelector(".radar") as HTMLElement;
    // jsdom 没有布局，给容器一个确定尺寸以便夹取计算
    Object.defineProperty(radar, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(radar, "clientHeight", { value: 400, configurable: true });

    fireEvent.click(screen.getByRole("button", { name: "放大雷达" }));
    fireEvent.click(screen.getByRole("button", { name: "放大雷达" }));
    expect(radar.dataset.zoomed).toBe("on");

    fireEvent.pointerDown(radar, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(radar, { clientX: 240, clientY: 220, pointerId: 1 });
    expect(radar.dataset.panning).toBe("on");
    const stage = document.querySelector(".radar-stage") as HTMLElement;
    // 横向被夹到上限：内容半径 190×1.2=228 − 可视区半宽 200 = 28（纵向 228−200 同样是 28，取 20）
    expect(stage.style.transform).toContain("translate(28px, 20px)");

    fireEvent.pointerUp(radar, { clientX: 240, clientY: 220, pointerId: 1 });
    expect(radar.dataset.panning).toBe("off");

    fireEvent.doubleClick(radar);
    expect(stage.style.transform).toContain("translate(0px, 0px)");
  });

  it("未放大时不进入拖动态（点击节点照常生效）", () => {
    render(<RadarContacts />);
    const radar = document.querySelector(".radar") as HTMLElement;
    expect(radar.dataset.zoomed).toBe("off");
    fireEvent.pointerDown(radar, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(radar, { clientX: 160, clientY: 140, pointerId: 1 });
    expect(radar.dataset.panning).toBe("off");
    const stage = document.querySelector(".radar-stage") as HTMLElement;
    expect(stage.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("百分比按钮复位缩放与位移", () => {
    render(<RadarContacts />);
    const radar = document.querySelector(".radar") as HTMLElement;
    Object.defineProperty(radar, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(radar, "clientHeight", { value: 400, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "放大雷达" }));
    fireEvent.pointerDown(radar, { clientX: 200, clientY: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(radar, { clientX: 260, clientY: 240, pointerId: 2 });
    fireEvent.pointerUp(radar, { clientX: 260, clientY: 240, pointerId: 2 });

    fireEvent.click(screen.getByRole("button", { name: "复位雷达缩放" }));
    const stage = document.querySelector(".radar-stage") as HTMLElement;
    expect(stage.style.transform).toBe("translate(0px, 0px) scale(1)");
  });
});
