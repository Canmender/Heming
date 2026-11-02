import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  MAX_VISIBLE_ITEMS,
  RolloutTimeline,
  clockOf,
  detailOf,
  titleOf,
} from "./RolloutTimeline.js";
import type { RolloutItem } from "../lib/rollout/types.js";

/**
 * 过程日志面板：只读、有界、如实显示被拒与出错，并在崩溃时明确标「未完成」。
 * 这里不测样式，只测「用户能不能看懂发生了什么」与「能不能点」。
 */

const at = (s: number) => `2026-11-02T09:00:${String(s).padStart(2, "0")}.000Z`;

/** 正常跑完的一次执行：两次工具调用后给出最终答案。 */
const items: RolloutItem[] = [
  { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "查一下天气" },
  { type: "tool_call", seq: 1, at: at(1), streamId: "s1", id: "t1", name: "srv__weather", args: '{"city":"武汉"}' },
  { type: "tool_result", seq: 2, at: at(2), streamId: "s1", id: "t1", name: "srv__weather", ok: true, text: "晴 22℃" },
  { type: "tool_call", seq: 3, at: at(3), streamId: "s1", id: "t2", name: "srv__write", args: '{"path":"a.md"}' },
  { type: "tool_result", seq: 4, at: at(4), streamId: "s1", id: "t2", name: "srv__write", ok: false, denied: true, text: "未执行" },
  { type: "assistant_final", seq: 5, at: at(5), streamId: "s1", text: "今天晴" },
  { type: "turn_end", seq: 6, at: at(6), streamId: "s1", status: "ok" },
];

/** 被中断的一次执行：没有最终答案，正常收尾（可分叉）。 */
const interrupted: RolloutItem[] = [
  { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "整理依赖" },
  { type: "tool_call", seq: 1, at: at(1), streamId: "s1", id: "t1", name: "srv__read", args: '{"path":"a.md"}' },
  { type: "tool_result", seq: 2, at: at(2), streamId: "s1", id: "t1", name: "srv__read", ok: true, text: "a.md 内容" },
  { type: "tool_call", seq: 3, at: at(3), streamId: "s1", id: "t2", name: "srv__grep", args: '{"q":"import"}' },
  { type: "tool_result", seq: 4, at: at(4), streamId: "s1", id: "t2", name: "srv__grep", ok: true, text: "命中 3 处" },
  { type: "turn_end", seq: 5, at: at(5), streamId: "s1", status: "aborted" },
];

/** 崩溃的一次执行：最后一个调用没有结果，也没有收尾记录。 */
const crashed: RolloutItem[] = [
  { type: "turn_start", seq: 0, at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "写文件" },
  { type: "tool_call", seq: 1, at: at(1), streamId: "s1", id: "t1", name: "srv__read", args: "{}" },
  { type: "tool_result", seq: 2, at: at(2), streamId: "s1", id: "t1", name: "srv__read", ok: true, text: "内容" },
  { type: "tool_call", seq: 3, at: at(3), streamId: "s1", id: "t2", name: "srv__write", args: "{}" },
];

function renderTimeline(
  opts: {
    streamId?: string;
    list?: RolloutItem[];
    active?: boolean;
    version?: number;
    onFork?: (seq: number) => void;
    running?: boolean;
  } = {},
) {
  return render(
    <RolloutTimeline
      streamId={opts.streamId ?? "s1"}
      active={opts.active ?? false}
      read={() => opts.list ?? items}
      {...(opts.version === undefined ? {} : { version: opts.version })}
      {...(opts.onFork ? { onFork: opts.onFork } : {})}
      {...(opts.running === undefined ? {} : { running: opts.running })}
    />,
  );
}

afterEach(() => {
  // 剪贴板是全局对象：不清理会让后续用例误用上一个桩
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
});

