import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamActivity, TeamMember } from "@heming/shared";
import { TeamBoardView } from "./TeamBoardPage.js";
import { fetchTeam, fetchTeamActivities } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({
  fetchTeam: vi.fn(),
  fetchTeamActivities: vi.fn(),
}));

/**
 * 看板测试（d.67 导航合并后）：
 * 主体是嵌进团队页 Tab 的 `TeamBoardView`——它不该再画自己的 PageShell / 页头标题，
 * 只要筛选条 + 两列卡片 + 加载/错误/空态。
 */

const alice: TeamMember = {
  user: { id: "u1", username: "alice", displayName: "爱丽丝" },
  lastSeenAt: new Date().toISOString(),
  online: true,
};

const bob: TeamMember = {
  user: { id: "u2", username: "bob", displayName: "鲍勃" },
  lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
  online: false,
};

function activity(overrides: Partial<TeamActivity>): TeamActivity {
  const now = new Date().toISOString();
  return {
    id: "a1",
    actorId: "u1",
    kind: "task",
    title: "整理会议纪要",
    detail: "按项目分组",
    sourceId: "s1",
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}

const todayTask = activity({ id: "a1", kind: "task", title: "整理会议纪要" });
const todayAgenda = activity({
  id: "a2",
  kind: "agenda",
  actorId: "u2",
  title: "周五交材料",
  detail: "办公室",
  occurredAt: new Date().toISOString(),
});
const yesterdayTask = activity({
  id: "a3",
  kind: "task",
  title: "昨天的任务",
  occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
});
const agentActivity = activity({ id: "a4", kind: "agent", title: "智能体轨迹" });

beforeEach(() => {
  vi.mocked(fetchTeam).mockResolvedValue({ members: [alice, bob], onlineCount: 1 });
  vi.mocked(fetchTeamActivities).mockResolvedValue({
    activities: [todayTask, todayAgenda, yesterdayTask, agentActivity],
  });
});

describe("团队看板视图（嵌入态）", () => {
  it("展示真实成员与今日任务/日程，不收智能体动向", async () => {
    render(<TeamBoardView />);

    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());
    expect(screen.getByText("周五交材料")).toBeInTheDocument();
    expect(screen.getAllByText("爱丽丝").length).toBeGreaterThan(0);
    expect(screen.getAllByText("鲍勃").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 人在线/)).toBeInTheDocument();
    // 昨日任务默认不显示；智能体轨迹永远不会进来
    expect(screen.queryByText("昨天的任务")).not.toBeInTheDocument();
    expect(screen.queryByText("智能体轨迹")).not.toBeInTheDocument();
    expect(fetchTeamActivities).toHaveBeenCalledWith({ limit: 100 });
    // 两列结构还在
    expect(screen.getByRole("region", { name: "任务" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "日程" })).toBeInTheDocument();
  });

  it("嵌入后不画自己的页头：没有 h1、没有「团队看板」标题", async () => {
    render(<TeamBoardView />);
    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.queryByText("团队看板")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-page-title")).toBeNull();
    // 但摘要文案仍要让用户看到统计口径
    expect(screen.getByText(/2 名真实成员/)).toBeInTheDocument();
  });

  it("切到全部后可看更早动向，并能按成员与关键词过滤", async () => {
    render(<TeamBoardView />);
    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByText("昨天的任务")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /鲍勃/ }));
    expect(screen.getByText("周五交材料")).toBeInTheDocument();
    expect(screen.queryByText("整理会议纪要")).not.toBeInTheDocument();
    expect(screen.queryByText("昨天的任务")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部成员" }));
    fireEvent.change(screen.getByLabelText("搜索看板"), { target: { value: "昨天" } });
    expect(screen.getByText("昨天的任务")).toBeInTheDocument();
    expect(screen.queryByText("周五交材料")).not.toBeInTheDocument();
  });

  it("加载中给骨架屏，加载失败给错误与重试", async () => {
    vi.mocked(fetchTeam).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(fetchTeamActivities).mockImplementationOnce(() => new Promise(() => {}));
    const { unmount } = render(<TeamBoardView />);
    expect(screen.getByRole("status", { name: "正在加载" })).toBeInTheDocument();
    unmount();

    vi.mocked(fetchTeam).mockRejectedValueOnce(new Error("服务端不可用"));
    render(<TeamBoardView />);
    expect(await screen.findByText(/看板加载失败：服务端不可用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());
  });

  it("没有摘要时给两列空态，刷新按钮会重新取数", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [] });
    render(<TeamBoardView />);

    expect(await screen.findByText("还没有任务摘要。")).toBeInTheDocument();
    expect(screen.getByText("还没有日程摘要。")).toBeInTheDocument();

    vi.mocked(fetchTeamActivities).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(fetchTeamActivities).toHaveBeenCalled());
  });
});
