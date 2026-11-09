import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CollabView } from "./CollabView.js";
import { useLlmStore } from "../../store/llm.js";
import { useUiStore } from "../../store/ui.js";
import { COLLAB_HISTORY_KEY } from "../../lib/collaboration/history.js";

/**
 * 协作工作台 UI：参与者选择/缺省、未绑定禁选、开始按钮门禁、
 * 模板填充，以及「真的跑一遍」的集成（ask 用 mock 替身，编排器是真实实现）。
 */
vi.mock("../../lib/collaboration/run.js", () => ({
  createCollaborationAsk: () => async (
    agentId: string,
    _messages: unknown,
    _signal: unknown,
    meta?: { turnId?: string; agentName?: string },
  ) => `产出：${meta?.agentName ?? agentId}-${meta?.turnId ?? ""}`,
}));

const profile = { id: "p1", label: "本地", provider: "openai" as const, apiKey: "k", model: "m" };

const agents = [
  { id: "a1", owner_id: "u1", name: "调研员", avatar: null, description: "" },
  { id: "a2", owner_id: "u1", name: "方案师", avatar: null, description: "" },
  { id: "a3", owner_id: "u1", name: "评审员", avatar: null, description: "" },
];

beforeEach(() => {
  localStorage.clear();
  useLlmStore.setState({
    profiles: [profile as never],
    bindings: { a1: "p1", a2: "p1", a3: "p1" },
    prompts: {},
    routes: [],
  });
  useUiStore.setState({ page: "chat", pageView: null });
});

describe("协作工作台 · 配置与门禁", () => {
  it("可用智能体不足 2 个：显示引导而不是空表单", () => {
    useLlmStore.setState({ bindings: { a1: "p1" } });
    render(<CollabView agents={agents as never} />);
    expect(screen.getByText("至少需要 2 个已绑定模型的智能体")).toBeInTheDocument();
    expect(screen.getByText(/当前可用 1 个/)).toBeInTheDocument();
    expect(screen.queryByLabelText("协作设置")).toBeNull();
  });

  it("可用智能体 ≥2：默认选中前两位；未绑定的成员禁选并标明原因", () => {
    useLlmStore.setState({ bindings: { a1: "p1", a2: "p1" } });
    render(<CollabView agents={agents as never} />);

    const first = screen.getByRole("checkbox", { name: /调研员/ });
    const second = screen.getByRole("checkbox", { name: /方案师/ });
    const third = screen.getByRole("checkbox", { name: /评审员/ });
    expect(first).toBeChecked();
    expect(second).toBeChecked();
    expect(third).toBeDisabled();
    expect(screen.getByText("未绑定模型，先绑定才能参与")).toBeInTheDocument();
  });

  it("任务为空时开始按钮禁用；填好后可用；运行中禁用编辑并显示状态", async () => {
    render(<CollabView agents={agents as never} />);
    const start = screen.getByRole("button", { name: "开始协作" });
    expect(start).toBeDisabled();
    expect(screen.getByRole("button", { name: "中止" })).toBeDisabled();

    const textarea = screen.getByLabelText("任务描述（必填）");
    fireEvent.change(textarea, { target: { value: "整理季度复盘" } });
    expect(start).toBeEnabled();

    fireEvent.click(start);
    // 运行中：编辑禁用、中止可用、状态用 role=status 播报
    expect(textarea).toBeDisabled();
    expect(screen.getByRole("button", { name: "中止" })).toBeEnabled();
    expect(screen.getByRole("status").textContent).toContain("正在协作");

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已完成"));
    expect(textarea).toBeEnabled();
    // 两位参与者 → 两张回合卡，正文来自真实编排器 + mock ask
    expect(screen.getByRole("article", { name: /调研员/ })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /方案师/ })).toBeInTheDocument();
  });

  it("协作模板一键填充任务/模式/轮数并自动选人", () => {
    render(<CollabView agents={agents as never} />);
    fireEvent.click(screen.getByRole("button", { name: "事实核查 → 反方 → 综合" }));

    expect(screen.getByLabelText("任务描述（必填）")).toHaveValue(
      "先核查事实与证据，再由反方提出最强反驳，最后综合出稳妥结论。",
    );
    expect(screen.getByRole("radio", { name: /评审团/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("协作轮数")).toHaveValue("1");
    expect(screen.getByRole("button", { name: "开始协作" })).toBeEnabled();
  });

  it("跑完后纪要写入本机 localStorage（最近一次）", async () => {
    render(<CollabView agents={agents as never} />);
    fireEvent.change(screen.getByLabelText("任务描述（必填）"), {
      target: { value: "联调检查" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始协作" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已完成"));
    const raw = window.localStorage.getItem(COLLAB_HISTORY_KEY);
    expect(raw).toContain("联调检查");
    expect(raw).not.toContain("sk-");
  });
});