describe("RolloutTimeline 回放", () => {
  it("按顺序展示一次执行的完整过程", () => {
    renderTimeline();
    expect(screen.getByRole("region", { name: "过程日志" })).toBeTruthy();
    expect(screen.getByText("回合开始")).toBeTruthy();
    expect(screen.getAllByText("srv__weather")).toHaveLength(2);
    expect(screen.getByText("已给出最终答案")).toBeTruthy();
    expect(screen.getByText("正常结束")).toBeTruthy();
    expect(screen.getByText(/7 条 · 只读 · 仅本机/)).toBeTruthy();
  });

  it("被拒的调用写明「已拒绝，未执行」，不伪装成失败", () => {
    renderTimeline();
    expect(screen.getByText("srv__write（已拒绝，未执行）")).toBeTruthy();
  });

  it("没有日志时给出可解释的空态（不假装「没有过程」）", () => {
    renderTimeline({ streamId: "s-missing", list: [] });
    expect(screen.getByText(/这次任务没有过程日志/)).toBeTruthy();
    expect(screen.queryByText("回合开始")).toBeNull();
  });

  it("超出上限时只显示最近 N 条，并说明被截断", () => {
    const many: RolloutItem[] = Array.from({ length: MAX_VISIBLE_ITEMS + 5 }, (_, i) => ({
      type: "tool_call" as const,
      seq: i,
      at: at(0),
      streamId: "s1",
      id: `t${i}`,
      name: `tool_${i}`,
      args: "{}",
    }));
    renderTimeline({ list: many });
    expect(screen.getByText(`仅显示最近 ${MAX_VISIBLE_ITEMS} 条`)).toBeTruthy();
    expect(screen.queryByText("tool_0")).toBeNull();
    expect(screen.getByText("tool_5")).toBeTruthy();
  });

  it("相对时间：距开始 +3.2s（绝对时间留在 title 里）", () => {
    const withDelay: RolloutItem[] = [
      ...items,
      { type: "tool_call", seq: 7, at: "2026-11-02T09:00:03.200Z", streamId: "s1", id: "t3", name: "srv__late", args: "{}" },
    ];
    renderTimeline({ list: withDelay });
    expect(screen.getByText("+3.2s")).toBeTruthy();
    // 第一条相对时间是 +0ms；绝对时钟作为悬停提示保留
    expect(screen.getByText("+0ms").getAttribute("title")).toContain("绝对时间");
  });

  it("未完成：崩溃回合明确标注，并指出停在哪个调用", () => {
    renderTimeline({ list: crashed });
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("未完成");
    expect(banner.textContent).toContain("没有收尾记录");
    expect(banner.textContent).toContain("停在「srv__write」");
    // 悬空调用那一行自己也带「未完成」标记
    expect(screen.getByText("未完成", { selector: "span" })).toBeTruthy();
  });
});

describe("RolloutTimeline 筛选与配对", () => {
  it("按类型筛选：失败 / 被拒 / 工具，且筛完仍能回到全部", () => {
    renderTimeline();
    const group = screen.getByRole("group", { name: "按类型筛选日志" });

    fireEvent.click(within(group).getByRole("button", { name: "失败" }));
    expect(screen.getByText("srv__write（已拒绝，未执行）")).toBeTruthy();
    expect(screen.queryByText("srv__weather")).toBeNull();

    fireEvent.click(within(group).getByRole("button", { name: "被拒" }));
    expect(screen.getByText("srv__write（已拒绝，未执行）")).toBeTruthy();
    expect(screen.queryByText("正常结束")).toBeNull();

    fireEvent.click(within(group).getByRole("button", { name: "工具" }));
    expect(screen.getAllByText("srv__weather")).toHaveLength(2);
    expect(screen.queryByText("已给出最终答案")).toBeNull();

    fireEvent.click(within(group).getByRole("button", { name: "全部" }));
    expect(screen.getByText("已给出最终答案")).toBeTruthy();
  });

  it("悬停 tool_result 时高亮配对的 tool_call（靠 id 配对，与分叉判定同源）", () => {
    renderTimeline();
    const weather = screen.getAllByText("srv__weather");
    const callRow = weather[0]!.closest("li")!;
    const resultRow = weather[1]!.closest("li")!;
    expect(callRow.className).not.toContain("bg-[#f5f8ff]");

    fireEvent.mouseEnter(resultRow);
    expect(callRow.className).toContain("bg-[#f5f8ff]");

    fireEvent.mouseLeave(resultRow);
    expect(callRow.className).not.toContain("bg-[#f5f8ff]");
  });
});

