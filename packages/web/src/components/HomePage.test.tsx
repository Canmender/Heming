import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import type { TeamActivity, TeamMember, User } from "@heming/shared";
import { HomePage } from "./HomePage.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { useTaskStore } from "../lib/tasks/store.js";
import { useTokenUsageStore, monthKeyOf, daysOfMonth } from "../store/tokenUsage.js";
import { ONBOARDING_KEY, useOnboardingStore } from "../lib/onboarding.js";
import { FILE_ROOTS_KEY } from "../lib/fileEdit/roots.js";
import { fetchTeam, fetchTeamActivities } from "../lib/api.js";

// 团队名册与动向走 lib/api（首页真实数据优先）；health 探测仍走裸 fetch，单独 spy。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchTeam: vi.fn(), fetchTeamActivities: vi.fn() };
});

const user: User = { id: "u1", username: "alice", displayName: "测试阿丽" };
const bob: User = { id: "u2", username: "bob", displayName: "鲍勃" };

const member = (u: User, over: Partial<TeamMember> = {}): TeamMember => ({
  user: u,
  lastSeenAt: null,
  online: false,
  ...over,
});

const activity = (over: Partial<TeamActivity> = {}): TeamActivity => ({
  id: "act-1",
  actorId: "u2",
  kind: "task",
  title: "整理周报",
  detail: "已完成",
  sourceId: "src-1",
  occurredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
});

const AGENT_ROSTER = [
  {
    id: "a1",
    owner_id: "u1",
    name: "我的智能体甲",
    avatar: null,
    description: "帮我写代码",
  },
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

/** 首页挂载只裸取 /api/health；其余请求一律 404（团队数据已走 lib/api 的 mock）。 */
function mockHealth(ok = true) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
    Promise.resolve(
      String(input) === "/api/health"
        ? jsonRes({ ok }, ok ? 200 : 500) // 首页看的是 HTTP 状态（r.ok），不是响应体
        : jsonRes({ error: "not found" }, 404),
    ),
  );
}

/** 一次性喂好名册与动向（默认：阿丽在线、鲍勃离线，一条今天的任务动向）。 */
function mockTeam(
  members: TeamMember[] = [member(user, { online: true }), member(bob)],
  onlineCount = members.filter((m) => m.online).length,
  activities: TeamActivity[] = [activity()],
) {
  vi.mocked(fetchTeam).mockResolvedValue({ members, onlineCount });
  vi.mocked(fetchTeamActivities).mockResolvedValue({ activities });
}

/** 取统计卡：标题 → 卡片容器，避免与页面别处的同名区块（如「在线成员」列表）互串。
 *  d.68 起卡片外观收口到 `.ui-card`（圆角/描边/阴影改由 CSS 类给出，DOM 上不再逐字面量写）。 */
