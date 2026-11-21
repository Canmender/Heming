import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamMember, TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import { fetchWorkspaceTeam, updateTeamTask } from "../../lib/api.js";
import { TeamTaskBoard } from "./TeamTaskBoard.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return {
    ...actual,
    fetchWorkspaceTeam: vi.fn(),
    updateTeamTask: vi.fn(),
  };
});

const me = { id: "u1", username: "admin", displayName: "阿鸣" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const iso = "2026-11-07T10:00:00.000Z";

const members: TeamMember[] = [
  { user: me, lastSeenAt: iso, online: true },
  { user: bob, lastSeenAt: iso, online: false },
];

function task(over: Partial<TeamTask>): TeamTask {
  return {
    id: "k1",
    teamId: "t1",
    planId: null,
    title: "写周报初稿",
    detail: "",
    assigneeId: me.id,
    status: "todo",
    priority: "normal",
    createdBy: me.id,
    createdAt: iso,
    updatedAt: iso,
    dueAt: null,
    attachmentFileId: null,
    ...over,
  };
}

function snapshot(tasks: TeamTask[]): TeamWorkspaceSnapshot {
  return {
    team: {
      id: "t1",
      name: "小组",
      goal: "",
      ownerId: me.id,
      createdAt: iso,
      updatedAt: iso,
    },
    members: [
      { user: me, role: "owner", joinedAt: iso },
      { user: bob, role: "member", joinedAt: iso },
    ],
    plans: [],
    tasks,
  };
}

/** 模拟一次 HTML5 拖放：把卡片拖到目标列。 */
function dragCardTo(card: HTMLElement, targetColumn: HTMLElement) {
  const data: Record<string, string> = {};
  const dataTransfer = {
    setData: (k: string, v: string) => {
      data[k] = v;
    },
    getData: (k: string) => data[k] ?? "",
    effectAllowed: "move",
  };
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(targetColumn, { dataTransfer });
  fireEvent.drop(targetColumn, { dataTransfer });
}

beforeEach(() => {
  vi.mocked(fetchWorkspaceTeam).mockReset().mockResolvedValue(snapshot([]));
  vi.mocked(updateTeamTask).mockReset();
});

describe("TeamTaskBoard 真任务看板", () => {
  it("读真正的 team_tasks 按状态分列，而不是读动向摘要", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([
        task({ id: "k1", title: "写周报初稿", status: "todo", assigneeId: me.id }),
        task({ id: "k2", title: "正在改的 bug", status: "doing", assigneeId: bob.id }),
        task({ id: "k3", title: "卡在依赖", status: "blocked" }),
        task({ id: "k4", title: "等验收的活", status: "done", reviewState: "pending" }),
        task({ id: "k5", title: "已验收的活", status: "done", reviewState: "approved" }),
      ]),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);

    expect(await screen.findByText("写周报初稿")).toBeInTheDocument();
    expect(screen.getByText("正在改的 bug")).toBeInTheDocument();
    // 待验收 = done + reviewState pending；已完成 = done + approved
    expect(within(screen.getByRole("region", { name: "待验收" })).getByText("等验收的活")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "已完成" })).getByText("已验收的活")).toBeInTheDocument();
    expect(fetchWorkspaceTeam).toHaveBeenCalledWith("t1");
  });

  it("拖动待开始卡片到进行中 → 调 updateTeamTask status:doing，本地状态随之更新", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "k1", title: "写周报初稿", status: "todo", assigneeId: me.id })]),
    );
    vi.mocked(updateTeamTask).mockImplementation(async (_tid, _id, body) =>
      task({ id: "k1", title: "写周报初稿", status: "doing", assigneeId: me.id, ...body }),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    const card = await screen.findByTestId("board-card-k1");
    const doing = screen.getByRole("region", { name: "进行中" });

    dragCardTo(card, doing);

    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { status: "doing" }),
    );
    await waitFor(() =>
      expect(within(doing).getByText("写周报初稿")).toBeInTheDocument(),
    );
  });

  it("拖到待验收 = 交活，status 写 done（不直接完成），提示等组长验收", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "k1", title: "写周报初稿", status: "doing", assigneeId: me.id })]),
    );
    vi.mocked(updateTeamTask).mockImplementation(async (_tid, _id, body) =>
      task({ id: "k1", title: "写周报初稿", status: "done", reviewState: "pending", ...body }),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    const card = await screen.findByTestId("board-card-k1");
    const review = screen.getByRole("region", { name: "待验收" });

    dragCardTo(card, review);

    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { status: "done" }),
    );
    expect(await screen.findByText(/已交上去，等组长验收/)).toBeInTheDocument();
  });

  it("已完成/已交的任务拖回待认领被挡：给出解释、不发请求（复用收紧后的状态机）", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([
        task({ id: "k5", title: "已验收的活", status: "done", reviewState: "approved", assigneeId: me.id }),
      ]),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    const card = await screen.findByTestId("board-card-k5");
    const todo = screen.getByRole("region", { name: "待开始" });

    dragCardTo(card, todo);

    expect(updateTeamTask).not.toHaveBeenCalled();
    expect(screen.getByText(/让组长打回重做/)).toBeInTheDocument();
  });

  it("拖到「已完成」列被挡：验收只能由组长做，不能拖进去", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "k1", title: "写周报初稿", status: "doing", assigneeId: me.id })]),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    const card = await screen.findByTestId("board-card-k1");
    const done = screen.getByRole("region", { name: "已完成" });

    dragCardTo(card, done);

    expect(updateTeamTask).not.toHaveBeenCalled();
    expect(screen.getByText(/要靠组长验收通过/)).toBeInTheDocument();
  });

  it("非组长不能拖别人的任务：卡片不可拖、拖动被拦", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "k2", title: "别人的任务", status: "todo", assigneeId: bob.id })]),
    );
    // 当前用户是 me，但队长是 bob → me 是非组长，不能拖 bob 名下的任务
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={bob.id} />);
    const card = await screen.findByTestId("board-card-k2");

    expect(card).toHaveAttribute("draggable", "false");
    const doing = screen.getByRole("region", { name: "进行中" });
    dragCardTo(card, doing);
    expect(updateTeamTask).not.toHaveBeenCalled();
  });

  it("点卡片标题打开只读详情（与看板同源，不发新请求、可关闭）", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([
        task({
          id: "k1",
          title: "写周报初稿",
          status: "doing",
          assigneeId: me.id,
          detail: "把本周进展汇总成一页",
          progress: "已列完大纲",
          dueAt: "2099-01-01T00:00:00.000Z",
        }),
      ]),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    await screen.findByText("写周报初稿");

    fireEvent.click(screen.getByRole("button", { name: "查看任务详情 写周报初稿" }));

    const dialog = screen.getByRole("dialog", { name: "任务详情" });
    expect(within(dialog).getByText("把本周进展汇总成一页")).toBeInTheDocument();
    expect(within(dialog).getByText("已列完大纲")).toBeInTheDocument();
    expect(within(dialog).getByText("阿鸣")).toBeInTheDocument();
    // 只读详情不发新请求：整轮只拉过一次列表
    expect(fetchWorkspaceTeam).toHaveBeenCalledTimes(1);
    expect(updateTeamTask).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
  });

  it("详情里的「到工作台处理」回调宿主切到工作台，并关掉详情", async () => {
    const onOpenWorkbench = vi.fn();
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "k1", title: "写周报初稿", status: "todo", assigneeId: me.id })]),
    );
    render(
      <TeamTaskBoard
        teamId="t1"
        members={members}
        currentUserId={me.id}
        ownerId={me.id}
        onOpenWorkbench={onOpenWorkbench}
      />,
    );
    await screen.findByText("写周报初稿");
    fireEvent.click(screen.getByRole("button", { name: "查看任务详情 写周报初稿" }));

    const dialog = screen.getByRole("dialog", { name: "任务详情" });
    fireEvent.click(within(dialog).getByRole("button", { name: /到工作台处理/ }));

    expect(onOpenWorkbench).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
  });

  it("未传 onOpenWorkbench 时不显示「到工作台处理」（独立嵌入场景不报错）", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "k1", title: "写周报初稿", status: "todo", assigneeId: me.id })]),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    await screen.findByText("写周报初稿");
    fireEvent.click(screen.getByRole("button", { name: "查看任务详情 写周报初稿" }));

    const dialog = screen.getByRole("dialog", { name: "任务详情" });
    expect(within(dialog).queryByRole("button", { name: /到工作台处理/ })).not.toBeInTheDocument();
  });

  it("按方案筛选：只显示该方案下的任务，并可只看独立任务", async () => {
    const snap = snapshot([
      task({ id: "p1", title: "方案内的活", planId: "plan-1", status: "todo" }),
      task({ id: "p2", title: "另一方案的活", planId: "plan-2", status: "todo" }),
      task({ id: "p3", title: "没有方案的散活", planId: null, status: "todo" }),
    ]);
    snap.plans = [
      { id: "plan-1", teamId: "t1", title: "方案甲", detail: "", status: "doing", orderIndex: 0, createdBy: me.id, createdAt: iso, updatedAt: iso },
      { id: "plan-2", teamId: "t1", title: "方案乙", detail: "", status: "doing", orderIndex: 1, createdBy: me.id, createdAt: iso, updatedAt: iso },
    ];
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snap);
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    await screen.findByText("方案内的活");

    fireEvent.change(screen.getByLabelText("按方案筛选看板"), { target: { value: "plan-1" } });
    expect(screen.getByText("方案内的活")).toBeInTheDocument();
    expect(screen.queryByText("另一方案的活")).not.toBeInTheDocument();
    expect(screen.queryByText("没有方案的散活")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("按方案筛选看板"), { target: { value: "__none__" } });
    expect(screen.getByText("没有方案的散活")).toBeInTheDocument();
    expect(screen.queryByText("方案内的活")).not.toBeInTheDocument();
  });

  it("卡片显示所属方案，独立任务不显示（一眼看清任务挂在哪个方案下）", async () => {
    const snap = snapshot([
      task({ id: "p1", title: "方案内的活", planId: "plan-1", status: "todo" }),
      task({ id: "p3", title: "没有方案的散活", planId: null, status: "todo" }),
    ]);
    snap.plans = [
      { id: "plan-1", teamId: "t1", title: "方案甲", detail: "", status: "doing", orderIndex: 0, createdBy: me.id, createdAt: iso, updatedAt: iso },
    ];
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snap);
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    await screen.findByText("方案内的活");

    const card = screen.getByTestId("board-card-p1");
    expect(within(card).getByText(/方案 · 方案甲/)).toBeInTheDocument();
    const standalone = screen.getByTestId("board-card-p3");
    expect(within(standalone).queryByText(/方案 ·/)).not.toBeInTheDocument();
  });

  it("切换团队会清空筛选条件与打开的详情（筛选不串到别的团队）", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([task({ id: "a1", title: "A 队的活", status: "todo", assigneeId: bob.id })]),
    );
    const view = render(
      <TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />,
    );
    await screen.findByText("A 队的活");

    // 在 t1 上打开详情，并设置「只看逾期 + 按鲍勃筛选」。
    fireEvent.click(screen.getByRole("button", { name: "查看任务详情 A 队的活" }));
    expect(await screen.findByRole("dialog", { name: "任务详情" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("按负责人筛选看板"), { target: { value: bob.id } });
    fireEvent.click(screen.getByRole("button", { name: "只看逾期" }));

    // 切到 t2：新队的数据回来，筛选应清空、详情应关闭。
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue({
      ...snapshot([task({ id: "b1", title: "B 队的活", planId: null, status: "todo", assigneeId: me.id })]),
      team: { ...snapshot([]).team, id: "t2", name: "B 队" },
    });
    view.rerender(
      <TeamTaskBoard teamId="t2" members={members} currentUserId={me.id} ownerId={me.id} />,
    );
    await screen.findByText("B 队的活");

    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("按负责人筛选看板")).toHaveValue("");
    expect(screen.getByRole("button", { name: "只看逾期" })).toHaveAttribute("aria-pressed", "false");
  });

  it("只看逾期：只留逾期任务；已完成的不算逾期", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot([
        task({ id: "o1", title: "逾期未做", status: "todo", dueAt: past }),
        task({ id: "o2", title: "没到期", status: "todo", dueAt: "2099-01-01T00:00:00.000Z" }),
        task({ id: "o3", title: "逾期已完成", status: "done", reviewState: "approved", dueAt: past }),
      ]),
    );
    render(<TeamTaskBoard teamId="t1" members={members} currentUserId={me.id} ownerId={me.id} />);
    await screen.findByText("逾期未做");

    fireEvent.click(screen.getByRole("button", { name: "只看逾期" }));
    expect(screen.getByText("逾期未做")).toBeInTheDocument();
    expect(screen.queryByText("没到期")).not.toBeInTheDocument();
    expect(screen.queryByText("逾期已完成")).not.toBeInTheDocument();
  });
});
