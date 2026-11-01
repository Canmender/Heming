import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NotificationCenter, formatRelativeTime } from "./NotificationCenter.js";
import { setNotificationStorage, useNotificationStore } from "../store/notifications.js";
import { createMemoryStorage } from "../lib/memory/storage.js";
import { useUiStore } from "../store/ui.js";
import type { AppNotification } from "../store/notifications.js";

function makeItem(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: `ntf-${Math.random().toString(36).slice(2, 8)}`,
    kind: "message",
    key: `k-${Math.random().toString(36).slice(2, 8)}`,
    title: "鲍勃",
    body: "在吗",
    createdAt: Date.now(),
    read: false,
    conversationId: "c1",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  setNotificationStorage(createMemoryStorage());
  useNotificationStore.setState({ items: [] });
  useUiStore.setState({ page: "home", activeConversationId: null, openTabs: [], taskFocusId: null });
});

describe("formatRelativeTime", () => {
  it("一分钟内在内算刚刚，往后按分/时/日递进", () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 59_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 60_000, now)).toBe("1 分钟前");
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe("59 分钟前");
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe("1 小时前");
    // 超过 24 小时改日期：按本地时区取月/日（测试不断言具体数字，只断言形状）
    expect(formatRelativeTime(now - 25 * 3600_000, now)).toMatch(/^\d+月\d+日$/);
  });

  it("未来时间按刚刚处理（客户端时钟漂移不该显示负数）", () => {
    expect(formatRelativeTime(2_000, 1_000)).toBe("刚刚");
  });
});