describe("RolloutTimeline 导出与分叉入口", () => {
  it("导出本回合 JSON：内容与面板同源（单回合，不影响会话导出）", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "导出本回合 JSON" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const payload = JSON.parse((writeText.mock.calls[0] as unknown[])[0] as string) as {
      format: string;
      streamId: string;
      count: number;
      incomplete: { incomplete: boolean };
      items: RolloutItem[];
    };
    expect(payload.format).toBe("heming-rollout");
    expect(payload.streamId).toBe("s1");
    expect(payload.count).toBe(items.length);
    expect(payload.incomplete.incomplete).toBe(false);
    expect(screen.getByRole("button", { name: "导出本回合 JSON" })).toHaveTextContent("已复制");
  });

  it("剪贴板不可用时不静默失败：显示「复制失败」并摊出可选中的 JSON", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "导出本回合 JSON" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/复制失败/));

    // 不只报错：JSON 摊在只读 textarea 里并自动选中，用户能手动复制
    const area = screen.getByRole("textbox", {
      name: "本回合 JSON（可手动复制）",
    }) as HTMLTextAreaElement;
    expect(area.readOnly).toBe(true);
    expect(area.value).toContain('"format": "heming-rollout"');
    expect(area.value).toContain('"streamId": "s1"');
    // 按钮不伪装成成功
    expect(screen.getByRole("button", { name: "导出本回合 JSON" })).toHaveTextContent("复制失败");
    expect(screen.queryByText("已复制")).toBeNull();
  });

  it("健康前缀：可以带来源分叉，点击把这一条的 seq 交给上层", () => {
    const onFork = vi.fn();
    renderTimeline({ list: interrupted, onFork });
    const button = screen.getByRole("button", { name: "从此处分叉（第 4 条之后）" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onFork).toHaveBeenCalledWith(4);
  });

  it("v1 日志：分叉按钮置灰并说明原因（没有真序号）", () => {
    renderTimeline({ list: interrupted, version: 1, onFork: vi.fn() });
    const button = screen.getByRole("button", { name: "从此处分叉（第 4 条之后）" });
    expect(button).toBeDisabled();
    expect(screen.getAllByText(/旧版本记录/).length).toBeGreaterThan(0);
  });

  it("默认读本机日志时自己识别 v1：不依赖父层记得传 version", () => {
    const streamId = "s-legacy-timeline";
    localStorage.setItem(
      `heming.rollout.v1.${streamId}`,
      JSON.stringify({
        version: 1,
        items: [
          { type: "turn_start", at: at(0), conversationId: "c1", streamId, agentId: "a1", userText: "x" },
          { type: "tool_call", at: at(1), streamId, id: "t1", name: "srv__read", args: "{}" },
          { type: "tool_result", at: at(2), streamId, id: "t1", name: "srv__read", ok: true, text: "r" },
          { type: "turn_end", at: at(3), streamId, status: "aborted" },
        ],
      }),
    );
    try {
      render(<RolloutTimeline streamId={streamId} onFork={vi.fn()} />);
      // v1 的 seq 由数组下标补齐 ⇒ 结果是第 2 条
      const button = screen.getByRole("button", { name: "从此处分叉（第 2 条之后）" });
      expect(button).toBeDisabled();
      expect(screen.getAllByText(/旧版本记录/).length).toBeGreaterThan(0);
    } finally {
      localStorage.removeItem(`heming.rollout.v1.${streamId}`);
    }
  });

  it("运行中：分叉按钮置灰（正在跑的回合没有稳定前缀）", () => {
    renderTimeline({ list: interrupted, onFork: vi.fn(), running: true });
    expect(screen.getByRole("button", { name: "从此处分叉（第 4 条之后）" })).toBeDisabled();
    expect(screen.getAllByText(/仍在运行/).length).toBeGreaterThan(0);
  });

  it("已经给出最终答案的回合：分叉按钮置灰，提示改用重跑", () => {
    renderTimeline({ list: items, onFork: vi.fn() });
    const buttons = screen.getAllByRole("button", { name: /从此处分叉/ });
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByText(/不需要分叉/).length).toBeGreaterThan(0);
  });

  it("没有接分叉入口时不渲染按钮：面板默认仍是纯只读", () => {
    const { container } = renderTimeline();
    expect(screen.queryAllByRole("button", { name: /从此处分叉/ })).toHaveLength(0);
    // 仍然没有任何可编辑控件，也没有删除/编辑入口
    expect(container.querySelectorAll("input, textarea, [contenteditable='true']")).toHaveLength(0);
    const named = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(named.some((n) => /删除|编辑|清空/.test(String(n)))).toBe(false);
  });
});

describe("展示口径（纯函数）", () => {
  it("时间只到秒：同一次执行里日期是噪音", () => {
    expect(clockOf("2026-11-02T09:03:07.123Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // 非法时间原样返回，不抛也不显示 NaN
    expect(clockOf("not-a-date")).toBe("not-a-date");
  });

  it("标题优先给工具名/结论，不把正文当标题", () => {
    expect(titleOf(items[1] as RolloutItem)).toBe("srv__weather");
    expect(titleOf(items[5] as RolloutItem)).toBe("已给出最终答案");
    expect(titleOf({ type: "turn_end", seq: 9, at: at(9), streamId: "s1", status: "error", error: "x" })).toBe("出错结束");
    expect(
      titleOf({ type: "turn_end", seq: 9, at: at(9), streamId: "s1", status: "aborted" }),
    ).toBe("已中断");
  });

  it("明细给原文（参数/结果/错误），空值不渲染折叠块", () => {
    expect(detailOf(items[1] as RolloutItem)).toBe('{"city":"武汉"}');
    expect(detailOf(items[2] as RolloutItem)).toBe("晴 22℃");
    expect(detailOf({ type: "turn_end", seq: 9, at: at(9), streamId: "s1", status: "aborted" })).toBe("");
  });
});
