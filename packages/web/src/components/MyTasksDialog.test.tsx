import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AssignedTeamTask } from "../lib/team/assignedTasks.js";
import { MyTasksDialog } from "./MyTasksDialog.js";

/**
 * 「我的任务」面板（d.259）：列表、空态、读失败三种状态。
 * 网络只有 `GET /api/team/my-tasks` 一处，用 fetch spy 给返回体。
 */

const task: AssignedTeamTask = {
  teamId: "t1",
  teamName: "产品组",
  task: {
    id: "k1",
    title: "整理接口文档",
    detail: "把 v2 的接口整理成一份 md",
    status: "todo",
    dueAt: null,
    assigneeId: "u2",
  },
};

const claimableTask: AssignedTeamTask = {
  teamId: "t1",
  teamName: "产品组",
  task: {
    id: "k2",
    title: "没人接的活",
    detail: "",
    status: "todo",
    dueAt: null,
    assigneeId: null,
  },
};

function jsonRes(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("我的任务面板", () => {
  it("列出派到名下的任务，点一条把 prompt 交给父组件", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => jsonRes({ tasks: [task] }));
    const onPick = vi.fn();
    render(<MyTasksDialog onClose={() => {}} onPick={onPick} />);

    expect(await screen.findByText("整理接口文档")).toBeTruthy();
    expect(screen.getByText(/产品组/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/team/my-tasks", expect.anything());

    fireEvent.click(screen.getByTestId("my-task-k1"));
    expect(onPick).toHaveBeenCalledTimes(1);
    const [item, prompt] = onPick.mock.calls[0] as [AssignedTeamTask, string];
    expect(item.task.id).toBe("k1");
    expect(prompt).toContain("请接着做这条团队任务");
    expect(prompt).toContain("整理接口文档");
  });

  it("没有任务时说清楚「现在没有」，不假装读到了", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonRes({ tasks: [] }));
    render(<MyTasksDialog onClose={() => {}} onPick={() => {}} />);
    const empty = await screen.findByTestId("my-tasks-empty");
    expect(empty.textContent).toContain("现在没有派到你名下的任务");
  });

  it("读失败与「没有任务」分开说", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    );
    render(<MyTasksDialog onClose={() => {}} onPick={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("my-tasks-error")).toBeTruthy());
    expect(screen.getByTestId("my-tasks-error").textContent).toContain("没读到团队任务");
  });
});

describe("我的任务面板（队里待认领，d.260）", () => {
  it("把队里没人认领的活单列一段，点一条先要求认领再动手", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonRes({ tasks: [task], claimable: [claimableTask] }),
    );
    const onPick = vi.fn();
    render(<MyTasksDialog onClose={() => {}} onPick={onPick} />);

    expect(await screen.findByTestId("claimable-heading")).toBeTruthy();
    expect(screen.getByTestId("claimable-heading").textContent).toContain("队里待认领（1）");
    expect(screen.getByText("没人接的活")).toBeTruthy();

    fireEvent.click(screen.getByTestId("claimable-task-k2"));
    expect(onPick).toHaveBeenCalledTimes(1);
    const [item, prompt] = onPick.mock.calls[0] as [AssignedTeamTask, string];
    expect(item.task.id).toBe("k2");
    expect(prompt).toContain("先认领");
    expect(prompt).toContain("assignee_id");
  });

  it("只有待认领的活时也不算空（空态文案只在两边都没有时出现）", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonRes({ tasks: [], claimable: [claimableTask] }),
    );
    render(<MyTasksDialog onClose={() => {}} onPick={() => {}} />);
    expect(await screen.findByTestId("claimable-heading")).toBeTruthy();
    expect(screen.queryByTestId("my-tasks-empty")).toBeNull();
  });
});
