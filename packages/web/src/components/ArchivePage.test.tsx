import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Conversation } from "@heming/shared";
import { ArchivePage } from "./ArchivePage";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

/**
 * 归档页的契约。
 *
 * 重点：
 * 1. 只显示**已归档**的（未归档的不该混进来）；
 * 2. 按归档时间倒序（刚收起来的最可能要找）；
 * 3. 搜索只过滤这一页，不改数据；
 * 4. 恢复走服务端 + 全量刷新，失败要说出来。
 */

const archiveConversation = vi.fn(async (_id: string, _archived: boolean) => {});
// 只覆盖 archiveConversation，其余导出保持真实——
// 整模块 mock 会切断 auth store 依赖的 getToken，测试还没开始就挂。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    archiveConversation: (id: string, archived: boolean) => archiveConversation(id, archived),
  };
});

const loadWorkspace = vi.fn(async () => {});

function directConv(id: string, name: string, archivedAt?: string | null): Conversation {
  return {
    id,
    type: "direct",
    peer: {
      id: `u-${id}`,
      username: `u-${id}`,
      displayName: name,
      avatar: undefined,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    unreadCount: 0,
    archivedAt: archivedAt ?? null,
  } as Conversation;
}

function prime(convs: Conversation[], state: Partial<ReturnType<typeof useChatStore.getState>> = {}) {
  useChatStore.setState({
    conversations: convs,
    loadWorkspace,
    workspaceReady: true,
    workspaceError: null,
    ...state,
  });
}

describe("ArchivePage", () => {
  beforeEach(() => {
    archiveConversation.mockClear();
    loadWorkspace.mockClear();
    useUiStore.setState({ openTabs: [], activeConversationId: null });
  });
  afterEach(() => {
    cleanup();
  });

  it("没有归档会话时给出空状态与操作提示", () => {
    prime([directConv("c1", "张三")]);
    render(<ArchivePage />);
    expect(screen.getByText("还没有归档的会话。")).toBeTruthy();
    expect(screen.getByText(/在会话标签上点「归档」/)).toBeTruthy();
  });

  it("首帧加载中显示骨架，不拿「还没有归档」冒充没数据", () => {
    prime([], { workspaceReady: false, workspaceError: null });
    render(<ArchivePage />);
    expect(screen.getByRole("status", { name: "正在加载归档" })).toBeTruthy();
    expect(screen.queryByText("还没有归档的会话。")).toBeNull();
    expect(screen.getByText("加载中…")).toBeTruthy();
  });

  it("首帧失败显示「加载失败 + 重试」，重试成功后回到正常空态", async () => {
    prime([], { workspaceReady: false, workspaceError: "网络中断" });
    render(<ArchivePage />);
    expect(screen.getByRole("alert")).toHaveTextContent("加载失败：网络中断");
    expect(screen.queryByText("还没有归档的会话。")).toBeNull();

    loadWorkspace.mockImplementationOnce(async () => {
      useChatStore.setState({ workspaceReady: true, workspaceError: null });
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(loadWorkspace).toHaveBeenCalledTimes(2); // 挂载一次 + 重试一次
    await waitFor(() => expect(screen.getByText("还没有归档的会话。")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("只列出已归档的会话", () => {
    prime([
      directConv("c1", "已归档的", "2026-10-01T00:00:00.000Z"),
      directConv("c2", "还在列表的"),
    ]);
    render(<ArchivePage />);
    expect(screen.getByText("已归档的")).toBeTruthy();
    expect(screen.queryByText("还在列表的")).toBeNull();
  });

  it("按归档时间倒序：最近归档的排最前", () => {
    prime([
      directConv("old", "早归档的", "2026-09-01T00:00:00.000Z"),
      directConv("new", "晚归档的", "2026-10-15T00:00:00.000Z"),
    ]);
    render(<ArchivePage />);
    const names = screen.getAllByRole("button", { name: /打开会话/ }).map((b) => b.textContent ?? "");
    expect(names[0]).toContain("晚归档的");
    expect(names[1]).toContain("早归档的");
  });

  it("显示归档日期与类型", () => {
    prime([directConv("c1", "张三", "2026-10-15T08:30:00.000Z")]);
    render(<ArchivePage />);
    expect(screen.getByText(/归档于 2026-10-15/)).toBeTruthy();
    expect(screen.getByText(/好友/)).toBeTruthy();
  });

  it("搜索按名字过滤，清空后恢复", () => {
    prime([
      directConv("a", "张三", "2026-10-01T00:00:00.000Z"),
      directConv("b", "李四", "2026-10-02T00:00:00.000Z"),
    ]);
    render(<ArchivePage />);
    const search = screen.getByLabelText("搜索归档会话");
    fireEvent.change(search, { target: { value: "李" } });
    expect(screen.getByText("李四")).toBeTruthy();
    expect(screen.queryByText("张三")).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("张三")).toBeTruthy();
  });

  it("搜索无结果时说明是搜索的问题，不是没归档", () => {
    prime([directConv("a", "张三", "2026-10-01T00:00:00.000Z")]);
    render(<ArchivePage />);
    fireEvent.change(screen.getByLabelText("搜索归档会话"), { target: { value: "不存在" } });
    expect(screen.getByText(/没有匹配「不存在」/)).toBeTruthy();
  });

  it("恢复：调服务端取消归档，并刷新列表", async () => {
    prime([directConv("c1", "张三", "2026-10-01T00:00:00.000Z")]);
    render(<ArchivePage />);
    fireEvent.click(screen.getByLabelText(/恢复会话 张三/));
    await waitFor(() => expect(archiveConversation).toHaveBeenCalledWith("c1", false));
    await waitFor(() => expect(loadWorkspace).toHaveBeenCalled());
  });

  it("恢复失败要提示，不能静默", async () => {
    archiveConversation.mockRejectedValueOnce(new Error("网络不可达"));
    prime([directConv("c1", "张三", "2026-10-01T00:00:00.000Z")]);
    render(<ArchivePage />);
    fireEvent.click(screen.getByLabelText(/恢复会话 张三/));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/恢复失败.*网络不可达/));
  });

  it("点击条目打开该会话", () => {
    prime([directConv("c9", "张三", "2026-10-01T00:00:00.000Z")]);
    render(<ArchivePage />);
    fireEvent.click(screen.getByLabelText(/打开会话 张三/));
    expect(useUiStore.getState().activeConversationId).toBe("c9");
  });

  it("头部显示归档总数", () => {
    prime([
      directConv("a", "甲", "2026-10-01T00:00:00.000Z"),
      directConv("b", "乙", "2026-10-02T00:00:00.000Z"),
      directConv("c", "未归档"),
    ]);
    render(<ArchivePage />);
    expect(screen.getByText("2 个已归档会话")).toBeTruthy();
  });
});