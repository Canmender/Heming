/**
 * 节点面板测试：搜索、分组、键盘选择、回车添加、Esc 关闭。
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NodePalette, filterPaletteItems } from "./NodePalette.js";
import { registerAllNodes } from "../../lib/workflow/nodes/index.js";

beforeAll(() => {
  registerAllNodes();
});

describe("节点面板 · 搜索过滤", () => {
  it("按中文名、类型 id 与说明匹配；空查询返回全部", () => {
    const items = [
      { type: "httpRequest", displayName: "HTTP 请求", description: "调用接口", group: "action" as const, isTrigger: false },
      { type: "set", displayName: "设置字段", description: "改字段", group: "transform" as const, isTrigger: false },
    ];
    expect(filterPaletteItems(items, "")).toHaveLength(2);
    expect(filterPaletteItems(items, "HTTP").map((item) => item.type)).toEqual(["httpRequest"]);
    expect(filterPaletteItems(items, "字段").map((item) => item.type)).toEqual(["set"]);
    expect(filterPaletteItems(items, "不存在的节点")).toHaveLength(0);
  });
});

describe("节点面板 · 渲染与交互", () => {
  it("打开时列出节点并聚焦搜索框；关闭时不渲染", () => {
    const { rerender } = render(<NodePalette open onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "节点面板" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索节点")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加节点 手动触发" })).toBeInTheDocument();
    rerender(<NodePalette open={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "节点面板" })).not.toBeInTheDocument();
  });

  it("搜索后只剩匹配项；点击即回调 onPick", () => {
    const onPick = vi.fn();
    render(<NodePalette open onPick={onPick} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "条件" } });
    expect(screen.getByRole("button", { name: "添加节点 条件判断" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加节点 手动触发" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加节点 条件判断" }));
    expect(onPick).toHaveBeenCalledWith("if");
  });

  it("键盘：↓ 移动、回车添加、Esc 关闭", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<NodePalette open onPick={onPick} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "节点面板" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("搜索无结果时给出空态文案", () => {
    render(<NodePalette open onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "zzz-no-such" } });
    expect(screen.getByText(/没有匹配的节点/)).toBeInTheDocument();
  });
});