function statCard(title: string): HTMLElement {
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(".grid.grid-cols-4 > div.ui-card"),
  );
  const card = cards.find((c) => c.firstElementChild?.textContent === title);
  if (!card) throw new Error(`找不到统计卡：${title}`);
  return card;
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeamActivities).mockReset();
    useTokenUsageStore.getState().reset();
    // UX-A 首跑引导：默认「无连接 + 没关过」；每个用例显式决定，避免状态泄漏
    localStorage.removeItem(ONBOARDING_KEY);
    // 可写根是 localStorage 的全局状态：不清会漏到后面的用例（尤其新加的「文件可写目录」用例）
    localStorage.removeItem(FILE_ROOTS_KEY);
    useOnboardingStore.setState({ dismissedAt: null });
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useTaskStore.setState({ tasks: [] });
    useAuthStore.setState({ token: "t1", user, status: "authed", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
    useChatStore.setState({
      agentsRoster: AGENT_ROSTER,
      loadWorkspace: vi.fn(async () => undefined),
      loadAgentsRoster: vi.fn(async () => undefined),
    });
    mockHealth();
    mockTeam();
  });

  it("渲染问候、版本徽标、四张团队统计卡与今日用量", async () => {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    mockTeam(
      [member(user, { online: true }), member(bob)],
      1,
      [
        activity({ id: "a-today" }),
        activity({ id: "a-yesterday", title: "昨天的动向", occurredAt: yesterday.toISOString() }),
      ],
    );
    useTokenUsageStore.getState().record("claude-sonnet-5", 700, now.toISOString());

    render(<HomePage />);
    await act(async () => {}); // 冲刷挂载时 health/团队/工作区加载的异步状态更新

    const h = new Date().getHours();
    const greeting = h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    expect(
      screen.getByRole("heading", { name: new RegExp(`${greeting}，${user.displayName}`) }),
    ).toBeInTheDocument();

    // 四张卡：人数来自名册；今日动向只数「今天」的那条（昨天的不算）
    expect(within(statCard("团队成员")).getByText("2")).toBeInTheDocument();
    expect(within(statCard("在线成员")).getByText("1")).toBeInTheDocument();
    expect(within(statCard("我的智能体")).getByText("2")).toBeInTheDocument();
    expect(within(statCard("今日动向")).getByText("1")).toBeInTheDocument();
    expect(within(statCard("在线成员")).getByText("约 20 秒刷新")).toBeInTheDocument();

    expect(screen.getByText(`版本 ${__APP_VERSION__}`)).toBeInTheDocument();
    expect(screen.getByText("今日已用 700")).toBeInTheDocument();
  });

  it("团队动向：展示最近三条，点击行进入团队页", async () => {
    mockTeam(undefined, undefined, [
      activity({ id: "a1", title: "整理周报" }),
      activity({ id: "a2", title: "写完接口" }),
      activity({ id: "a3", title: "晨会纪要", kind: "agenda" }),
      activity({ id: "a4", title: "第四条不该出现" }),
    ]);
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("团队动向")).toBeInTheDocument();
    for (const title of ["整理周报", "写完接口", "晨会纪要"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.queryByText("第四条不该出现")).not.toBeInTheDocument();
    expect(screen.queryByText("AI")).not.toBeInTheDocument();
    expect(screen.getByText("日程")).toBeInTheDocument();

    fireEvent.click(screen.getByText("整理周报").closest("button")!);
    expect(useUiStore.getState().page).toBe("team");
  });

  it("智能体 / 幕僚类旧动向不在团队卡露出（团队只放真实成员）", async () => {
    mockTeam(undefined, undefined, [
      activity({ id: "a1", title: "写周报", kind: "agent" }),
      activity({ id: "a2", title: "晨间简报", kind: "staff" }),
    ]);
    render(<HomePage />);
    await act(async () => {});

    expect(screen.queryByText("写周报")).not.toBeInTheDocument();
    expect(screen.queryByText("晨间简报")).not.toBeInTheDocument();
    expect(screen.getByText(/还没有团队动向/)).toBeInTheDocument();
  });

  it("团队动向失败显示重试；重试成功后恢复列表", async () => {
    mockTeam(undefined, undefined, []);
    vi.mocked(fetchTeam).mockRejectedValueOnce(new Error("网络中断"));
    render(<HomePage />);
    await act(async () => {});

    // 动向区与在线成员区共用 teamError，文案会出现两次
    expect(screen.getAllByText("加载失败：网络中断").length).toBeGreaterThan(0);
    expect(screen.queryByText("还没有团队动向")).not.toBeInTheDocument();

    mockTeam(undefined, undefined, [activity({ title: "重试后的动向" })]);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});

    expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument();
    expect(screen.getByText("重试后的动向")).toBeInTheDocument();
  });

  it("团队动向空态提示开启共享，不冒充加载中", async () => {
    mockTeam(undefined, undefined, []);
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText(/还没有团队动向/)).toBeInTheDocument();
    expect(screen.queryAllByRole("status", { name: "正在加载" })).toHaveLength(0);
  });

  it("首帧未落地时显示加载骨架，不拿空态冒充没数据", () => {
    vi.mocked(fetchTeam).mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetchTeamActivities).mockImplementation(() => new Promise(() => {}));
    render(<HomePage />);

    expect(screen.getAllByRole("status", { name: "正在加载" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/还没有团队动向/)).not.toBeInTheDocument();
    expect(screen.queryByText("当前没有人在线")).not.toBeInTheDocument();
  });

  it("在线成员只列在线者；「全部名册」进入团队页", async () => {
    mockTeam([member(user, { online: true }), member(bob)], 1);
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.queryByText("@bob")).not.toBeInTheDocument(); // 离线不上榜

    fireEvent.click(screen.getByRole("button", { name: "全部名册" }));
    expect(useUiStore.getState().page).toBe("team");
  });

  it("「进入团队」按钮切到团队页", async () => {
    render(<HomePage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "进入团队" }));
    expect(useUiStore.getState().page).toBe("team");
  });

  it("智能体动态：名册前三个显示名称与描述；空名册给引导", async () => {
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("智能体动态")).toBeInTheDocument();
    expect(screen.getByText("我的智能体甲")).toBeInTheDocument();
    expect(screen.getByText("帮我写代码")).toBeInTheDocument();
    expect(screen.getByText("和小鸣")).toBeInTheDocument();

    act(() => useChatStore.setState({ agentsRoster: [] }));
    expect(screen.getByText("暂无智能体，可在智能体页创建")).toBeInTheDocument();
  });

  it("系统状态三行与最新资讯三卡", async () => {
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("系统状态")).toBeInTheDocument();
    expect(screen.getByText("云端连接")).toBeInTheDocument();
    expect(await screen.findByText("正常")).toBeInTheDocument();
    expect(screen.getByText("实时通道")).toBeInTheDocument();
    expect(screen.getByText("会话内连接")).toBeInTheDocument(); // 首页未连 ws，中性文案
    expect(screen.getByText("文件可写目录")).toBeInTheDocument();
    expect(screen.getByText("未绑定")).toBeInTheDocument();

    expect(screen.getByText("最新资讯")).toBeInTheDocument();
    expect(screen.getByText(/团队动向上线/)).toBeInTheDocument();
    expect(screen.getByText("怎么让团队看到你的动向")).toBeInTheDocument();
    expect(screen.getByText("用共享目录投递附件给智能体")).toBeInTheDocument();
    expect(screen.getByText("官方")).toBeInTheDocument();
    expect(screen.getByText("教程")).toBeInTheDocument();
    expect(screen.getByText("技巧")).toBeInTheDocument();
  });

  it("系统状态·文件可写目录读取真实可写根，不再永远写「未绑定」", async () => {
    localStorage.setItem(
      FILE_ROOTS_KEY,
      JSON.stringify({
        roots: [
          { name: "intro", path: "D:/notes", mode: "write" },
          { name: "ref", path: "D:/ref", mode: "read" },
        ],
        outOfRoot: "ask",
      }),
    );
    render(<HomePage />);
    await act(async () => {});
    // 只有 write 根算「智能体能改哪些文件」，只读根不计入
    expect(screen.getByText("已绑定 1 个")).toBeInTheDocument();
    expect(screen.queryByText("未绑定")).not.toBeInTheDocument();
  });

  it("云端探测失败时状态显示「失败」", async () => {
    mockHealth(false);
    render(<HomePage />);
    expect(await screen.findByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("正常")).not.toBeInTheDocument();
  });

  it("个人视图显示当月汇总（读取时按月重算）", async () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 1200, at(1));
    useTokenUsageStore.getState().record("claude-sonnet-5", 800, at(13, 9));
    useTokenUsageStore.getState().record("deepseek-v3", 300, at(13, 10));
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("2.3")).toBeInTheDocument(); // 2300 tokens → 2.3K
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("2000")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText(/本月已用/)).toBeInTheDocument();
  });

  it("按日期：当月全日期行，零值天显示 0", async () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 1200, at(1));
    render(<HomePage />);
    await act(async () => {});
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
    useTokenUsageStore.getState().record("claude-sonnet-5", 800, at(13, 9));
    useTokenUsageStore.getState().record("deepseek-v3", 300, at(13, 10));
    render(<HomePage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "按日期" }));

    const table = screen.getByRole("table");
    const row = within(table).getByText(dayKey(13)).closest("tr") as HTMLElement;
    expect(within(row).getByText("1100")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看" }));

    expect(await screen.findByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("800")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("主页含近 30 日用量热力图卡", async () => {
    render(<HomePage />);
    await act(async () => {});
    expect(screen.getByRole("img", { name: "近 30 日 token 用量" })).toBeInTheDocument();
    expect(screen.getByText("近 30 日用量")).toBeInTheDocument();
  });

  it("今日只有未上报 → 徽标说「今日用量未上报」而不是 0，本月卡补「N 轮未上报」", async () => {
    useTokenUsageStore.getState().recordUnreported("claude-sonnet-5", now.toISOString());
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("今日用量未上报")).toBeInTheDocument();
    expect(screen.queryByText(/今日已用 0/)).not.toBeInTheDocument();
    expect(screen.getByText("1 轮未上报")).toBeInTheDocument();
  });

  it("今日有数字又有未上报 → 数字优先，未上报只作补充", async () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 500, now.toISOString());
    useTokenUsageStore.getState().recordUnreported("claude-sonnet-5", now.toISOString());
    render(<HomePage />);
    await act(async () => {});

    expect(screen.getByText("今日已用 500")).toBeInTheDocument();
    expect(screen.getByText("1 轮未上报")).toBeInTheDocument();
  });

  it("健康探测与团队请求互不牵连：团队失败不影响云端状态", async () => {
    mockTeam(undefined, undefined, []);
    vi.mocked(fetchTeam).mockRejectedValue(new Error("团队接口挂了"));
    render(<HomePage />);
    await act(async () => {});

    await waitFor(() => expect(screen.getByText("正常")).toBeInTheDocument());
    expect(screen.getAllByText("加载失败：团队接口挂了").length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------- UX-A 首跑引导（U1） */

  it("没有任何模型连接：首跑引导卡出现，三步骤齐全且按钮可直达", async () => {
    render(<HomePage />);
    await act(async () => {});

    const card = screen.getByRole("region", { name: "开始使用" });
    expect(within(card).getByText("配置模型连接")).toBeInTheDocument();
    expect(within(card).getByText("和智能体对话")).toBeInTheDocument();
    expect(within(card).getByText("建第一个任务")).toBeInTheDocument();
    expect(within(card).getByText(/0\/3\s*已完成/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "去配置模型" }));
    expect(useUiStore.getState().page).toBe("settings");
  });

  it("引导步骤状态来自真实 store：有会话/有任务时对应步骤标已完成", async () => {
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: { id: "system-assistant", name: "和小鸣", avatar: null, owner_id: null, description: "" },
          unreadCount: 0,
        },
      ] as never,
    });
    useTaskStore.setState({
      tasks: [
        {
          id: "t1",
          conversationId: "c1",
          agentId: "system-assistant",
          agentName: "和小鸣",
          title: "任务",
          prompt: "做一个任务",
          status: "done",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          steps: [],
        },
      ],
    });

    render(<HomePage />);
    await act(async () => {});
    const card = screen.getByRole("region", { name: "开始使用" });
    // 2/3 完成（会话 + 任务），只有「配置模型连接」还没做
    expect(within(card).getByText(/2\/3\s*已完成/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "去配置模型" })).toBeEnabled();
  });

  it("已有模型连接：引导卡不再出现（只服务首跑）", async () => {
    useLlmStore.setState({
      profiles: [{ id: "p1", label: "本地", provider: "openai", apiKey: "k", model: "m" }],
      bindings: {},
    });
    render(<HomePage />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "开始使用" })).toBeNull();
  });

  it("点「不再显示」：卡片立刻消失，且只在本机记一个时间戳（重新挂载仍不出现）", async () => {
    const { unmount } = render(<HomePage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "不再显示" }));
    expect(screen.queryByRole("region", { name: "开始使用" })).toBeNull();
    expect(typeof useOnboardingStore.getState().dismissedAt).toBe("number");

    const raw = JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? "{}") as {
      dismissedAt?: number;
    };
    expect(typeof raw.dismissedAt).toBe("number");

    unmount();
    render(<HomePage />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "开始使用" })).toBeNull();
  });
});
