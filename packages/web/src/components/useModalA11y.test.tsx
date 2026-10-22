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

  it("打开时屏蔽背景兄弟，卸载后解除屏蔽（弹窗自己不碰）", () => {
    const { unmount } = render(
      <>
        <button type="button">背景</button>
        <Panel onClose={() => {}} label="弹窗" />
      </>,
    );
    const bg = screen.getByRole("button", { name: "背景" });
    expect(bg).toHaveAttribute("inert");
    expect(screen.getByRole("dialog")).not.toHaveAttribute("inert");
    unmount();
    expect(bg).not.toHaveAttribute("inert");
  });

  it("内层卸载不会解除外层仍在生效的背景屏蔽", () => {
    function Harness() {
      const [inner, setInner] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setInner(false)}>
            卸载内层
          </button>
          <Panel onClose={() => {}} label="外层">
            {inner && <Panel onClose={() => {}} label="内层" />}
          </Panel>
        </>
      );
    }
    const { unmount } = render(<Harness />);
    const trigger = screen.getByRole("button", { name: "卸载内层" });
    expect(trigger).toHaveAttribute("inert"); // 外层弹窗早就屏蔽了它
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("inert"); // 内层还原的是自己动过的，外层那份不动
    unmount();
    expect(trigger).not.toHaveAttribute("inert");
  });

  it("遮罩根以内的兄弟不屏蔽（技能详情抽屉那种点遮罩关闭）", () => {
    function Drawer({ onClose }: { onClose: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      useModalA11y(ref, onClose);
      return (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button type="button" aria-label="关闭抽屉" onClick={onClose} className="absolute inset-0" />
          <div ref={ref} role="dialog" aria-modal="true" aria-label="抽屉" tabIndex={-1}>
            <button type="button">内部</button>
          </div>
        </div>
      );
    }
    render(
      <>
        <button type="button">背景</button>
        <Drawer onClose={() => {}} />
      </>,
    );
    expect(screen.getByRole("button", { name: "背景" })).toHaveAttribute("inert");
    // 遮罩按钮是 panel 的兄弟、但在同一个 fixed 遮罩根以内：屏蔽它等于关不掉抽屉
    const backdrop = screen.getByRole("button", { name: "关闭抽屉" });
    expect(backdrop).not.toHaveAttribute("inert");
    fireEvent.click(backdrop);
  });

  it("data-a11y-keep 的常驻浮层不屏蔽（通话中还得能挂断）", () => {
    render(
      <>
        <div data-a11y-keep>
          <button type="button">挂断</button>
        </div>
        <button type="button">背景</button>
        <Panel onClose={() => {}} label="弹窗" />
      </>,
    );
    expect(screen.getByRole("button", { name: "背景" })).toHaveAttribute("inert");
    expect(screen.getByText("挂断").parentElement).not.toHaveAttribute("inert");
  });

  it("blockBackground=false 不动背景（非模态浮层）", () => {
    function Popover() {
      const ref = useRef<HTMLDivElement>(null);
      useModalA11y(ref, () => {}, { blockBackground: false });
      return (
        <div ref={ref} role="dialog" aria-modal="false" aria-label="浮层" tabIndex={-1}>
          <button type="button">内部</button>
        </div>
      );
    }
    render(
      <>
        <button type="button">背景</button>
        <Popover />
      </>,
    );
    expect(screen.getByRole("button", { name: "背景" })).not.toHaveAttribute("inert");
  });

  it("关闭后把焦点还给触发元素", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开
          </button>
          {open && <Panel onClose={() => setOpen(false)} label="弹窗" />}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "甲" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("关闭时焦点已被主动移走 → 不抢回来", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            关闭弹窗
          </button>
          <button type="button">下一个目标</button>
          {open && <Panel onClose={() => setOpen(false)} label="弹窗" />}
        </>
      );
    }
    render(<Harness />);
    const next = screen.getByRole("button", { name: "下一个目标" });
    // 关闭方自己把焦点安排好了（跳会话、开下一个弹窗），归还就成了抢焦点
    next.focus();
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    expect(document.activeElement).toBe(next);
  });
});
