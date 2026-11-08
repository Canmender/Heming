import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TeamActivity, TeamMember } from "@heming/shared";
import { TeamBoardView, type TeamBoardViewProps } from "./TeamBoardPage.js";

/**
 * 看板测试（d.109 起是**受控视图**）：
 * 数据、名册、选中成员都由宿主 `TeamPage` 提供，本视图只做筛选与两列展示，
 * 不再自己 fetch / 轮询。因此这里不需要 mock `lib/api.js`——组件没有网络调用。
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
    detail: "任务 · 进行中",
    status: "running",
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
  detail: "日程 · 今天到期",
  status: "today",
  occurredAt: new Date().toISOString(),
});
const yesterdayTask = activity({
  id: "a3",
  kind: "task",
  title: "昨天的任务",
  occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
});
const agentActivity = activity({ id: "a4", kind: "agent", title: "智能体轨迹" });

function renderBoard(over: Partial<TeamBoardViewProps> = {}) {
  const props: TeamBoardViewProps = {
    members: [alice, bob],
    onlineCount: 1,
    activities: [todayTask, todayAgenda, yesterdayTask, agentActivity],
    selectedId: null,
    onSelectMember: vi.fn(),
    ready: true,
    error: "",
    onRetry: vi.fn(),
    ...over,
  };
  render(<TeamBoardView {...props} />);
  return props;
}

describe("团队看板视图（受控，d.109）", () => {
  it("用宿主数据展示今日任务/日程，不收智能体动向，也不显示重复隐私 footer", () => {
    renderBoard();

    expect(screen.getByText("整理会议纪要")).toBeInTheDocument();
    expect(screen.getByText("周五交材料")).toBeInTheDocument();
    expect(screen.getAllByText("爱丽丝").length).toBeGreaterThan(0);
    expect(screen.getAllByText("鲍勃").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 人在线/)).toBeInTheDocument();
    // 昨日任务默认不显示；智能体轨迹永远不会进来
    expect(screen.queryByText("昨天的任务")).not.toBeInTheDocument();
    expect(screen.queryByText("智能体轨迹")).not.toBeInTheDocument();
    // 两列结构还在
    expect(screen.getByRole("region", { name: "任务" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "日程" })).toBeInTheDocument();
    // 顶部说明保留一处，底部重复句已删
    expect(screen.getByText(/只含成员主动共享的任务/)).toBeInTheDocument();
    expect(screen.queryByText(/看板数据来自团队成员主动共享的摘要/)).toBeNull();
  });

  it("成员 chips 用宿主 selectedId 高亮，并通过 onSelectMember 回传", () => {
    const props = renderBoard({ selectedId: bob.user.id });
    const chipRow = screen.getByRole("button", { name: "全部成员" }).parentElement as HTMLElement;
    const bobChip = within(chipRow).getByRole("button", { name: /鲍勃/ });
    expect(bobChip).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(chipRow).getByRole("button", { name: "全部成员" }));
    expect(props.onSelectMember).toHaveBeenCalledWith(null);
  });

  it("点未选中的成员 chip 回传该成员；再点已选中的则取消", () => {
    const props = renderBoard({ selectedId: null });
    const chipRow = screen.getByRole("button", { name: "全部成员" }).parentElement as HTMLElement;
    fireEvent.click(within(chipRow).getByRole("button", { name: /鲍勃/ }));
    expect(props.onSelectMember).toHaveBeenCalledWith(bob.user.id);
  });

  it("点卡片 = 选中该成员（键盘可点）", () => {
    const props = renderBoard();
    fireEvent.click(screen.getByRole("button", { name: /整理会议纪要/ }));
    expect(props.onSelectMember).toHaveBeenCalledWith(alice.user.id);
  });

  it("筛选共用宿主选中的成员：只显示他的条目", () => {
    renderBoard({ selectedId: bob.user.id });
    expect(screen.getByText("周五交材料")).toBeInTheDocument();
    expect(screen.queryByText("整理会议纪要")).not.toBeInTheDocument();
    expect(screen.getByText(/鲍勃 · 任务/)).toBeInTheDocument();
  });

  it("加载/错误/重试都由宿主状态驱动", () => {
    const { unmount } = render(<TeamBoardView {...{
      members: [alice, bob],
      onlineCount: 1,
      activities: [],
      selectedId: null,
      onSelectMember: vi.fn(),
      ready: false,
      error: "",
      onRetry: vi.fn(),
    }} />);
    expect(screen.getByRole("status", { name: "正在加载" })).toBeInTheDocument();
    unmount();

    const props = renderBoard({ ready: true, error: "服务端不可用" });
    expect(screen.getByRole("alert")).toHaveTextContent("看板加载失败：服务端不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("空态两列 + 关键词按标题/派生摘要过滤（不回显 detail 正文）", () => {
    renderBoard({ activities: [] });
    expect(screen.getByText("还没有任务摘要。")).toBeInTheDocument();
    expect(screen.getByText("还没有日程摘要。")).toBeInTheDocument();
  });

  it("搜索命中派生摘要；detail 自由文本不参与展示", () => {
    const sneaky = activity({
      id: "s1",
      title: "某任务",
      status: "done",
      detail: "这是不该显示的正文片段",
    });
    renderBoard({ activities: [sneaky] });
    expect(screen.getByText("任务 · 已完成")).toBeInTheDocument();
    expect(screen.queryByText(/不该显示的正文/)).toBeNull();

    fireEvent.change(screen.getByLabelText("搜索看板"), { target: { value: "已完成" } });
    expect(screen.getByText("某任务")).toBeInTheDocument();
  });

  it("成员 chips 单行横向滚动（1100 窄窗不折行）", () => {
    renderBoard();
    const chipRow = screen.getByRole("button", { name: "全部成员" }).parentElement as HTMLElement;
    expect(chipRow.className).toContain("overflow-x-auto");
    expect(chipRow.className).toContain("flex-nowrap");
  });
});
