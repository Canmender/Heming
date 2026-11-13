import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "./Dialog.js";

afterEach(() => cleanup());

describe("Dialog 统一弹窗壳", () => {
  it("渲染可访问名、标题、说明、图标槽与底栏", () => {
    render(
      <Dialog
        ariaLabel="安装插件"
        title="安装 / 更新插件"
        description="先校验，再安装。"
        icon={<svg data-testid="dialog-icon" />}
        footer={<button type="button">确认安装</button>}
        onClose={() => {}}
      >
        <p>正文</p>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(dialog.className).toContain("rounded-xl");
    expect(dialog.className).toContain("ui-overlay-shadow");
    expect(screen.getByText("安装 / 更新插件").className).toContain("ui-section-title");
    expect(screen.getByText("先校验，再安装。").className).toContain("ui-caption");
    // 图标只是装饰，不重复念一遍标题已经说过的东西
    expect(screen.getByTestId("dialog-icon").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "确认安装" })).toBeInTheDocument();
  });

  it("点遮罩关闭，点面板内部不关闭", () => {
    const onClose = vi.fn();
    render(
      <Dialog ariaLabel="删除分组" title="删除分组" onClose={onClose}>
        <p>正文</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByText("正文"));
    expect(onClose).not.toHaveBeenCalled();
    // 遮罩是面板的父节点（fixed inset-0）
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭，关闭按钮走自定义 aria-label", () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">先聚焦我</button>
        <Dialog ariaLabel="快捷键" title="快捷键" closeLabel="关闭快捷键" onClose={onClose}>
          <p>正文</p>
        </Dialog>
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭快捷键" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("只有四档宽度，不再允许调用方传任意宽度", () => {
    const { rerender } = render(
      <Dialog ariaLabel="小" title="小" size="sm" onClose={() => {}}>
        <p>正文</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").className).toContain("w-[min(480px,92vw)]");

    rerender(
      <Dialog ariaLabel="大" title="大" size="xl" onClose={() => {}}>
        <p>正文</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").className).toContain("w-[min(860px,94vw)]");
  });

  it("没有 title 时不渲染头部（命令面板这类自带搜索框的浮层）", () => {
    render(
      <Dialog ariaLabel="命令面板" onClose={() => {}} bodyClassName="p-0">
        <input aria-label="搜索命令" />
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "命令面板" });
    expect(dialog.querySelector(".ui-section-title")).toBeNull();
    expect(screen.getByLabelText("搜索命令")).toBeInTheDocument();
  });
});