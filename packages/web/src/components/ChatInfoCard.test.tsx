import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatInfoCard } from "./ChatInfoCard.js";
import { isMuted, resetConvPrefsForTest } from "../lib/convPrefs.js";
import type { Conversation } from "@heming/shared";

const direct = {
  id: "c1", type: "direct", unreadCount: 0,
  peer: { id: "u2", username: "bob", displayName: "鲍勃" },
} as unknown as Conversation;

const group = {
  id: "g1", type: "group", unreadCount: 0, name: "群聊组", memberCount: 5,
} as unknown as Conversation;

describe("ChatInfoCard", () => {
  it("direct 显示昵称与 @用户名", () => {
    render(<ChatInfoCard conv={direct} onClose={() => {}} />);
    expect(screen.getByText("鲍勃")).toBeTruthy();
    expect(screen.getByText("@bob")).toBeTruthy();
  });
  it("group 显示群名与人数", () => {
    render(<ChatInfoCard conv={group} onClose={() => {}} />);
    expect(screen.getByText("群聊组")).toBeTruthy();
    expect(screen.getByText(/5 人/)).toBeTruthy();
  });
  it("点关闭调用 onClose", () => {
    const onClose = vi.fn();
    render(<ChatInfoCard conv={direct} onClose={onClose} />);
    expect(screen.getByText("关闭")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("关闭会话信息"));
    expect(onClose).toHaveBeenCalled();
  });

  it("免打扰开关：读写本机偏好，aria-checked 与文案随动", () => {
    localStorage.clear();
    resetConvPrefsForTest();
    const { unmount } = render(<ChatInfoCard conv={direct} onClose={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "免打扰" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("免打扰")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("已开启免打扰")).toBeInTheDocument();
    expect(isMuted("c1")).toBe(true);

    unmount();
    resetConvPrefsForTest();
    localStorage.clear();
  });
});
