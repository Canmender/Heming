import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { GroupCreateModal } from "./GroupCreateModal.js";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";

const me = { id: "u1", username: "alice", displayName: "爱丽丝" };

describe("GroupCreateModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState({
      friends: [{ id: "f1", user: { id: "u2", username: "bob", displayName: "鲍勃" } }],
      conversations: [],
      agentsRoster: [],
    });
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
  });

  it("勾选好友提交后调用 createGroup 并关闭", async () => {
    const createGroup = vi.spyOn(useChatStore.getState(), "createGroup").mockResolvedValue("g1");
    const onClose = vi.fn();
    render(<GroupCreateModal open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("群名称"), { target: { value: "评审组" } });
    fireEvent.click(screen.getByLabelText("选择成员 鲍勃"));
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(createGroup).toHaveBeenCalledWith("评审组", ["u2"]));
    expect(onClose).toHaveBeenCalled();
  });

  it("未填名称不提交", () => {
    const createGroup = vi.spyOn(useChatStore.getState(), "createGroup");
    render(<GroupCreateModal open onClose={() => {}} />);
    fireEvent.click(screen.getByText("创建"));
    expect(createGroup).not.toHaveBeenCalled();
    expect(screen.getByText("请输入群名称")).toBeInTheDocument();
  });

  it("createGroup 失败时展示错误且不关闭", async () => {
    const createGroup = vi
      .spyOn(useChatStore.getState(), "createGroup")
      .mockRejectedValue(new Error("名称已存在"));
    const onClose = vi.fn();
    render(<GroupCreateModal open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("群名称"), { target: { value: "重名群" } });
    fireEvent.click(screen.getByText("创建"));
    expect(await screen.findByText("名称已存在")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(createGroup).toHaveBeenCalledWith("重名群", []);
  });

  it("提交 pending 期间禁用：同帧双击不重复调用、不误报名称错误", async () => {
    let resolveCreate: ((id: string) => void) | undefined;
    const createGroup = vi
      .spyOn(useChatStore.getState(), "createGroup")
      .mockImplementation(() => new Promise<string>((res) => {
        resolveCreate = res;
      }));
    const onClose = vi.fn();
    render(<GroupCreateModal open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("群名称"), { target: { value: "评审组" } });
    const submit = screen.getByRole("button", { name: "创建" });
    // 同一 act 内同步连点（模拟真实浏览器同帧双击：React 渲染/状态闭包尚未更新）
    act(() => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    expect(screen.queryByText("请输入群名称")).not.toBeInTheDocument();
    resolveCreate!("g1");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // —— M3 I2：勾选自建智能体入群 ——

  it("智能体段只列我自建的名册项（系统/他人不出现），勾选后创建并逐个 attach", async () => {
    useChatStore.setState({
      agentsRoster: [
        { id: "a-mine", owner_id: "u1", name: "架构师", avatar: null, description: "" },
        { id: "a-other", owner_id: "u9", name: "别人的", avatar: null, description: "" },
        { id: "system-assistant", owner_id: null, name: "和小鸣", avatar: null, description: "" },
      ],
    });
    const createGroup = vi.spyOn(useChatStore.getState(), "createGroup").mockResolvedValue("g7");
    const attach = vi
      .spyOn(useChatStore.getState(), "attachAgentToGroup")
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<GroupCreateModal open onClose={onClose} />);

    expect(screen.getByLabelText("选择智能体 架构师")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择智能体 别人的")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("选择智能体 和小鸣")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("群名称"), { target: { value: "带 agent 的群" } });
    fireEvent.click(screen.getByLabelText("选择成员 鲍勃"));
    fireEvent.click(screen.getByLabelText("选择智能体 架构师"));
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createGroup).toHaveBeenCalledWith("带 agent 的群", ["u2"]);
    // 先建群（拿到 convId）再挂载：attach(convId, agentId)
    expect(attach).toHaveBeenCalledWith("g7", "a-mine");
    expect(attach).toHaveBeenCalledTimes(1);
    expect(createGroup.mock.invocationCallOrder[0]).toBeLessThan(
      attach.mock.invocationCallOrder[0],
    );
  });

  it("attach 失败：群不回滚、弹窗保持打开并单独提示失败的智能体", async () => {
    useChatStore.setState({
      agentsRoster: [{ id: "a-mine", owner_id: "u1", name: "架构师", avatar: null, description: "" }],
    });
    vi.spyOn(useChatStore.getState(), "createGroup").mockResolvedValue("g8");
    const attach = vi
      .spyOn(useChatStore.getState(), "attachAgentToGroup")
      .mockRejectedValue(new Error("forbidden"));
    const onClose = vi.fn();
    render(<GroupCreateModal open onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("群名称"), { target: { value: "半失败群" } });
    fireEvent.click(screen.getByLabelText("选择智能体 架构师"));
    fireEvent.click(screen.getByText("创建"));

    expect(await screen.findByText(/群已创建，但部分智能体加入失败/)).toBeInTheDocument();
    expect(screen.getByText(/架构师（forbidden）/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled(); // 提示可见：弹窗不关（不回滚群）
    expect(attach).toHaveBeenCalledWith("g8", "a-mine");
    // 名称已清空：避免在错误提示下重提造成重复建群
    expect(screen.getByPlaceholderText("群名称")).toHaveValue("");
  });

  it("提交中：标题旁显示「提交中…」，Esc 与点遮罩都不关闭", async () => {
    let resolveCreate: ((id: string) => void) | undefined;
    vi.spyOn(useChatStore.getState(), "createGroup").mockImplementation(
      () => new Promise<string>((res) => {
        resolveCreate = res;
      }),
    );
    const onClose = vi.fn();
    render(<GroupCreateModal open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("群名称"), { target: { value: "评审组" } });
    fireEvent.click(screen.getByText("创建"));

    expect(await screen.findByText("提交中…")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "新建群聊" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    resolveCreate!("g1");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
