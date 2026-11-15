import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PageTabs, type PageTabItem } from "./PageTabs.js";

const ITEMS: PageTabItem[] = [
  { key: "a", label: "甲" },
  { key: "b", label: "乙", icon: <svg data-testid="icon-b" width={14} height={14} /> },
  { key: "c", label: "丙" },
];

/** 受控外壳：键盘切换要真的改选中项，才能在断言里看到 aria-selected / tabIndex 的变化。 */
function Harness({ onChange = () => {} }: { onChange?: (key: string) => void }) {
  const [active, setActive] = useState("a");
  return (
    <PageTabs
      label="测试分区"
      idPrefix="demo"
      items={ITEMS}
      active={active}
      onChange={(key) => {
        setActive(key);
        onChange(key);
      }}
    />
  );
}

function renderTabs(onChange?: (key: string) => void) {
  const { container } = render(<Harness onChange={onChange} />);
  const list = screen.getByRole("tablist", { name: "测试分区" });
  return { container, list };
}

describe("PageTabs 一级页签基元（插件/团队/模型三页共用）", () => {
  it("渲染 tablist 与下划线式页签：选中项带 2px 下划线特征，组名可被读屏定位", () => {
    const { list } = renderTabs();
    expect(list.className).toContain("flex");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["甲", "乙", "丙"]);
    const selected = within(list).getByRole("tab", { name: "甲" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    // pageTabClass 的视觉契约：-mb-px 让下划线压住页签行的 border-b。
    expect(selected.className).toContain("-mb-px");
    expect(selected.className).toContain("border-b-2");
    expect(within(list).getByRole("tab", { name: "乙" })).toHaveAttribute("aria-selected", "false");
  });

  it("idPrefix 生成 tab/panel 的配对 id；未选中页签不写悬空 aria-controls", () => {
    const { list } = renderTabs();
    const selected = within(list).getByRole("tab", { name: "甲" });
    expect(selected.id).toBe("demo-a-tab");
    expect(selected).toHaveAttribute("aria-controls", "demo-a-panel");
    // 其它页签的面板是挂需渲染的，未选中时不引用（否则是悬空引用）。
    expect(within(list).getByRole("tab", { name: "乙" })).not.toHaveAttribute("aria-controls");
    expect(within(list).getByRole("tab", { name: "丙" })).not.toHaveAttribute("aria-controls");
  });

  it("整组只有一个 Tab 停靠点（roving tabindex）", () => {
    const { list } = renderTabs();
    expect(within(list).getByRole("tab", { name: "甲" })).toHaveAttribute("tabindex", "0");
    expect(within(list).getByRole("tab", { name: "乙" })).toHaveAttribute("tabindex", "-1");
    expect(within(list).getByRole("tab", { name: "丙" })).toHaveAttribute("tabindex", "-1");
  });

  it("←/→ 切换并移动焦点，Home/End 到首尾，首尾循环", () => {
    const onChange = vi.fn();
    const { list } = renderTabs(onChange);
    const first = within(list).getByRole("tab", { name: "甲" });
    const second = within(list).getByRole("tab", { name: "乙" });
    const last = within(list).getByRole("tab", { name: "丙" });

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(second);
    expect(onChange).toHaveBeenLastCalledWith("b");

    fireEvent.keyDown(second, { key: "End" });
    expect(last).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(last);

    // 末项 → 循环回首项（APG 允许，两侧都循环）
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(last).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(first);
  });

  it("点击页签回传 key", () => {
    const onChange = vi.fn();
    const { list } = renderTabs(onChange);
    fireEvent.click(within(list).getByRole("tab", { name: "丙" }));
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(within(list).getByRole("tab", { name: "丙" })).toHaveAttribute("aria-selected", "true");
  });

  it("图标随文案一起渲染（三页的一级页签都带 14px 图标）", () => {
    const { list } = renderTabs();
    const second = within(list).getByRole("tab", { name: "乙" });
    expect(within(second).getByTestId("icon-b")).toBeInTheDocument();
    // 文案本身仍然是页签的可访问名（图标 aria-hidden 时不影响）
    expect(second).toHaveAccessibleName("乙");
  });

  it("active 不在 items 里时不崩（页签集合随状态收缩，如模型页无 CLI 时隐藏「来源」）", () => {
    render(<PageTabs label="模型页分区" idPrefix="model" items={ITEMS} active="gone" onChange={() => {}} />);
    const list = screen.getByRole("tablist", { name: "模型页分区" });
    // 回落成第一项停靠点，避免整组不可 Tab
    expect(within(list).getByRole("tab", { name: "甲" })).toHaveAttribute("tabindex", "0");
    expect(within(list).getAllByRole("tab").every((t) => t.getAttribute("aria-selected") === "false")).toBe(
      true,
    );
  });
});
