import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { User } from "@heming/shared";
import { HomePage } from "./HomePage.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useTokenUsageStore, monthKeyOf, daysOfMonth } from "../store/tokenUsage.js";
import { clearDraft, setDraft } from "../lib/drafts.js";

const user: User = { id: "u1", username: "alice", displayName: "测试阿丽" };
const peer: User = { id: "u2", username: "bob", displayName: "鲍勃" };

// conversations 为联合类型（M2）：direct 夹具补 unreadCount
const conv = (id: string) => ({ id, type: "direct" as const, peer: user, unreadCount: 0 });

const AGENT_ROSTER = [
  { id: "a1", owner_id: "u1", name: "我的智能体甲", avatar: null, description: "帮我写代码" },
  { id: "a2", owner_id: null, name: "和小鸣", avatar: null, description: "和鸣官方预设" },
];

const now = new Date();
const at = (day: number, hour = 12) =>
  new Date(now.getFullYear(), now.getMonth(), day, hour).toISOString();
const dayKey = (day: number) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** HomePage 挂载会请求 /api/health 与工作区数据（v7 真实数据优先）。 */
function mockFetch(
  routes: {
    health?: unknown;
    conversations?: unknown;
    friends?: unknown;
    incoming?: unknown;
    accept?: unknown;
  } = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/health") return Promise.resolve(jsonRes(routes.health ?? { ok: true }));
    if (url === "/api/conversations")
      return Promise.resolve(jsonRes(routes.conversations ?? []));
    if (url === "/api/friends/requests") return Promise.resolve(jsonRes(routes.incoming ?? []));
    if (url === "/api/friends") return Promise.resolve(jsonRes(routes.friends ?? []));
    if (/^\/api\/friends\/[^/]+\/accept$/.test(url))
      return Promise.resolve(jsonRes(routes.accept ?? {}));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useTokenUsageStore.getState().reset();
    useAuthStore.setState({ token: "t1", user, status: "authed", error: null });
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
      workspaceReady: false,
      workspaceError: null,
    });
  });

  it("渲染问候、欢迎文案、四张统计卡与两个徽标（真实数据）", async () => {
    mockFetch({
      conversations: [conv("c1"), conv("c2")],
      friends: [{ id: "f1", user: peer }],
    });
    useChatStore.setState({
      conversations: [conv("c1"), conv("c2")],
      friends: [{ id: "f1", user: peer }],
      incoming: [],
      messages: {},
    });
    useTokenUsageStore.getState().record("claude-sonnet-5", 700, now.toISOString());

    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新

    const h = new Date().getHours();
    const greeting = h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    expect(
      screen.getByRole("heading", { name: new RegExp(`${greeting}，${user.displayName}`) }),
    ).toBeInTheDocument();
    expect(screen.getByText(/欢迎使用和鸣/)).toBeInTheDocument();

    // 四张统计卡：会话总数/好友数 来自注入 store，智能体为 M3 前恒定 0
    expect(screen.getByText("会话总数")).toBeInTheDocument();
    expect(screen.getByText("好友数")).toBeInTheDocument();
    expect(screen.getByText("我的智能体")).toBeInTheDocument();
    expect(screen.getByText(/Token 用量/)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // 会话总数 = 注入的两条
    expect(screen.getByText("1")).toBeInTheDocument(); // 好友数 = 注入的一条
    expect(screen.queryByText("知识库文档")).not.toBeInTheDocument(); // v7 移除该卡

    // 徽标：应用版本（5 段，构建期注入）+ 今日已用来自真实日志
    expect(screen.getByText(`版本 ${__APP_VERSION__}`)).toBeInTheDocument();
    expect(screen.getByText(/今日已用 700/)).toBeInTheDocument();
  });

  it("个人视图显示当月汇总（读取时按月重算）", async () => {
    mockFetch();
    useTokenUsageStore.getState().record("claude-sonnet-5", 1200, at(1));
    useTokenUsageStore.getState().record("claude-sonnet-5", 800, at(13, 9));
    useTokenUsageStore.getState().record("deepseek-v3", 300, at(13, 10));
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    expect(screen.getByText("2.3")).toBeInTheDocument(); // 2300 tokens → 2.3K
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("2000")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("按日期：当月全日期行，零值天显示 0", async () => {
    mockFetch();
    useTokenUsageStore.getState().record("claude-sonnet-5", 1200, at(1));
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    fireEvent.click(screen.getByRole("button", { name: "按日期" }));

    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(daysOfMonth(monthKeyOf(new Date().toISOString())).length);

    const table = screen.getByRole("table"); // 资讯卡也有日期文本，限定在表格内查询
    const zeroRow = within(table).getByText(dayKey(15)).closest("tr") as HTMLElement;
    expect(within(zeroRow).getByText("0")).toBeInTheDocument();
    const day1Row = within(table).getByText(dayKey(1)).closest("tr") as HTMLElement;
    expect(within(day1Row).getByText("1200")).toBeInTheDocument();
  });

  it("点某行「查看」展开该行 byModel 明细", async () => {
    mockFetch();
    useTokenUsageStore.getState().record("claude-sonnet-5", 800, at(13, 9));
    useTokenUsageStore.getState().record("deepseek-v3", 300, at(13, 10));
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    fireEvent.click(screen.getByRole("button", { name: "按日期" }));

    const table = screen.getByRole("table"); // 资讯卡日期可能与表格日期撞文本，限定在表格内查询
    const row = within(table).getByText(dayKey(13)).closest("tr") as HTMLElement;
    expect(within(row).getByText("1100")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看" }));

    expect(await screen.findByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("800")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("最近会话：头像/对方名/最新预览/时间，且不显示未读角标", async () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      senderType: "user" as const,
      senderId: "u1",
      payload: { text: "你好，这是最近一条" },
      replyTo: null,
      createdAt: now.toISOString(),
      recalledAt: null,
      enc: "plain" as const,
    };
    // c1 有头像 → 圆形 <img>；c2 无头像 → 首字回退（替代人形图标）
    const convWithAvatar = {
      id: "c2",
      type: "direct" as const,
      peer: { ...peer, avatar: "data:image/png;base64,AAA" },
      unreadCount: 0,
    };
    useChatStore.setState({
      conversations: [conv("c1"), convWithAvatar],
      friends: [],
      incoming: [],
      messages: { c1: [msg] },
    });
    mockFetch({ conversations: [conv("c1"), convWithAvatar] });

    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新

    expect(screen.getByText("最近会话")).toBeInTheDocument();
    expect(screen.getByText("你好，这是最近一条")).toBeInTheDocument(); // c1 预览
    expect(screen.getByText("暂无消息")).toBeInTheDocument(); // c2 未加载消息
    const row = screen.getByText("你好，这是最近一条").closest("button") as HTMLElement;
    expect(row.textContent).toMatch(/\d{2}:\d{2}$/); // 右侧时间
    // c1 无头像：首字圆底「测」（peer 为测试阿丽），不渲染 img
    expect(within(row).getByText("测")).toBeInTheDocument();
    expect(row.querySelector("img")).toBeNull();
    // c2 有头像：圆形 <img> 指向 data URL
    const row2 = screen.getByText("暂无消息").closest("button") as HTMLElement;
    const img2 = row2.querySelector("img");
    expect(img2).not.toBeNull();
    expect(img2!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(screen.queryByLabelText(/条未读/)).not.toBeInTheDocument(); // unreadCount=0 → 不渲染角标
  });

  it("最近会话按 lastMessageAt 排序；未加载的消息不冒充「暂无消息」", async () => {
    const mkGroup = (id: string, name: string, lastMessageAt?: string) => ({
      id,
      type: "group" as const,
      name,
      memberCount: 2,
      unreadCount: 0,
      ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    });
    // 7 行：第 1 行最旧、第 7 行（数组末尾）最新——排序必须发生在 slice(0, 6) 之前
    const rows = [
      mkGroup("g-1", "最旧的群", "2026-10-19T00:00:00.000Z"),
      mkGroup("g-2", "第二旧的群", "2026-10-20T00:00:00.000Z"),
      mkGroup("g-3", "第三的群", "2026-10-21T00:00:00.000Z"),
      mkGroup("g-4", "第四的群", "2026-10-22T00:00:00.000Z"),
      mkGroup("g-5", "第五的群", "2026-10-23T00:00:00.000Z"),
      mkGroup("g-6", "次新的群", "2026-10-24T00:00:00.000Z"),
      mkGroup("g-fresh", "最新的群", "2026-10-25T00:00:00.000Z"),
    ];
    mockFetch({ conversations: rows });
    useChatStore.setState({ conversations: rows, messages: {}, workspaceReady: true });

    render(<HomePage />);
    await act(async () => {});

    const fresh = screen.getByText("最新的群").closest("button")!;
    const second = screen.getByText("次新的群").closest("button")!;
    expect(fresh.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 最旧的一条（原数组第 1 行）被截掉，而不是「最新一条落在末尾被截掉」
    expect(screen.queryByText("最旧的群")).not.toBeInTheDocument();
    expect(screen.getByText("第二旧的群")).toBeInTheDocument();

    // 有 lastMessageAt 但本机没加载消息 → 「点击查看消息」，不冒充「暂无消息」
    expect(screen.getAllByText("点击查看消息")).toHaveLength(6);
    // 行尾时间回退 lastMessageAt：有时间的 6 行都显示时间
    // （同日显示 HH:mm，跨日显示 MM-DD HH:mm，两种情况都接受）
    expect(screen.getAllByText(/^\d{2}(-\d{2})? \d{2}:\d{2}$/)).toHaveLength(6);

    // 真无消息的会话仍显示「暂无消息」，且排在有时间的会话之后（单独一轮，避免被前 6 名截掉）
    const empty = mkGroup("g-empty", "空群");
    act(() => useChatStore.setState({ conversations: [empty, rows[6]] }));
    const emptyBtn = screen.getByText("空群").closest("button")!;
    const freshWithTime = screen.getByText("最新的群").closest("button")!;
    expect(
      freshWithTime.compareDocumentPosition(emptyBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("暂无消息")).toBeInTheDocument();
  });

  it("K3：lastMessageAt 降序；等值保持原数组顺序；null/缺省置后且稳定（5 行不被截断）", async () => {
    const mk = (id: string, name: string, lastMessageAt?: string | null) => ({
      id,
      type: "group" as const,
      name,
      memberCount: 2,
      unreadCount: 0,
      ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    });
    const t1 = "2026-10-25T00:00:00.000Z";
    const t2 = "2026-10-26T00:00:00.000Z";
    // 输入顺序刻意与期望输出不同：不排序时本用例必红。
    const rows = [
      mk("k-missing", "缺省时间的群"), // 无字段 → 与 null 同为「空」
      mk("k-null", "空时间的群", null),
      mk("k-a", "并列甲", t1),
      mk("k-b", "并列乙", t1),
      mk("k-c", "并列丙", t2),
    ];
    mockFetch({ conversations: rows });
    useChatStore.setState({ conversations: rows, messages: {}, workspaceReady: true });

    render(<HomePage />);
    await act(async () => {});

    // 5 行都必须渲染（最近会话最多 6 行，不能被截掉）
    for (const name of ["并列丙", "并列甲", "并列乙", "缺省时间的群", "空时间的群"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }

    // 期望 DOM 顺序：c(t2) → a(t1) → b(t1，等值保持原序) → missing("") → null(""，等值保持原序)
    const btn = (name: string) => screen.getByText(name).closest("button")!;
    const order = ["并列丙", "并列甲", "并列乙", "缺省时间的群", "空时间的群"].map(btn);
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("最近会话预览：纯附件消息（text 空串）显示「(附件)」，无消息仍「暂无消息」", async () => {
    const attachMsg = {
      id: "m1",
      conversationId: "c1",
      senderType: "user" as const,
      senderId: "u1",
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
      replyTo: null,
      createdAt: now.toISOString(),
      recalledAt: null,
      enc: "plain" as const,
    };
    useChatStore.setState({
      conversations: [conv("c1"), conv("c2")],
      friends: [],
      incoming: [],
      messages: { c1: [attachMsg] },
    });
    mockFetch({ conversations: [conv("c1"), conv("c2")] });

    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("(附件)")).toBeInTheDocument(); // 空串不走 `??` 回退 → 用 `||` 口径
    expect(screen.getByText("暂无消息")).toBeInTheDocument(); // c2 无消息口径不受影响
  });

  it("最近会话预览：已撤回消息显示「消息已撤回」，不泄漏原文", async () => {
    const recalledMsg = {
      id: "m1",
      conversationId: "c1",
      senderType: "user" as const,
      senderId: "u1",
      payload: { text: "不该外泄的原文" },
      replyTo: null,
      createdAt: now.toISOString(),
      recalledAt: "2026-10-17T00:00:00.000Z",
      enc: "plain" as const,
    };
    useChatStore.setState({
      conversations: [conv("c1")],
      friends: [],
      incoming: [],
      messages: { c1: [recalledMsg] },
    });
    mockFetch({ conversations: [conv("c1")] });

    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("消息已撤回")).toBeInTheDocument(); // 与气泡文案一致
    expect(screen.queryByText("不该外泄的原文")).not.toBeInTheDocument();
  });

  it("最近会话行尾未读角标：unreadCount>0 黑底白字圆角数字，0 不渲染", async () => {
    const unreadConv = { id: "c3", type: "direct" as const, peer, unreadCount: 3 };
    const zeroConv = conv("c1");
    const rows = [zeroConv, unreadConv];
    useChatStore.setState({
      conversations: rows,
      friends: [],
      incoming: [],
      messages: { c1: [{ id: "m0", conversationId: "c1", senderType: "user", senderId: "u1", payload: { text: "c1 有历史" }, replyTo: null, createdAt: now.toISOString(), recalledAt: null, enc: "plain" }] },
    });
    mockFetch({ conversations: rows });

    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新

    const badge = screen.getByLabelText("3 条未读");
    expect(badge.textContent).toBe("3");
    expect(badge.className).toContain("bg-ink"); // 黑底白字圆角小徽标
    expect(badge.className).toContain("text-white");
    expect(badge.className).toContain("rounded-full");
    expect(screen.queryByLabelText("0 条未读")).not.toBeInTheDocument();

    // 行尾位置：徽标落在该会话行按钮内（c3 无消息 → 预览「暂无消息」唯一）
    const row = screen.getByText("暂无消息").closest("button") as HTMLElement;
    expect(row.contains(badge)).toBe(true);
  });

  it("最近会话空态提示去工作区", async () => {
    mockFetch();
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    expect(screen.getByText("暂无会话，从工作区开始")).toBeInTheDocument();
  });

  it("首帧未落地时显示加载骨架，不拿「暂无会话」冒充没数据", () => {
    // 三路请求全部挂住：workspaceReady 还是 false
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    render(<HomePage />);
    expect(screen.getAllByRole("status", { name: "正在加载" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("暂无会话，从工作区开始")).not.toBeInTheDocument();
    expect(screen.queryByText("没有待处理申请")).not.toBeInTheDocument();
  });

  it("首帧失败显示重试条；重试成功后回到正常空态", async () => {
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
      if (fail) return Promise.reject(new Error("网络中断"));
      if (url === "/api/conversations") return Promise.resolve(jsonRes([]));
      if (url === "/api/friends") return Promise.resolve(jsonRes([]));
      if (url === "/api/friends/requests") return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });
    render(<HomePage />);
    await act(async () => {});

    // 同一份首帧状态贴在两个区块上（最近会话 / 待处理），所以文案会重复出现
    expect(screen.getAllByText("加载失败：网络中断").length).toBeGreaterThan(0);
    expect(screen.queryByText("暂无会话，从工作区开始")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getAllByRole("button", { name: "重试" })[0]);
    await act(async () => {});
    expect(screen.queryByText("加载失败：网络中断")).not.toBeInTheDocument();
    expect(screen.getByText("暂无会话，从工作区开始")).toBeInTheDocument();
    expect(screen.getByText("没有待处理申请")).toBeInTheDocument();
  });

  it("主页含近 30 日用量热力图卡", async () => {
    mockFetch();
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    expect(screen.getByRole("img", { name: "近 30 日 token 用量" })).toBeInTheDocument();
    expect(screen.getByText("近 30 日用量")).toBeInTheDocument();
  });

  it("统计卡「我的智能体」接名册真实数量", async () => {
    mockFetch();
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
      agentsRoster: AGENT_ROSTER,
      agents: [AGENT_ROSTER[0]],
    });
    render(<HomePage />);
    await act(async () => {});

    // 名册 2 个（含系统预设）→ 统计卡显示 2
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("我的智能体")).toBeInTheDocument();
    expect(screen.getByText("含系统预设")).toBeInTheDocument();
    expect(screen.queryByText("M3 开放创建")).not.toBeInTheDocument();
  });

  it("智能体动态：群内已挂载的显示名+描述", async () => {
    mockFetch();
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
      agentsRoster: AGENT_ROSTER,
      agents: [AGENT_ROSTER[0]],
    });
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("智能体动态")).toBeInTheDocument();
    expect(screen.getByText("我的智能体甲")).toBeInTheDocument();
    expect(screen.getByText("帮我写代码")).toBeInTheDocument();
  });

  it("智能体动态：名册非空但群内无挂载时回退名册全量", async () => {
    mockFetch();
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
      agentsRoster: AGENT_ROSTER,
      agents: [],
    });
    render(<HomePage />);
    await act(async () => {});

    // 回退名册全量 → 显示前 3 个
    expect(screen.getByText("我的智能体甲")).toBeInTheDocument();
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
  });

  it("智能体动态：名册空时显示引导文案", async () => {
    mockFetch();
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
      agentsRoster: [],
      agents: [],
    });
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("智能体动态")).toBeInTheDocument();
    expect(screen.getByText("暂无智能体，可在工作区创建")).toBeInTheDocument();
    expect(screen.queryByText("M3 创建智能体后，动态显示在这里")).not.toBeInTheDocument();
  });

  it("右栏系统状态三行与资讯三卡", async () => {
    mockFetch();
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新

    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("没有待处理申请")).toBeInTheDocument();

    expect(screen.getByText("系统状态")).toBeInTheDocument();
    expect(screen.getByText("云端连接")).toBeInTheDocument();
    expect(await screen.findByText("正常")).toBeInTheDocument(); // mount 时 health 探测成功
    expect(screen.getByText("实时通道")).toBeInTheDocument();
    expect(screen.getByText("会话内连接")).toBeInTheDocument(); // 首页未连 ws，中性文案
    expect(screen.getByText("本地工作目录")).toBeInTheDocument();
    expect(screen.getByText("未绑定")).toBeInTheDocument();

    expect(screen.getByText("最新资讯")).toBeInTheDocument();
    expect(screen.getByText("和鸣 M1 内测版发布：IM + 通讯录先行")).toBeInTheDocument();
    expect(screen.getByText("三步创建你的第一个智能体")).toBeInTheDocument();
    expect(screen.getByText("用共享目录做会话附件投递")).toBeInTheDocument();
    expect(screen.getByText("官方")).toBeInTheDocument();
    expect(screen.getByText("教程")).toBeInTheDocument();
    expect(screen.getByText("技巧")).toBeInTheDocument();
  });

  it("待处理：展示真实申请并可接受（acceptFriend + 刷新工作区）", async () => {
    const req = { id: "r1", from: peer };
    const fetchMock = mockFetch({ incoming: [req] });
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [req],
      messages: {},
    });

    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    expect(screen.getByText("鲍勃")).toBeInTheDocument();
    expect(screen.getByText("@bob")).toBeInTheDocument();
    // 申请行头像：无 avatar → 首字「鲍」圆底（精确匹配，避开姓名文本）
    const reqRow = screen.getByText("@bob").closest("div") as HTMLElement;
    expect(within(reqRow).getByText("鲍")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/friends/r1/accept")).toBe(
        true,
      ),
    );
    // 接受后刷新工作区（再拉一次申请列表）
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/friends/requests").length,
      ).toBeGreaterThan(1),
    );
  });

  it("接受失败时 console.warn 提示，不吞错", async () => {
    const req = { id: "r1", from: peer };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (/\/api\/friends\/[^/]+\/accept$/.test(url))
        return Promise.resolve(jsonRes({ error: "boom" }, 500));
      if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
      if (url === "/api/friends/requests") return Promise.resolve(jsonRes([req])); // 刷新后申请仍在
      return Promise.resolve(jsonRes([]));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [req],
      messages: {},
    });

    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    fireEvent.click(screen.getByRole("button", { name: "接受" }));

    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith("接受好友申请失败", expect.any(Error)),
    );
  });

  it("今日只有未上报 → 徽标说「今日用量未上报」而不是 0，本月卡补「N 轮未上报」", async () => {
    mockFetch();
    useTokenUsageStore.getState().recordUnreported("claude-sonnet-5", now.toISOString());
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("今日用量未上报")).toBeInTheDocument();
    expect(screen.queryByText(/今日已用 0/)).not.toBeInTheDocument();
    expect(screen.getByText("1 轮未上报")).toBeInTheDocument();
  });

  it("今日有数字又有未上报 → 数字优先，未上报只作补充", async () => {
    mockFetch();
    useTokenUsageStore.getState().record("claude-sonnet-5", 500, now.toISOString());
    useTokenUsageStore.getState().recordUnreported("claude-sonnet-5", now.toISOString());
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("今日已用 500")).toBeInTheDocument();
    expect(screen.getByText("1 轮未上报")).toBeInTheDocument();
  });

  it("有草稿时首页预览显示「草稿：…」", async () => {
    const row = { id: "c1", type: "direct" as const, peer, unreadCount: 0 };
    mockFetch({ conversations: [row] });
    useChatStore.setState({ conversations: [row], messages: {}, workspaceReady: true });
    setDraft("c1", "还没发出去的一句话");
    const view = render(<HomePage />);
    try {
      await act(async () => {});
      expect(screen.getByText(/草稿：还没发出去的一句话/)).toBeInTheDocument();
    } finally {
      view.unmount();
      clearDraft("c1");
    }
  });

  it("挂载后写草稿：首页预览即时变成「草稿：…」，清掉后回到原预览", async () => {
    const row = { id: "c1", type: "direct" as const, peer, unreadCount: 0 };
    mockFetch({ conversations: [row] });
    useChatStore.setState({
      conversations: [row],
      messages: {
        c1: [
          {
            id: "m1",
            conversationId: "c1",
            senderType: "user" as const,
            senderId: "u2",
            payload: { text: "最后一条" },
            replyTo: null,
            createdAt: now.toISOString(),
            recalledAt: null,
            enc: "plain" as const,
          },
        ],
      },
      workspaceReady: true,
    });

    render(<HomePage />);
    try {
      await act(async () => {});
      expect(screen.getByText("最后一条")).toBeInTheDocument();

      act(() => {
        setDraft("c1", "临时草稿");
      });
      expect(screen.getByText(/草稿：临时草稿/)).toBeInTheDocument();

      act(() => {
        clearDraft("c1");
      });
      expect(screen.getByText("最后一条")).toBeInTheDocument();
    } finally {
      act(() => {
        clearDraft("c1"); // 断言中途失败也清掉，避免串用例
      });
    }
  });
});
