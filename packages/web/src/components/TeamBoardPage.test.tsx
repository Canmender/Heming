import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamActivity, TeamMember } from "@heming/shared";
import { TeamBoardPage } from "./TeamBoardPage.js";
import { useUiStore } from "../store/ui.js";
import { fetchTeam, fetchTeamActivities } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({
  fetchTeam: vi.fn(),
  fetchTeamActivities: vi.fn(),
}));

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
  useUiStore.setState({ page: "workspace", activeConversationId: null });
});

describe("团队看板", () => {
  it("展示真实成员与今日任务/日程，不收智能体动向", async () => {
    render(<TeamBoardPage />);

    expect(screen.getByText("团队看板")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());
    expect(screen.getByText("周五交材料")).toBeInTheDocument();
    expect(screen.getAllByText("爱丽丝").length).toBeGreaterThan(0);
    expect(screen.getAllByText("鲍勃").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 人在线/)).toBeInTheDocument();
    // 昨日任务默认不显示；智能体轨迹永远不会进来
    expect(screen.queryByText("昨天的任务")).not.toBeInTheDocument();
    expect(screen.queryByText("智能体轨迹")).not.toBeInTheDocument();
    expect(fetchTeamActivities).toHaveBeenCalledWith({ limit: 100 });
  });

  it("切到全部后可看更早动向，并能按成员与关键词过滤", async () => {
    render(<TeamBoardPage />);
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

  it("给出团队动向与通用智能体入口", async () => {
    render(<TeamBoardPage />);
    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "成员动向" }));
    expect(useUiStore.getState().page).toBe("team");

    useUiStore.setState({ page: "workspace" });
    fireEvent.click(screen.getByRole("button", { name: "去通用智能体" }));
    expect(useUiStore.getState().page).toBe("tasks");
  });

  it("加载失败时显示错误并可重试", async () => {
    vi.mocked(fetchTeam).mockRejectedValueOnce(new Error("服务端不可用"));
    render(<TeamBoardPage />);

    expect(await screen.findByText(/看板加载失败：服务端不可用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("整理会议纪要")).toBeInTheDocument());
  });
});
