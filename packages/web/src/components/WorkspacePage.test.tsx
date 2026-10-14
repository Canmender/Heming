import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { User } from "@heming/shared";
import { WorkspacePage } from "./WorkspacePage.js";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const peerNoAvatar: User = { id: "u2", username: "bob", displayName: "鲍勃" };
const peerWithAvatar: User = {
  id: "u3",
  username: "carol",
  displayName: "卡罗",
  avatar: "data:image/png;base64,AAA",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** WorkspacePage 挂载会 loadWorkspace：拉好友/申请/会话列表。 */
function mockFetch(routes: { friends?: unknown; incoming?: unknown; conversations?: unknown } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/friends") return Promise.resolve(jsonRes(routes.friends ?? []));
    if (url === "/api/friends/requests") return Promise.resolve(jsonRes(routes.incoming ?? []));
    if (url === "/api/conversations") return Promise.resolve(jsonRes(routes.conversations ?? []));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

describe("WorkspacePage 头像贯穿", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
    });
  });

  it("好友行/会话行/申请行：无头像显示首字圆底，有头像显示 <img>", async () => {
    mockFetch({
      friends: [
        { id: "f1", user: peerNoAvatar },
        { id: "f2", user: peerWithAvatar },
      ],
      incoming: [{ id: "r1", from: peerNoAvatar }],
      conversations: [{ id: "c1", type: "direct", peer: peerWithAvatar }],
    });
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer: peerWithAvatar }],
      friends: [
        { id: "f1", user: peerNoAvatar },
        { id: "f2", user: peerWithAvatar },
      ],
      incoming: [{ id: "r1", from: peerNoAvatar }],
      messages: {},
    });

    const { container } = render(<WorkspacePage />);
    // 好友行 + 会话行各一处「卡罗」（loadWorkspace 异步就绪）
    await waitFor(() => expect(screen.getAllByText("卡罗")).toHaveLength(2));

    // 无头像：好友行/申请行显示首字「鲍」圆底（替代人形图标；精确匹配避开「鲍勃」姓名文本）
    // 行定位：好友行在 <button> 内，申请行不在按钮内（旁边是「接受」按钮）
    const bobSpans = screen.getAllByText("鲍勃");
    expect(bobSpans).toHaveLength(2);
    const friendRow = bobSpans.find((s) => s.closest("button"))!.closest("button") as HTMLElement;
    const requestRow = bobSpans.find((s) => !s.closest("button"))!.closest("div") as HTMLElement;
    expect(within(friendRow).getByText("鲍")).toBeInTheDocument();
    expect(friendRow.querySelector("img")).toBeNull();
    expect(within(requestRow).getByText("鲍")).toBeInTheDocument();
    expect(requestRow.querySelector("img")).toBeNull();

    // 有头像：好友行（好友区第一处「卡罗」）与会话行（直聊区第二处）均渲染圆形 <img>
    const carolSpans = screen.getAllByText("卡罗"); // 好友行 + 会话行各一处
    expect(carolSpans).toHaveLength(2);
    const carolFriendRow = carolSpans[0].closest("button") as HTMLElement;
    const friendImg = carolFriendRow.querySelector("img");
    expect(friendImg).not.toBeNull();
    expect(friendImg!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    const convRow = carolSpans[1].closest("button") as HTMLElement;
    const convImg = convRow.querySelector("img");
    expect(convImg).not.toBeNull();
    expect(convImg!.getAttribute("src")).toBe("data:image/png;base64,AAA");

    // 全页无残留人形图标（头像位统一为首字/图片）
    expect(container.querySelector("svg")).toBeNull();
  });
});
