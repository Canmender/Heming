import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { nextTabIndex, useRovingTabs, type TabOrientation } from "./tabs.js";

afterEach(() => cleanup());

/**
 * 页签键盘行为（③-1）：APG Tabs 模式的「一个 Tab 停靠点 + 方向键切换」。
 * 这里既测纯函数边界，也测 hook 接到真实 DOM 后的选中/焦点/tabIndex 联动。
 */

describe("nextTabIndex 纯函数", () => {
  it("水平方向：←/→ 移动，首尾循环", () => {
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("ArrowLeft", 1, 3)).toBe(0);
  });

  it("loop=false 时首尾不循环", () => {
    expect(nextTabIndex("ArrowRight", 2, 3, "horizontal", false)).toBe(2);
    expect(nextTabIndex("ArrowLeft", 0, 3, "horizontal", false)).toBe(0);
  });

  it("垂直方向用 ↑/↓，且不响应 ←/→", () => {
    expect(nextTabIndex("ArrowDown", 0, 3, "vertical")).toBe(1);
    expect(nextTabIndex("ArrowUp", 0, 3, "vertical")).toBe(2);
    expect(nextTabIndex("ArrowRight", 0, 3, "vertical")).toBeNull();
    expect(nextTabIndex("ArrowDown", 0, 3, "horizontal")).toBeNull();
  });

  it("Home/End 到首/尾，且与方向无关", () => {
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(3 - 1);
    expect(nextTabIndex("Home", 1, 1, "vertical")).toBe(0);
  });

  it("无关按键与空集合返回 null；越界当前下标按第一项处理", () => {
    expect(nextTabIndex("Tab", 0, 3)).toBeNull();
    expect(nextTabIndex("a", 0, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
    expect(nextTabIndex("ArrowRight", 9, 3)).toBe(1);
    expect(nextTabIndex("ArrowLeft", -1, 3)).toBe(2);
  });
});

function Harness({
  labels,
  initial = 0,
  orientation = "horizontal",
}: {
  labels: string[];
  initial?: number;
  orientation?: TabOrientation;
}) {
  const [active, setActive] = useState(initial);
  const tabs = useRovingTabs({
    count: labels.length,
    activeIndex: active,
    onChange: setActive,
    orientation,
  });
  return (
    <div role="tablist" aria-label="测试页签" onKeyDown={tabs.onKeyDown}>
      {labels.map((label, index) => (
        <button
          key={label}
          type="button"
          role="tab"
          ref={tabs.getTabRef(index)}
          tabIndex={tabs.tabIndexFor(index)}
          aria-selected={index === active}
          aria-controls={`panel-${label}`}
          onClick={() => setActive(index)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

describe("useRovingTabs 接线", () => {
  it("只有选中页签 tabIndex=0，其余 -1（整组一个 Tab 停靠点）", () => {
    render(<Harness labels={["甲", "乙", "丙"]} initial={1} />);
    expect(screen.getByRole("tab", { name: "甲" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "乙" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "丙" })).toHaveAttribute("tabindex", "-1");
  });

  it("→ 切换选中、移动焦点并更新 tabIndex", () => {
    render(<Harness labels={["甲", "乙", "丙"]} />);
    const first = screen.getByRole("tab", { name: "甲" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "乙" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "乙" }));
    expect(screen.getByRole("tab", { name: "乙" })).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("tabindex", "-1");
  });

  it("← 从首项循环到末项；Home/End 直达首尾", () => {
    render(<Harness labels={["甲", "乙", "丙"]} />);
    const first = screen.getByRole("tab", { name: "甲" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "丙" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "丙" }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(screen.getByRole("tab", { name: "甲" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(screen.getByRole("tab", { name: "丙" })).toHaveAttribute("aria-selected", "true");
  });

  it("垂直页签响应 ↑/↓，且不把 ←/→ 当成切换", () => {
    render(<Harness labels={["甲", "乙", "丙"]} orientation="vertical" />);
    const first = screen.getByRole("tab", { name: "甲" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "甲" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "乙" })).toHaveAttribute("aria-selected", "true");
  });

  it("Tab/Enter 等无关按键不改变选中（不阻断浏览器默认行为）", () => {
    render(<Harness labels={["甲", "乙", "丙"]} />);
    const first = screen.getByRole("tab", { name: "甲" });
    const tabEvent = fireEvent.keyDown(first, { key: "Tab" });
    // fireEvent 返回 false 表示 preventDefault 被调用；Tab 必须放行
    expect(tabEvent).toBe(true);
    expect(screen.getByRole("tab", { name: "甲" })).toHaveAttribute("aria-selected", "true");
  });
});