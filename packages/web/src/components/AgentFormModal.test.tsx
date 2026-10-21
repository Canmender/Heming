import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AgentFormModal } from "./AgentFormModal.js";
import { useLlmStore } from "../store/llm.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";

describe("AgentFormModal", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useAuthStore.setState({ user: { id: "u1", username: "alice", displayName: "爱丽丝" }, status: "authed" });
    useUiStore.setState({ page: "chat" });
    vi.restoreAllMocks();
  });

  it("无 LLM 连接时提示去设置页；有连接时可选并保存", async () => {
    const { rerender } = render(<AgentFormModal open mode="create" onClose={() => {}} />);
    expect(screen.getByText(/去设置页添加/)).toBeInTheDocument();

    useLlmStore.getState().addProfile({ id: "p1", label: "主模型", provider: "openai", apiKey: "k", model: "m" });
    rerender(<AgentFormModal open mode="create" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "架构师" } });
    fireEvent.change(screen.getByLabelText("系统提示词（仅本机）"), { target: { value: "你是架构师" } });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "" }), {
        status: 201, headers: { "content-type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem("heming.agentPrompts")!)["a1"]).toBe("你是架构师");
  });

  it("「去设置页添加」点击后切到设置页并关闭弹窗", () => {
    const onClose = vi.fn();
    render(<AgentFormModal open mode="create" onClose={onClose} />);
    fireEvent.click(screen.getByText(/去设置页添加/));
    expect(useUiStore.getState().page).toBe("settings");
    expect(onClose).toHaveBeenCalled();
  });

  it("编辑系统 owner 时显示删除，非 owner 不显示", () => {
    render(<AgentFormModal open mode="edit" agent={{ id: "a1", owner_id: "someone", name: "别人的", avatar: null, description: "" }} onClose={() => {}} />);
    expect(screen.queryByText("删除智能体")).not.toBeInTheDocument();
  });

  it("owner 编辑：预填名称/提示词，删除走应用内确认后调 deleteAgent", async () => {
    useLlmStore.setState({
      prompts: { a1: "旧提示" },
      bindings: {},
      profiles: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const onClose = vi.fn();
    render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "d" }}
        onClose={onClose}
      />,
    );
    expect(screen.getByLabelText("名称")).toHaveValue("架构师");
    expect(screen.getByLabelText("系统提示词（仅本机）")).toHaveValue("旧提示");

    fireEvent.click(screen.getByText("删除智能体"));
    // 不弹系统框；确认之前不发请求
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "删除智能体" });
    expect(within(dialog).getByText(/此操作不可恢复/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/agents/a1");
    expect(init?.method).toBe("DELETE");
    expect(onClose).toHaveBeenCalled();
  });

  it("应用内确认点「取消」：弹窗关闭，不删除", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "" }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("删除智能体"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除智能体" })).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "删除智能体" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("名称为空不提交", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<AgentFormModal open mode="create" onClose={() => {}} />);
    fireEvent.click(screen.getByText("创建"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/请输入名称/)).toBeInTheDocument();
  });
});
