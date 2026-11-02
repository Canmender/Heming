import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  MAX_VISIBLE_ITEMS,
  RolloutTimeline,
  clockOf,
  detailOf,
  titleOf,
} from "./RolloutTimeline.js";
import type { RolloutItem } from "../lib/rollout/types.js";

/**
 * 过程日志面板：只读、有界、如实显示被拒与出错。
 * 这里不测样式，只测「用户能不能看懂发生了什么」与「有没有不该有的入口」。
 */

const at = (s: number) => `2026-11-02T09:00:${String(s).padStart(2, "0")}.000Z`;

const items: RolloutItem[] = [
  { type: "turn_start", at: at(0), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "查一下天气" },
  { type: "tool_call", at: at(1), streamId: "s1", id: "t1", name: "srv__weather", args: '{"city":"武汉"}' },
  { type: "tool_result", at: at(2), streamId: "s1", id: "t1", name: "srv__weather", ok: true, text: "晴 22℃" },
  { type: "tool_call", at: at(3), streamId: "s1", id: "t2", name: "srv__write", args: '{"path":"a.md"}' },
  { type: "tool_result", at: at(4), streamId: "s1", id: "t2", name: "srv__write", ok: false, denied: true, text: "未执行" },
  { type: "assistant_final", at: at(5), streamId: "s1", text: "今天晴" },
  { type: "turn_end", at: at(6), streamId: "s1", status: "ok" },
];

function renderTimeline(streamId = "s1", list: RolloutItem[] = items, active = false) {
  return render(<RolloutTimeline streamId={streamId} active={active} read={() => list} />);
}

describe("RolloutTimeline", () => {
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
    renderTimeline("s-missing", []);
    expect(screen.getByText(/这次任务没有过程日志/)).toBeTruthy();
    expect(screen.queryByText("回合开始")).toBeNull();
  });

  it("超出上限时只显示最近 N 条，并说明被截断", () => {
    const many: RolloutItem[] = Array.from({ length: MAX_VISIBLE_ITEMS + 5 }, (_, i) => ({
      type: "tool_call" as const,
      at: at(0),
      streamId: "s1",
      id: `t${i}`,
      name: `tool_${i}`,
      args: "{}",
    }));
    renderTimeline("s1", many);
    expect(screen.getByText(`仅显示最近 ${MAX_VISIBLE_ITEMS} 条`)).toBeTruthy();
    expect(screen.queryByText("tool_0")).toBeNull();
    expect(screen.getByText("tool_5")).toBeTruthy();
  });

  it("只读：面板里没有任何按钮或可编辑控件", () => {
    const { container } = renderTimeline();
    const region = screen.getByRole("region", { name: "过程日志" });
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelectorAll("input, textarea, [contenteditable='true']")).toHaveLength(0);
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
    expect(titleOf({ type: "turn_end", at: at(9), streamId: "s1", status: "error", error: "x" })).toBe("出错结束");
    expect(
      titleOf({ type: "turn_end", at: at(9), streamId: "s1", status: "aborted" }),
    ).toBe("已中断");
  });

  it("明细给原文（参数/结果/错误），空值不渲染折叠块", () => {
    expect(detailOf(items[1] as RolloutItem)).toBe('{"city":"武汉"}');
    expect(detailOf(items[2] as RolloutItem)).toBe("晴 22℃");
    expect(detailOf({ type: "turn_end", at: at(9), streamId: "s1", status: "aborted" })).toBe("");
  });
});
