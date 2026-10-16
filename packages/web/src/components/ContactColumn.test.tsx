import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, User } from "@heming/shared";
import { ContactColumn } from "./ContactColumn.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";

const me: User = { id: "me", username: "me", displayName: "我" };
const bob: User = { id: "u1", username: "bob", displayName: "鲍勃" };
const aZhi: Agent = { id: "a1", owner_id: "me", name: "阿智", avatar: null, description: "" };

describe("ContactColumn", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useChatStore.setState({
      conversations: [
        { id: "g1", type: "group", name: "群一", memberCount: 2, unreadCount: 0 },
      ] as never,
      friends: [{ id: "f1", user: bob }] as never,
      agentsRoster: [aZhi] as never,
      agentIdsInGroups: new Set<string>(),
      messages: {},
    });
    useUiStore.setState({ detailContact: { kind: "human", id: "u1" } });
  });

  it("上至下 群聊/人类/智能体 分段并以分割线划分", () => {
    render(<ContactColumn />);
    const labels = screen.getAllByText(/群聊|人类|智能体/).map((n) => n.textContent);
    expect(labels.slice(0, 3)).toEqual(["群聊", "人类", "智能体"]);
    expect(screen.getByText("群一")).toBeTruthy();
    expect(screen.getByText("鲍勃")).toBeTruthy();
    expect(screen.getByText("阿智")).toBeTruthy();
  });

  it("点头像切 detailContact", () => {
    render(<ContactColumn />);
    fireEvent.click(screen.getByLabelText("查看 群一"));
    expect(useUiStore.getState().detailContact).toEqual({ kind: "group", id: "g1" });
  });

  it("当前项高亮（aria-current）", () => {
    render(<ContactColumn />);
    expect(screen.getByLabelText("查看 鲍勃").getAttribute("aria-current")).toBe("true");
    // getAttribute 缺失时返回 null（非字符串 "null"）——brief 笔误按事实修正
    expect(screen.getByLabelText("查看 群一").getAttribute("aria-current")).toBeNull();
  });
});
