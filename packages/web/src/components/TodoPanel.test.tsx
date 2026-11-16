/**
 * 任务清单面板（d.158）：场景是「模型在流式过程中写清单，用户当场就能看见」。
 * 断言盯住三件用户可见的事：空清单不占位、进度数字与状态、模型更新后立刻刷新。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TodoPanel } from "./TodoPanel.js";
import {
  TODOS_KEY,
  clearTodos,
  resetTodoStore,
  setTodos,
} from "../lib/todo/store.js";

const CONV = "c-todo";

beforeEach(() => {
  localStorage.removeItem(TODOS_KEY);
  resetTodoStore();
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(TODOS_KEY);
  resetTodoStore();
});

describe("TodoPanel", () => {
  it("没有清单的会话什么都不渲染（不占输入区高度）", () => {
    const { container } = render(<TodoPanel conversationId={CONV} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region", { name: "任务清单" })).toBeNull();
  });

  it("没有会话 id 时也不渲染", () => {
    setTodos(CONV, [{ content: "随便一条", status: "pending" }]);
    const { container } = render(<TodoPanel conversationId={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("渲染清单、状态与进度数字", () => {
    setTodos(CONV, [
      { content: "读一遍现有实现", status: "completed" },
      { content: "改三个文件", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ]);
    render(<TodoPanel conversationId={CONV} />);
    const panel = screen.getByRole("region", { name: "任务清单" });
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("读一遍现有实现")).toBeInTheDocument();
    expect(screen.getByText("改三个文件")).toBeInTheDocument();
    expect(screen.getByText("跑测试")).toBeInTheDocument();
    // 进度数字：已完成 1/3，进行中 1（读屏读的就是这一行）
    expect(screen.getByRole("status").textContent).toBe("已完成 1/3 · 进行中 1");
    // 状态对读屏有字面量（字形本身是装饰）
    expect(screen.getByText("进行中：")).toBeInTheDocument();
  });

  it("模型流式写入后立刻出现（订阅生效，不需要重新挂载）", () => {
    render(<TodoPanel conversationId={CONV} />);
    expect(screen.queryByRole("region", { name: "任务清单" })).toBeNull();

    act(() => {
      setTodos(CONV, [
        { content: "第一步", status: "in_progress" },
        { content: "第二步", status: "pending" },
      ]);
    });
    expect(screen.getByRole("region", { name: "任务清单" })).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toBe("已完成 0/2 · 进行中 1");

    act(() => {
      setTodos(CONV, [
        { content: "第一步", status: "completed" },
        { content: "第二步", status: "completed" },
      ]);
    });
    expect(screen.getByRole("status").textContent).toBe("已完成 2/2");
    expect(screen.getByText("全部完成")).toBeInTheDocument();
    // 清空 → 面板整个消失
    act(() => clearTodos(CONV));
    expect(screen.queryByRole("region", { name: "任务清单" })).toBeNull();
  });

  it("折叠后只剩进度条与数字，展开再显示条目", () => {
    setTodos(CONV, [{ content: "折叠我", status: "pending" }]);
    render(<TodoPanel conversationId={CONV} />);
    const toggle = screen.getByRole("button", { expanded: true });
    act(() => toggle.click());
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("折叠我")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("已完成 0/1");
    act(() => screen.getByRole("button", { expanded: false }).click());
    expect(screen.getByText("折叠我")).toBeInTheDocument();
  });

  it("别的会话写清单不会串到这个会话", () => {
    setTodos(CONV, [{ content: "本会话的任务", status: "pending" }]);
    render(<TodoPanel conversationId={CONV} />);
    act(() => {
      setTodos("c-other", [{ content: "别的会话的任务", status: "pending" }]);
    });
    expect(screen.getByText("本会话的任务")).toBeInTheDocument();
    expect(screen.queryByText("别的会话的任务")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("已完成 0/1");
  });
});