describe("通知中心面板", () => {
  it("没有通知时：无角标，打开显示空态", () => {
    render(<NotificationCenter />);
    expect(screen.getByRole("button", { name: "通知中心" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通知中心" }));
    const dialog = screen.getByRole("dialog", { name: "通知中心" });
    expect(within(dialog).getByText(/还没有通知/)).toBeInTheDocument();
    // 空列表时两个批量操作都不可用
    expect(within(dialog).getByRole("button", { name: "全部已读" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "清空" })).toBeDisabled();
  });

  it("未读数挂在铃铛上；全部已读后清零", () => {
    useNotificationStore.setState({
      items: [makeItem({ title: "鲍勃" }), makeItem({ title: "评审组" })],
    });
    render(<NotificationCenter />);
    expect(screen.getByRole("button", { name: "通知中心 2 条未读" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "通知中心 2 条未读" }));
    const dialog = screen.getByRole("dialog", { name: "通知中心" });
    fireEvent.click(within(dialog).getByRole("button", { name: "全部已读" }));
    expect(useNotificationStore.getState().items.every((n) => n.read)).toBe(true);
    expect(screen.getByRole("button", { name: "通知中心" })).toBeInTheDocument();
  });

  it("消息通知点进去：跳到该会话并标记已读", () => {
    const item = makeItem({ title: "鲍勃", conversationId: "c9" });
    useNotificationStore.setState({ items: [item] });
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: "通知中心 1 条未读" }));
    fireEvent.click(screen.getByRole("button", { name: "打开通知：鲍勃" }));

    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c9");
    expect(useNotificationStore.getState().items[0].read).toBe(true);
    // 跳转即收起面板：留着的意义只剩误点
    expect(screen.queryByRole("dialog", { name: "通知中心" })).not.toBeInTheDocument();
  });

  it("确认通知：标签显示「确认」，点进去跳回来源会话（d.34）", () => {
    const item = makeItem({
      kind: "approval",
      key: "approval:req-1",
      title: "小鸣 请求调用工具",
      body: "写文件（fs__write_file）（等待确认）",
      conversationId: "c7",
    });
    useNotificationStore.setState({ items: [item] });
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: "通知中心 1 条未读" }));
    const dialog = screen.getByRole("dialog", { name: "通知中心" });
    expect(within(dialog).getByText("确认")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开通知：小鸣 请求调用工具" }));
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c7");
  });

  it("任务通知点进去：进任务区并投递要选中的任务", () => {
    const item = makeItem({
      kind: "task",
      title: "梳理模块依赖已完成",
      taskId: "t1",
      conversationId: "c1",
    });
    useNotificationStore.setState({ items: [item] });
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: "通知中心 1 条未读" }));
    fireEvent.click(screen.getByRole("button", { name: "打开通知：梳理模块依赖已完成" }));

    expect(useUiStore.getState().page).toBe("tasks");
    expect(useUiStore.getState().taskFocusId).toBe("t1");
    expect(useUiStore.getState().activeConversationId).toBe("c1");
  });

  it("幕僚简报点进去：进幕僚页（d.48）", () => {
    const item = makeItem({
      kind: "staff",
      key: "staff:run-1",
      title: "幕僚简报",
      body: "有 2 条日程临期。",
    });
    useNotificationStore.setState({ items: [item] });
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: "通知中心 1 条未读" }));
    fireEvent.click(screen.getByRole("button", { name: "打开通知：幕僚简报" }));
    expect(useUiStore.getState().page).toBe("staff");
  });

  it("逐条已读 / 删除只影响那一条", () => {
    const a = makeItem({ title: "甲" });
    const b = makeItem({ title: "乙" });
    useNotificationStore.setState({ items: [a, b] });
    render(<NotificationCenter />);
    fireEvent.click(screen.getByRole("button", { name: "通知中心 2 条未读" }));
    const dialog = screen.getByRole("dialog", { name: "通知中心" });

    fireEvent.click(within(dialog).getByRole("button", { name: "标记已读：甲" }));
    expect(useNotificationStore.getState().items.find((n) => n.id === a.id)?.read).toBe(true);
    expect(useNotificationStore.getState().items.find((n) => n.id === b.id)?.read).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "删除通知：乙" }));
    expect(useNotificationStore.getState().items.map((n) => n.title)).toEqual(["甲"]);
  });

  it("清空走应用内确认弹窗：取消不删，确认才清空", () => {
    useNotificationStore.setState({ items: [makeItem(), makeItem()] });
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<NotificationCenter />);
    fireEvent.click(screen.getByRole("button", { name: "通知中心 2 条未读" }));

    const panel = screen.getByRole("dialog", { name: "通知中心" });
    fireEvent.click(within(panel).getByRole("button", { name: "清空" }));
    expect(confirmSpy).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", { name: "清空通知" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(useNotificationStore.getState().items).toHaveLength(2);

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "通知中心" })).getByRole("button", { name: "清空" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清空通知" })).getByRole("button", { name: "清空" }),
    );
    expect(useNotificationStore.getState().items).toEqual([]);
  });

  it("面板向上展开（bottom-0）：铃铛在导航轨底部时不再被窗口下缘裁掉", () => {
    useNotificationStore.setState({ items: [makeItem()] });
    render(<NotificationCenter />);
    fireEvent.click(screen.getByRole("button", { name: "通知中心 1 条未读" }));
    const panel = screen.getByRole("dialog", { name: "通知中心" });
    expect(panel.className).toContain("bottom-0");
    expect(panel.className).not.toContain("top-0");
    // 面板内滚动保留：外层限高，列表区自身 overflow-y-auto
    expect(panel.className).toContain("max-h-[70vh]");
    expect(panel.className).toContain("overflow-hidden");
    expect(panel.querySelector(".overflow-y-auto")).not.toBeNull();
  });

  it("Esc 关闭面板（焦点陷阱由弹窗骨架统一负责）", () => {
    useNotificationStore.setState({ items: [makeItem()] });
    render(<NotificationCenter />);
    fireEvent.click(screen.getByRole("button", { name: "通知中心 1 条未读" }));
    expect(screen.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "通知中心" })).not.toBeInTheDocument();
  });

  it("正文为空的只显示标题；未读项带「已读」按钮，已读项不带", () => {
    useNotificationStore.setState({
      items: [makeItem({ title: "有正文", body: "在吗" }), makeItem({ title: "无正文", body: "" })],
    });
    render(<NotificationCenter />);
    fireEvent.click(screen.getByRole("button", { name: "通知中心 2 条未读" }));
    const dialog = screen.getByRole("dialog", { name: "通知中心" });
    expect(within(dialog).getByText("在吗")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "标记已读：有正文" })).toHaveLength(1);
  });
});
