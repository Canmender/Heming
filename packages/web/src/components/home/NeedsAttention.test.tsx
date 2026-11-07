import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NeedsAttention } from "./NeedsAttention.js";
import { useHitlStore } from "../../store/hitl.js";
import { useNotificationStore } from "../../store/notifications.js";
import { useTaskStore } from "../../lib/tasks/store.js";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";

/**
 * 首页「需要你处理」：只列可动作的事，点一下直达；没事就不占首屏。
 * 三种来源：HITL 待确认 / 运行中任务 / 未读通知（approval 通知不重复列）。
 */

const conversation = {
  id: "c1",
  type: "agent" as const,
  agent: { id: "system-assistant", name: "和小鸣", avatar: null, owner_id: null, description: "" },
  unreadCount: 0,
};

beforeEach(() => {
  localStorage.clear();
  useHitlStore.setState({ pending: null } as never);
  useNotificationStore.setState({ items: [] });
  useTaskStore.setState({ tasks: [] });
  useChatStore.setState({ conversations: [conversation] as never });
  useUiStore.setState({ page: "home", activeConversationId: null, pageView: null, taskFocusId: null });
});

describe("NeedsAttention", () => {
  it("没有待处理事项时整块不渲染（不占首屏）", () => {
    const { container } = render(<NeedsAttention />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("region", { name: "需要你处理" })).toBeNull();
  });

  it("HITL 待确认：列出「谁在等你确认什么」，点开去那个会话", () => {
    useHitlStore.setState({
      pending: {
        requestId: "r1",
        kind: "tool-call",
        payload: [],
        calls: [
          { id: "call-1", name: "PowerShell", argsJson: "{}", risk: "danger" },
          { id: "call-2", name: "Registry", argsJson: "{}", risk: "danger" },
        ],
        auto: [],
        agentId: "system-assistant",
        conversationId: "c1",
        streamId: "s1",
        agentName: "和小鸣",
      },
    } as never);

    render(<NeedsAttention />);
    const card = screen.getByRole("region", { name: "需要你处理" });
    expect(within(card).getByText(/在等你确认 PowerShell/)).toBeInTheDocument();
    expect(within(card).getByText(/共 2 个操作待确认/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /在等你确认/ }));
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c1");
  });

  it("运行中的任务：显示标题与已运行时长，点击进任务区并选中它", () => {
    useTaskStore.setState({
      tasks: [
        {
          id: "t1",
          conversationId: "c1",
          agentId: "system-assistant",
          agentName: "和小鸣",
          title: "整理本周周报",
          prompt: "整理周报",
          status: "running",
          createdAt: Date.now() - 5 * 60_000,
          updatedAt: Date.now() - 60_000,
          steps: [],
        },
      ],
    } as never);

    render(<NeedsAttention />);
    const card = screen.getByRole("region", { name: "需要你处理" });
    expect(within(card).getByText(/任务正在运行：整理本周周报/)).toBeInTheDocument();
    expect(within(card).getByText(/已运行 5 分钟/)).toBeInTheDocument();
    fireEvent.click(within(card).getByText(/任务正在运行：整理本周周报/).closest("button")!);
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().pageView).toBe("tasks");
    expect(useUiStore.getState().taskFocusId).toBe("t1");
  });

  it("未读通知：任务收尾可直达任务；approval 类不重复列（HITL 已覆盖）", () => {
    useNotificationStore.getState().push({
      kind: "task",
      key: "task:t9:done",
      title: "任务完成：整理周报",
      body: "共 4 步",
      taskId: "t9",
      conversationId: "c1",
    });
    useNotificationStore.getState().push({
      kind: "approval",
      key: "approval:r1",
      title: "「和小鸣」请求执行命令",
      conversationId: "c1",
    });

    render(<NeedsAttention />);
    const card = screen.getByRole("region", { name: "需要你处理" });
    expect(within(card).getByText("任务完成：整理周报")).toBeInTheDocument();
    expect(within(card).queryByText(/请求执行命令/)).toBeNull();
    fireEvent.click(within(card).getByText("任务完成：整理周报").closest("button")!);
    expect(useUiStore.getState().taskFocusId).toBe("t9");
  });
});
