import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProgressPanel } from "./ProgressPanel.js";
import { useChatStore } from "../store/chat.js";
import type { AgentStreamState } from "../store/chat.js";

/**
 * 右侧「会话进度」面板（d.147.4.88）。
 *
 * 面板是**纯展示层**：数据由 `useConversationProgress(conversationId)` 从既有 store
 * （streaming / messages / HITL pending）推导，所以这里既测空态，也用真实的 store
 * 输入驱动四个 section（本轮进度 / 动态流程图 / 任务步骤 / 工具调用），
 * 不 mock 推导逻辑——否则「面板说成功、模型还在跑」这类矛盾测不出来。
 *
 * 开合不在这里测：开关是 ChatPage header 右上角那颗按钮，见 ChatPage.test。
 */
const base: AgentStreamState = {
  agentId: "system-assistant",
  conversationId: "c1",
  status: "streaming",
  text: "",
  lastAt: 1,
};

function setStream(patch: Partial<AgentStreamState> = {}): void {
  useChatStore.setState({ streaming: { s1: { ...base, ...patch } } });
}

beforeEach(() => {
  useChatStore.setState({ streaming: {}, messages: {} });
  // 宽度上限跟视口走：固定 1024（jsdom 默认值）让断言不依赖别的用例。
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1024,
  });
  localStorage.clear();
});

afterEach(() => cleanup());

describe("ProgressPanel · 空态", () => {
  it("渲染为右侧 complementary 栏：栏头「会话进度」+ 关闭按钮 + 空态标题", () => {
    const onClose = vi.fn();
    render(<ProgressPanel conversationId={null} onClose={onClose} />);

    const panel = screen.getByRole("complementary", { name: "会话进度" });
    expect(panel.tagName).toBe("ASIDE");
    expect(within(panel).getByRole("heading", { level: 2, name: "会话进度" })).toBeInTheDocument();
    expect(
      within(panel).getByRole("heading", { level: 2, name: "这一轮还没有进度" }),
    ).toBeInTheDocument();
    // 没有数据时不画进度条、不出四个 section 标题（空标题比没有更让人以为没加载出来）
    expect(within(panel).queryByRole("progressbar")).toBeNull();
    expect(within(panel).queryByRole("heading", { level: 3, name: "本轮进度" })).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "关闭会话进度" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("别的会话在流式，也不串进当前面板（conversationId 不匹配 = 空态）", () => {
    useChatStore.setState({
      streaming: {
        other: { ...base, conversationId: "c2", reasoning: "别的会话在思考" },
      },
    });
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "这一轮还没有进度" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("ProgressPanel · 有数据", () => {
  it("四个 section 齐全，且进度条/流程图/步骤/工具都来自同一份推导", () => {
    setStream({
      reasoning: "先读一下文件，再总结",
      text: "正在整理会议纪要",
      tools: [
        {
          id: "t1",
          name: "read_file",
          args: "{}",
          status: "ok",
          result: "文件内容",
          startedAt: 1,
          endedAt: 12,
        },
      ],
    });
    render(<ProgressPanel conversationId="c1" onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "会话进度" });
    for (const title of ["本轮进度", "动态流程图", "任务步骤", "工具调用"]) {
      expect(within(panel).getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
    }

    // 有工具在跑 → 阶段「正在调用工具」；思考+工具已完成、回答在生成 ⇒ done/total = 2/3
    expect(within(panel).getByTestId("progress-headline")).toHaveTextContent("正在调用工具");
    const bar = within(panel).getByRole("progressbar", { name: "本轮步骤进度" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(within(panel).getByTestId("progress-flow")).toBeInTheDocument();
    expect(within(panel).getByTestId("progress-flow-node-t1")).toBeInTheDocument();
    // 同一步骤会同时出现在「动态流程图」和「任务步骤」里（两处都是真实的读屏内容）。
    expect(within(panel).getAllByText("调用 read_file").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByTestId("progress-counts")).toHaveTextContent("工具 1 次");
    expect(within(panel).queryByRole("heading", { level: 2, name: "这一轮还没有进度" })).toBeNull();
  });
});

/**
 * d.147.4.90：面板左缘可拖拽调宽（240–560，且不超过视口一半），宽度记在 localStorage。
 *
 * 方向约定：手柄在面板左缘，所以 ←/左拖 = 面板变宽；→/右拖 = 变窄。
 */
const STORAGE_KEY = "heming.progress.width.v1";

function panelBox(): HTMLElement {
  return screen.getByRole("complementary", { name: "会话进度" });
}

function resizeHandle(): HTMLElement {
  return screen.getByRole("separator", { name: "调整会话进度栏宽度" });
}

describe("ProgressPanel · 拖拽调宽", () => {
  it("默认宽 280：面板 style.width 与手柄的 separator/aria 值同步", () => {
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);

    expect(panelBox().style.width).toBe("280px");
    const handle = resizeHandle();
    expect(handle).toBe(screen.getByTestId("progress-resize-handle"));
    expect(handle).toHaveAttribute("aria-valuemin", "240");
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    // min(560, floor(1024 / 2)) = 512
    expect(handle).toHaveAttribute("aria-valuemax", "512");
  });

  it("键盘：← 加宽 16 / → 变窄 16，Home/End 到两端，每次调整即落盘", () => {
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);
    const handle = resizeHandle();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panelBox().style.width).toBe("296px");
    expect(resizeHandle()).toHaveAttribute("aria-valuenow", "296");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("296");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panelBox().style.width).toBe("280px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(panelBox().style.width).toBe("512px");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("512");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(panelBox().style.width).toBe("240px");
    expect(resizeHandle()).toHaveAttribute("aria-valuenow", "240");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("240");
  });

  it("上限随视口放宽：1440 宽窗口里 End 到 560", () => {
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);

    act(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1440,
      });
      window.dispatchEvent(new Event("resize"));
    });

    expect(resizeHandle()).toHaveAttribute("aria-valuemax", "560");
    fireEvent.keyDown(resizeHandle(), { key: "End" });
    expect(panelBox().style.width).toBe("560px");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("560");
  });

  it("拖拽：左移加宽、右移变窄；拖拽期间光标记 col-resize，松手才落盘", () => {
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);
    const handle = resizeHandle();

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    expect(document.body.style.cursor).toBe("col-resize");

    // 指针左移 40px → 面板宽 +40
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 460 });
    expect(panelBox().style.width).toBe("320px");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // 再右移 60px（相对起点 +60）→ 面板窄 60
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 520 });
    expect(panelBox().style.width).toBe("260px");

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 520 });
    expect(document.body.style.cursor).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("260");

    // 松手后再移动指针不应继续改宽度
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
    expect(panelBox().style.width).toBe("260px");
  });

  it("刷新沿用存值；坏数据回落 280，超上限的值按视口收敛", () => {
    localStorage.setItem(STORAGE_KEY, "320");
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);
    expect(panelBox().style.width).toBe("320px");
    expect(resizeHandle()).toHaveAttribute("aria-valuenow", "320");

    cleanup();
    localStorage.setItem(STORAGE_KEY, "280px");
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);
    expect(panelBox().style.width).toBe("280px");

    cleanup();
    localStorage.setItem(STORAGE_KEY, "9999");
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);
    // 存值被夹到 560，再按 1024 视口的上限 512 收敛显示
    expect(panelBox().style.width).toBe("512px");
  });
});
