/**
 * 模型切换弹窗（d.195）。
 *
 * 覆盖四件事：列出可选模型且当前绑定带勾选态、点选回传 id、无可用模型时给出去哪里配、
 * 「更多设置…」负责离开这条路（绑定写入不在这里做——那是 ChatPage 的职责）。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import "@testing-library/jest-dom/vitest";
import { ModelSwitcher, type ModelChoice } from "./ModelSwitcher.js";

const CHOICES: ModelChoice[] = [
  { id: "p1", label: "和鸣 · 高速", hint: "deepseek · deepseek-flash" },
  { id: "p2", label: "和鸣 · 质量", hint: "deepseek · deepseek-v4-pro" },
];

function setup(overrides: Partial<ComponentProps<typeof ModelSwitcher>> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ModelSwitcher
      open
      agentName="和小鸣"
      choices={CHOICES}
      boundId="p1"
      onPick={onPick}
      onClose={onClose}
      onOpenSettings={onOpenSettings}
      {...overrides}
    />,
  );
  return { onPick, onClose, onOpenSettings };
}

describe("ModelSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("列出来源、当前绑定带勾选态，说明写给谁换", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "切换模型" })).toBeInTheDocument();
    expect(screen.getByText(/当前智能体：和小鸣/)).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("deepseek · deepseek-flash")).toBeInTheDocument();
  });

  it("点一行就把该 id 回传（写入绑定由调用方做）", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getByText("和鸣 · 质量"));
    expect(onPick).toHaveBeenCalledWith("p2");
  });

  it("没配置模型时明说去哪配，而不是给一个空列表", () => {
    setup({ choices: [], boundId: null });
    expect(screen.getByText(/还没有可用模型/)).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("「更多设置…」交给调用方跳转", () => {
    const { onOpenSettings } = setup();
    fireEvent.click(screen.getByRole("button", { name: "更多设置…" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("未打开时什么都不渲染（不占焦点、不进 Tab 序）", () => {
    const { container } = render(
      <ModelSwitcher
        open={false}
        agentName="和小鸣"
        choices={CHOICES}
        boundId={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
