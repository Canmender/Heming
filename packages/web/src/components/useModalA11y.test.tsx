import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { useModalA11y } from "./useModalA11y.js";

/** 只测行为：Esc 关掉当前这层、Tab 困在面板里、嵌套时外层不被误关。 */
function Panel({
  onClose,
  label,
  active = true,
  children,
}: {
  onClose: () => void;
  label: string;
  active?: boolean;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, onClose, { active });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <button type="button">甲</button>
      <button type="button">乙</button>
      {children}
    </div>
  );
}

describe("useModalA11y", () => {
  it("打开时把焦点落进面板，Esc 关闭", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} label="外层" />);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab 到最后一项后回到第一项，Shift+Tab 反向循环", () => {
    render(<Panel onClose={() => {}} label="外层" />);
    const [first, last] = screen.getAllByRole("button");
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("嵌套弹窗只有栈顶响应 Esc，内层卸载后 Esc 交还外层", () => {
    const outer = vi.fn();
    const innerClose = vi.fn();
    function Harness() {
      const [showInner, setShowInner] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShowInner(false)}>
            卸载内层
          </button>
          <Panel onClose={outer} label="外层">
            {showInner && <Panel onClose={innerClose} label="内层" />}
          </Panel>
        </>
      );
    }
    render(<Harness />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "卸载内层" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("active=false 时完全不拦截按键（常驻挂载的弹窗用 open 控制）", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} label="外层" active={false} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
