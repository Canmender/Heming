import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, User } from "@heming/shared";
import { ContactDetail } from "./ContactDetail.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

const bob: User = { id: "u1", username: "bob", displayName: "鲍勃" };
const aZhi: Agent = { id: "a1", owner_id: "me", name: "阿智", avatar: null, description: "助手" };

describe("ContactDetail", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "workspace",
      navCollapsed: false,
      activeConversationId: null,
      contactsHidden: false,
      detailContact: null,
    });
    useChatStore.setState({
      conversations: [
        { id: "g1", type: "group", name: "群一", memberCount: 3, unreadCount: 0 },
      ] as never,
      friends: [{ id: "f1", user: bob }] as never,
      agentsRoster: [aZhi] as never,
      agentIdsInGroups: new Set<string>(["a1"]),
      messages: {},
    });
  });

  it("human 详情显示昵称/@用户名与发消息", () => {
    render(<ContactDetail target={{ kind: "human", id: "u1" }} />);
    expect(screen.getByText("鲍勃")).toBeTruthy();
    // 副标题为组合文本「人类 · @bob」：子串匹配
    expect(screen.getByText(/@bob/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "发消息" })).toBeTruthy();
  });

  it("group 详情显示人数；点发消息打开会话", () => {
    render(<ContactDetail target={{ kind: "group", id: "g1" }} />);
    expect(screen.getByText(/3 人/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发消息" }));
    expect(useUiStore.getState().activeConversationId).toBe("g1");
    expect(useUiStore.getState().page).toBe("chat");
  });

  it("agent 详情显示简介，发消息禁用，返回雷达可用", () => {
    useUiStore.setState({ detailContact: { kind: "agent", id: "a1" } });
    render(<ContactDetail target={{ kind: "agent", id: "a1" }} />);
    expect(screen.getByText("助手")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发消息" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "返回雷达" }));
    expect(useUiStore.getState().detailContact).toBeNull();
  });
});
