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

  it("「记住」默认不勾（一次决定不能悄悄变成长期规则）", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />);
    expect(screen.getByLabelText("记住本次选择")).not.toBeChecked();
  });

  it("勾选「记住」后：主动允许的项带 remember，没勾的项只算未选、不记规则", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall, dangerCall]} onDecide={onDecide} />);

    fireEvent.click(screen.getByLabelText("记住本次选择"));
    fireEvent.click(screen.getByLabelText("允许 写文件"));
    fireEvent.click(screen.getByRole("button", { name: "仅本次允许" }));

    expect(onDecide).toHaveBeenCalledWith([
      { callId: "w1", decision: "allow", remember: true },
      { callId: "d1", decision: "deny", reason: "未勾选" },
    ]);
  });

  it("勾选「记住」后点拒绝：每一项都带 remember（拒绝规则）", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={onDecide} />);

    fireEvent.click(screen.getByLabelText("记住本次选择"));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    expect(onDecide).toHaveBeenCalledWith([
      { callId: "w1", decision: "deny", reason: "用户拒绝", remember: true },
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

  it("写文件：折叠展示变更预览（增删数 + 路径）", () => {
    const call: HitlCall = {
      ...writeCall,
      argsJson: JSON.stringify({ path: "notes/a.md", content: "第一行\n第二行" }),
    };
    render(<ToolApprovalModal requestId="req-1" calls={[call]} onDecide={vi.fn()} />);

    expect(screen.getByText(/查看变更（\+2 −0）/)).toBeInTheDocument();
    expect(screen.getByText(/notes\/a\.md/)).toBeInTheDocument();
    expect(screen.getByText("+ 第一行")).toBeInTheDocument();
  });

  it("非文件写入的参数不显示预览（不猜着展示敏感字段）", () => {
    const call: HitlCall = {
      ...writeCall,
      argsJson: JSON.stringify({ env: { TOKEN: "secret" } }),
    };
    render(<ToolApprovalModal requestId="req-1" calls={[call]} onDecide={vi.fn()} />);

    expect(screen.queryByText(/查看变更/)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("跨会话请求标明归属，并可回到发起会话", () => {
    const onOpen = vi.fn();
    render(
      <ToolApprovalModal
        requestId="req-1"
        calls={[writeCall]}
        agentName="文档助手"
        conversationLabel="周报整理"
        onOpenConversation={onOpen}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("请求来自会话「周报整理」")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回到该会话" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("没有待确认项时不崩", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalModal requestId="req-1" calls={[]} onDecide={onDecide} />);

    expect(screen.getByText("没有待确认的调用。")).toBeInTheDocument();
  });
});

describe("ToolApprovalModal · 勾选语义说清楚", () => {
  it("弹窗里写明「先勾选再允许，没勾的按拒绝」——避免点了允许却得到拒绝", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />);
    expect(screen.getByText(/先勾选要放行的调用/)).toBeInTheDocument();
    expect(screen.getByText(/没勾的会按拒绝处理/)).toBeInTheDocument();
  });

  it("MCP 工具名按「服务 · 工具」展示，不把内部双下划线原样暴露给用户", () => {
    render(<ToolApprovalModal requestId="req-1" calls={[writeCall]} onDecide={vi.fn()} />);
    expect(screen.getByText("fs · write_file")).toBeInTheDocument();
    expect(screen.queryByText("fs__write_file")).not.toBeInTheDocument();
  });
});
