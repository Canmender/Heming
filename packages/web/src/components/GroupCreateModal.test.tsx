import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GroupCreateModal } from "./GroupCreateModal.js";
import { useChatStore } from "../store/chat.js";

describe("GroupCreateModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState({
      friends: [{ id: "f1", user: { id: "u2", username: "bob", displayName: "鲍勃" } }],
      conversations: [],
    });
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
});
