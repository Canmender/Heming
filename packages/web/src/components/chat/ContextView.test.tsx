import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Message } from "@heming/shared";
import { ContextView } from "./ContextView.js";
import { useChatStore } from "../../store/chat.js";
import { useTokenUsageStore } from "../../store/tokenUsage.js";
import { RecallLog } from "../../lib/memory/recallLog.js";
import { rolloutLog } from "../../lib/rollout/index.js";
import { ROW_TOKEN_OVERHEAD, estimateTokens } from "../../lib/agentContext/tokens.js";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_RESERVED_TOKENS } from "../../lib/agentContext/budget.js";
import { recordContextFold, resetContextFolds } from "../../lib/agentContext/contextFold.js";

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
  localStorage.removeItem("heming.tokenUsage");
  useTokenUsageStore.getState().reset();
  resetContextFolds();
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

describe("ContextView · 本会话消耗（P0-T2）", () => {
  const rec = (tokens: number | null, extra: Record<string, unknown> = {}) => ({
    model: "m1",
    tokens,
    at: "2026-11-15T01:00:00.000Z",
    ...extra,
  });

  it("只认显式归到本会话的记账：别的会话与未归因的老记录都不算进来", () => {
    useTokenUsageStore.setState({
      records: [
        rec(100, { conversationId: "c1", streamId: "s1" }),
        rec(50, { conversationId: "c1", streamId: "s2" }),
        rec(900, { conversationId: "c2", streamId: "s3" }),
        rec(777), // 老记录：没有归因
      ] as never,
    });
    render(<ContextView conversationId="c1" />);
    expect(screen.getByTestId("conversation-tokens")).toHaveTextContent("150 tokens");
    const list = screen.getByRole("list", { name: "本会话消耗" });
    expect(within(list).getByText("回合数").parentElement).toHaveTextContent("2 次");
  });

  it("未上报单独计数，不混进已上报合计", () => {
    useTokenUsageStore.setState({
      records: [
        rec(100, { conversationId: "c1", streamId: "s1" }),
        rec(null, { conversationId: "c1", streamId: "s2" }),
      ] as never,
    });
    render(<ContextView conversationId="c1" />);
    expect(screen.getByTestId("conversation-tokens")).toHaveTextContent("100 tokens");
    const list = screen.getByRole("list", { name: "本会话消耗" });
    expect(within(list).getByText("回合数").parentElement).toHaveTextContent("2 次（1 次未上报）");
  });

  it("回合明细按 stream 列出：模型名 + token 数，未上报写明「未上报」", () => {
    useTokenUsageStore.setState({
      records: [
        rec(100, { conversationId: "c1", streamId: "s1" }),
        rec(null, { conversationId: "c1", streamId: "s2" }),
      ] as never,
    });
    render(<ContextView conversationId="c1" />);
    const turns = screen.getByRole("list", { name: "回合消耗明细" });
    const rows = within(turns).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // 最新的回合排前面（s2 后写）
    expect(rows[1]).toHaveTextContent("100 tokens");
    expect(rows[0]).toHaveTextContent("未上报");
    expect(rows[0]).toHaveTextContent("m1");
  });

  it("没有可归因记录时明说「还没有」，不显示 0 冒充真实消耗", () => {
    render(<ContextView conversationId="c1" />);
    expect(screen.getByText("这个会话还没有可归因的用量记录。")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-tokens")).toHaveTextContent("0 tokens");
  });
});

describe("ContextView · 失败归因（P3-T16）", () => {
  const rec = (tokens: number | null, extra: Record<string, unknown> = {}) => ({
    model: "m1",
    tokens,
    at: "2026-11-15T01:00:00.000Z",
    ...extra,
  });

  beforeEach(() => {
    rolloutLog.clear();
  });

  it("按「五抽屉 + 兜底」聚合本会话回合的 failure：只显示出现过的抽屉", () => {
    const turn = (streamId: string, failure?: "tool_error" | "max_rounds") => {
      rolloutLog.append({
        type: "turn_start",
        conversationId: "c1",
        streamId,
        agentId: "a1",
        userText: "hi",
      });
      rolloutLog.append({
        type: "turn_end",
        streamId,
        status: failure === "max_rounds" ? "ok" : failure ? "error" : "ok",
        ...(failure ? { failure } : {}),
      });
    };
    turn("s1", "tool_error");
    turn("s2", "tool_error");
    turn("s3", "max_rounds");
    turn("s4"); // 正常完成：不进任何抽屉

    useTokenUsageStore.setState({
      records: [
        rec(10, { conversationId: "c1", streamId: "s1" }),
        rec(10, { conversationId: "c1", streamId: "s2" }),
        rec(10, { conversationId: "c1", streamId: "s3" }),
        rec(10, { conversationId: "c1", streamId: "s4" }),
      ] as never,
    });

    render(<ContextView conversationId="c1" />);
    const list = screen.getByRole("list", { name: "失败归因" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId("failure-count-tool_error")).toHaveTextContent("2 次");
    expect(screen.getByTestId("failure-count-max_rounds")).toHaveTextContent("1 次");
    expect(within(list).getByText("工具报错")).toBeInTheDocument();
    expect(within(list).getByText("轮次打满")).toBeInTheDocument();
  });

  it("一次归因都没有时整块省略：不拿一张全 0 的表冒充报表", () => {
    rolloutLog.append({
      type: "turn_start",
      conversationId: "c1",
      streamId: "s1",
      agentId: "a1",
      userText: "hi",
    });
    rolloutLog.append({ type: "turn_end", streamId: "s1", status: "ok" });
    useTokenUsageStore.setState({
      records: [rec(10, { conversationId: "c1", streamId: "s1" })] as never,
    });
    render(<ContextView conversationId="c1" />);
    expect(screen.queryByRole("list", { name: "失败归因" })).toBeNull();
    expect(screen.queryByText("失败归因")).toBeNull();
  });
});

describe("ContextView · 完成证据（P3-T15）", () => {
  // 日志是模块级单例：不清就会把上一个用例的证据带进来（"没有证据"那条正是要防这个）。
  beforeEach(() => {
    rolloutLog.clear();
  });

  const rec = (tokens: number | null, extra: Record<string, unknown> = {}) => ({
    model: "m1",
    tokens,
    at: 1,
    profileId: "p1",
    ...extra,
  });

  it("有证据的回合显示「改了几个文件 / 执行了几个动作」", () => {
    rolloutLog.append({
      type: "turn_start",
      conversationId: "c1",
      streamId: "s1",
      agentId: "a1",
      userText: "把待办改了",
    });
    rolloutLog.append({
      type: "assistant_final",
      streamId: "s1",
      text: "改好了",
      evidence: {
        files: ["notes/待办.md", "notes/日志.md"],
        commands: ["file_patch: notes/待办.md、notes/日志.md"],
      },
    });
    useTokenUsageStore.setState({
      records: [rec(100, { conversationId: "c1", streamId: "s1" })] as never,
    });
    render(<ContextView conversationId="c1" />);
    const turns = screen.getByRole("list", { name: "回合消耗明细" });
    const row = within(turns).getAllByRole("listitem")[0];
    expect(row).toHaveTextContent("改了 2 个文件");
    expect(row).toHaveTextContent("执行 1 个动作");
  });

  it("没有证据就不显示证据字样：宁可不说，也不暗示「查过无副作用」", () => {
    rolloutLog.append({
      type: "turn_start",
      conversationId: "c1",
      streamId: "s1",
      agentId: "a1",
      userText: "解释概念",
    });
    rolloutLog.append({ type: "assistant_final", streamId: "s1", text: "好的" });
    useTokenUsageStore.setState({
      records: [rec(100, { conversationId: "c1", streamId: "s1" })] as never,
    });
    render(<ContextView conversationId="c1" />);
    const turns = screen.getByRole("list", { name: "回合消耗明细" });
    const row = within(turns).getAllByRole("listitem")[0];
    expect(row).not.toHaveTextContent("改了");
    expect(row).not.toHaveTextContent("个动作");
  });
});

describe("ContextView · 记忆注入（P3-T17）", () => {
  // 召回日志也在 localStorage 里：不清就会把上个用例的档案带进来。
  beforeEach(() => {
    new RecallLog().clear();
  });

  const recallInput = (conversationId: string) => ({
    agentId: "a1",
    conversationId,
    query: "上次发布用的哪个窗口？",
    recalled: { semantic: 2, episodic: 1, working: 0 },
    injected: [
      { id: "s1", layer: "semantic" as const, content: "发布窗口：每周四 20:00", truncated: false },
    ],
    dropped: [
      { id: "s2", layer: "semantic" as const, reason: "budget" as const, content: "旧窗口：周三" },
    ],
    used: ["s1"],
  });

  it("列出最近一次注入：注入条目、被裁条目与原因、疑似引用", () => {
    new RecallLog().record(recallInput("c1"));
    render(<ContextView conversationId="c1" />);
    const list = screen.getByRole("list", { name: "记忆注入" });
    expect(within(list).getByText("上次发布用的哪个窗口？")).toBeInTheDocument();
    expect(within(list).getByText(/召回 3 条 · 注入 1 条 · 裁掉 1 条 · 疑似引用 1 条/)).toBeInTheDocument();
    const injected = screen.getByRole("list", { name: "注入条目" });
    expect(within(injected).getByText(/发布窗口：每周四 20:00/)).toBeInTheDocument();
    const dropped = screen.getByRole("list", { name: "被裁条目" });
    expect(within(dropped).getByText(/旧窗口：周三/)).toBeInTheDocument();
    expect(within(dropped).getByText(/预算不够/)).toBeInTheDocument();
  });

  it("只显示本会话的档案：别的会话的注入不混进来", () => {
    new RecallLog().record(recallInput("c2"));
    render(<ContextView conversationId="c1" />);
    expect(screen.queryByRole("list", { name: "记忆注入" })).toBeNull();
    expect(screen.queryByText("上次发布用的哪个窗口？")).toBeNull();
  });

  it("没有召回档案时整块省略：编不出解释就不假装能解释", () => {
    render(<ContextView conversationId="c1" />);
    expect(screen.queryByRole("list", { name: "记忆注入" })).toBeNull();
    expect(screen.queryByText("记忆注入")).toBeNull();
  });
});

describe("ContextView · 实时用量与折叠（d.346）", () => {
  it("传入 usage 时，预算与用量用调用方算好的值（与 ContextMeter 同一个数）", () => {
    useChatStore.setState({ messages: { c1: [message("m1", TEXT)] } });
    render(<ContextView conversationId="c1" usage={{ used: 1234, budget: 8000, calibrated: true }} />);
    const bar = screen.getByRole("progressbar", { name: "上下文预算" });
    expect(bar).toHaveAttribute("aria-valuemax", "8000");
    expect(bar).toHaveAttribute("aria-valuenow", "1234");
    expect(bar).toHaveAttribute("aria-valuetext", "1234 / 8000 tokens");
    expect(screen.getByText("估算已按本机实测校准")).toBeInTheDocument();
  });

  it("没有 usage 时回落本机设置，并说明这是未校准的估算", () => {
    render(<ContextView conversationId="c1" />);
    expect(screen.getByText("估算值（与压缩链同一估算器）")).toBeInTheDocument();
  });

  it("有折叠记录时显示折了几条、多久之前；没有就整块省略", () => {
    render(<ContextView conversationId="c1" />);
    expect(screen.queryByTestId("context-fold")).toBeNull();

    recordContextFold("c1", 120);
    render(<ContextView conversationId="c1" />);
    const fold = screen.getByTestId("context-fold");
    expect(fold).toHaveTextContent("折成摘要");
    expect(fold).toHaveTextContent("120");
    expect(fold).toHaveTextContent("刚刚");
  });
});

describe("ContextView · 分段占比（d.350，参考 billion-context）", () => {
  it("把预算按「消息 / 工具 / 预留」拆开画，并给出剩余额度", () => {
    render(<ContextView conversationId="c1" />);
    const box = screen.getByTestId("context-breakdown");
    expect(box).toHaveTextContent("消息");
    expect(box).toHaveTextContent("工具");
    expect(box).toHaveTextContent("预留 900");
    expect(box).toHaveTextContent("剩余 6000（100%）");
  });
});