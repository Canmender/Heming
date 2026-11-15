import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Message } from "@heming/shared";
import { ContextView } from "./ContextView.js";
import { useChatStore } from "../../store/chat.js";
import { ROW_TOKEN_OVERHEAD, estimateTokens } from "../../lib/agentContext/tokens.js";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_RESERVED_TOKENS } from "../../lib/agentContext/budget.js";

/**
 * 「上下文」页签（T32）：本会话的预算用量。
 *
 * 契约：
 * - `section[aria-label="上下文"][data-view-panel="context"]` + h3「上下文」；
 * - `role="progressbar" aria-label="上下文预算"`，`aria-valuenow` 是真实用量（数字），
 *   `aria-valuemax` = DEFAULT_BUDGET_TOKENS，`aria-valuetext` 与正文都是 `x / budget tokens`；
 * - 明细三行：消息条数、工具结果条数、注入预留额度。
 * 口径：每条消息 = estimateTokens(正文) + ROW_TOKEN_OVERHEAD（与 planContext 的 rowCost 同式）。
 */

const TEXT = "你好世界";

function message(id: string, text: string, extra: Record<string, unknown> = {}): Message {
  return {
    id,
    conversationId: "c1",
    senderType: "user",
    senderId: "u1",
    payload: { text },
    createdAt: "2026-10-17T00:00:00.000Z",
    enc: "plain",
    ...extra,
  } as Message;
}

beforeEach(() => {
  useChatStore.setState({ messages: {} });
});

afterEach(() => cleanup());

describe("ContextView · 上下文预算", () => {
  it("没有消息时用量为 0：进度条 0、明细全 0、正文显示 x / budget", () => {
    const { container } = render(<ContextView conversationId={null} />);
    const section = container.querySelector('section[data-view-panel="context"]')!;
    expect(section).toHaveAttribute("aria-label", "上下文");
    expect(screen.getByRole("heading", { level: 3, name: "上下文" })).toBeInTheDocument();

    const bar = screen.getByRole("progressbar", { name: "上下文预算" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", String(DEFAULT_BUDGET_TOKENS));
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuetext", `0 / ${DEFAULT_BUDGET_TOKENS} tokens`);
    expect(screen.getByText(`0 / ${DEFAULT_BUDGET_TOKENS} tokens`)).toBeInTheDocument();

    const detail = screen.getByRole("list", { name: "上下文明细" });
    expect(within(detail).getByText("消息").parentElement).toHaveTextContent("0 条");
    expect(within(detail).getByText("工具结果").parentElement).toHaveTextContent("0 条");
    expect(within(detail).getByText("注入预留").parentElement).toHaveTextContent(
      `${DEFAULT_RESERVED_TOKENS} tokens`,
    );
  });

  it("用量按 estimateTokens + 行开销真实累计，aria-valuenow 是数字", () => {
    const first = message("m1", TEXT);
    const second = message("m2", "");
    useChatStore.setState({ messages: { c1: [first, second] } });
    render(<ContextView conversationId="c1" />);

    const expected = estimateTokens(TEXT) + ROW_TOKEN_OVERHEAD + ROW_TOKEN_OVERHEAD;
    const bar = screen.getByRole("progressbar", { name: "上下文预算" });
    expect(bar).toHaveAttribute("aria-valuenow", String(expected));
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(screen.getByText(`${expected} / ${DEFAULT_BUDGET_TOKENS} tokens`)).toBeInTheDocument();

    const detail = screen.getByRole("list", { name: "上下文明细" });
    expect(within(detail).getByText("消息").parentElement).toHaveTextContent("2 条");
  });

  it("工具结果条数来自消息转录的 tools 数量（不是猜的）", () => {
    const withTools = message("m1", "调用工具", {
      tools: [
        { id: "t1", name: "read_file", status: "ok" },
        { id: "t2", name: "run_shell", status: "error" },
      ],
    });
    useChatStore.setState({ messages: { c1: [withTools] } });
    render(<ContextView conversationId="c1" />);

    const detail = screen.getByRole("list", { name: "上下文明细" });
    expect(within(detail).getByText("工具结果").parentElement).toHaveTextContent("2 条");
  });

  it("只看当前会话：别的会话消息不计入", () => {
    useChatStore.setState({
      messages: {
        c1: [message("m1", "本会话")],
        c2: [message("m2", "另一个会话"), message("m3", "另一个会话 2")],
      },
    });
    render(<ContextView conversationId="c1" />);

    const detail = screen.getByRole("list", { name: "上下文明细" });
    expect(within(detail).getByText("消息").parentElement).toHaveTextContent("1 条");
    const bar = screen.getByRole("progressbar", { name: "上下文预算" });
    expect(bar).toHaveAttribute("aria-valuenow", String(estimateTokens("本会话") + ROW_TOKEN_OVERHEAD));
  });
});
