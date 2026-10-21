import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolApprovalModal } from "./ToolApprovalModal.js";
import type { HitlCall } from "../lib/hitl/types.js";

function makeCall(id: string, name: string, risk: HitlCall["risk"], displayName: string): HitlCall {
  return {
    id,
    name,
    argsJson: "{}",
    displayName,
    risk,
    summary: "目标.txt",
    source: "mcp",
  };
}

const writeCall = makeCall("w1", "fs__write_file", "write", "写文件");
const dangerCall = makeCall("d1", "fs__delete_file", "danger", "删文件");
const readCall = makeCall("r1", "srv__get_file", "read", "读文件");

describe("ToolApprovalModal", () => {
  it("打开即聚焦拒绝（安全默认：误放行的代价远大于误拒绝）", () => {
    render(
      <ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "拒绝" }));
  });

  it("列出待确认的调用：动作名 + 风险 + 参数摘要", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall, dangerCall]} onDecide={vi.fn()} />);

    expect(screen.getByText("写文件")).toBeInTheDocument();
    expect(screen.getByText("删文件")).toBeInTheDocument();
    expect(screen.getByText("写入")).toBeInTheDocument();
    expect(screen.getByText("危险")).toBeInTheDocument();
    expect(screen.getAllByText("目标.txt").length).toBe(2);
  });

  it("写操作默认不勾（默认动作是「什么都不做」）", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />);

    expect(screen.getByLabelText("允许 写文件")).not.toBeChecked();
  });

  it("点「仅本次允许」：只放行勾选了的项，没勾的按拒绝", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall, dangerCall]} onDecide={onDecide} />);

    fireEvent.click(screen.getByLabelText("允许 写文件"));
    fireEvent.click(screen.getByRole("button", { name: "仅本次允许" }));

    expect(onDecide).toHaveBeenCalledWith([
      { callId: "w1", decision: "allow" },
      { callId: "d1", decision: "deny", reason: "未勾选" },
    ]);
  });

  it("点「本会话内允许此工具」：勾选项给 allow-session", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={onDecide} />);

    fireEvent.click(screen.getByLabelText("允许 写文件"));
    fireEvent.click(screen.getByRole("button", { name: "本会话内允许此工具" }));

    expect(onDecide).toHaveBeenCalledWith([{ callId: "w1", decision: "allow-session" }]);
  });

  it("点「拒绝」：全部按拒绝，并带上理由", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall, dangerCall]} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    expect(onDecide).toHaveBeenCalledWith([
      { callId: "w1", decision: "deny", reason: "用户拒绝" },
      { callId: "d1", decision: "deny", reason: "用户拒绝" },
    ]);
  });

  it("Esc = 拒绝全部", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={onDecide} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onDecide).toHaveBeenCalledWith([{ callId: "w1", decision: "deny", reason: "用户拒绝" }]);
  });

  it("点遮罩 = 拒绝全部", () => {
    const onDecide = vi.fn();
    const { container } = render(
      <ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={onDecide} />,
    );

    // 遮罩是包裹弹窗的最外层容器
    fireEvent.click(container.firstElementChild as HTMLElement);

    expect(onDecide).toHaveBeenCalledWith([{ callId: "w1", decision: "deny", reason: "用户拒绝" }]);
  });

  it("点弹窗内部不触发拒绝（否则点内容就等于拒绝）", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={onDecide} />);

    fireEvent.click(screen.getByText("写文件"));

    expect(onDecide).not.toHaveBeenCalled();
  });

  it("只读项（已自动放行）折叠展示，不可勾选", () => {
    render(
      <ToolApprovalModal requestId="req-1" calls={[writeCall]} auto={[readCall]} onDecide={vi.fn()} />,
    );

    expect(screen.getByText(/只读工具（已自动放行/)).toBeInTheDocument();
    expect(screen.queryByLabelText("允许 读文件")).not.toBeInTheDocument();
  });

  it("焦点在弹窗内循环（Tab 不会跑出弹窗）", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />);

    const deny = screen.getByRole("button", { name: "拒绝" });
    expect(document.activeElement).toBe(deny);

    // 从最后一个可聚焦元素（仅本次允许）按 Tab → 回到弹窗内的第一个可聚焦元素
    const allow = screen.getByRole("button", { name: "仅本次允许" });
    allow.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    const first = screen.getByRole("button", { name: "关闭并拒绝" });
    expect(document.activeElement).toBe(first);
    // 焦点仍在弹窗内（没跑到 body 上）
    expect(screen.getByRole("dialog", { name: /请求调用工具/ })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("Shift+Tab 从第一个可聚焦元素 → 跳到最后一个（反向也在环内）", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />);

    const close = screen.getByRole("button", { name: "关闭并拒绝" });
    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "仅本次允许" }));
  });

  it("没有待确认项时不崩", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[]} onDecide={onDecide} />);

    expect(screen.getByText("没有待确认的调用。")).toBeInTheDocument();
  });
});
