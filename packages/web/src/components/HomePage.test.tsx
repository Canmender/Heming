import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { User } from "@heming/shared";
import { HomePage } from "./HomePage.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useTokenUsageStore, monthKeyOf, daysOfMonth } from "../store/tokenUsage.js";

const user: User = { id: "u1", username: "alice", displayName: "测试阿丽" };
const peer: User = { id: "u2", username: "bob", displayName: "鲍勃" };

// conversations 为联合类型（M2）：direct 夹具补 unreadCount
const conv = (id: string) => ({ id, type: "direct" as const, peer: user, unreadCount: 0 });

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

    // 徽标：版本静态 + 今日已用来自真实日志
    expect(screen.getByText("版本 v0.1.0")).toBeInTheDocument();
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
    expect(screen.queryByText(/未读/)).not.toBeInTheDocument(); // M1 无未读角标
  });

  it("最近会话空态提示去工作区", async () => {
    mockFetch();
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新
    expect(screen.getByText("暂无会话，从工作区开始")).toBeInTheDocument();
  });

  it("右栏智能体动态空态、系统状态三行与资讯三卡", async () => {
    mockFetch();
    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/工作区加载的异步状态更新

    expect(screen.getByText("智能体动态")).toBeInTheDocument();
    expect(screen.getByText("M3 创建智能体后，动态显示在这里")).toBeInTheDocument();

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
});
