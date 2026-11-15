import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ShortcutsHelp } from "./ShortcutsHelp.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { PALETTE_PAGES } from "../lib/palette/pages.js";

afterEach(() => cleanup());

describe("ShortcutsHelp（快捷键帮助面板）", () => {
  it("按「导航 / 全局 / 编辑」分组，并列出全部静态快捷键", () => {
    render(<ShortcutsHelp onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "快捷键" });
    for (const group of ["导航", "全局", "编辑"]) {
      expect(within(dialog).getByRole("heading", { name: group })).toBeInTheDocument();
    }
    // 全局/编辑组的静态表（Ctrl+K / Esc / Enter / Shift+Enter / ?）
    expect(within(dialog).getByText("全局搜索（命令面板）")).toBeInTheDocument();
    expect(within(dialog).getByText("关闭当前弹窗 / 取消")).toBeInTheDocument();
    expect(within(dialog).getByText("发送消息 / 确认")).toBeInTheDocument();
    expect(within(dialog).getByText("换行（不发送）")).toBeInTheDocument();
    expect(within(dialog).getByText("K")).toBeInTheDocument();
    expect(within(dialog).getByText("Esc")).toBeInTheDocument();
    expect(within(dialog).getByText("Shift")).toBeInTheDocument();
  });

  it("导航组从 PALETTE_PAGES 生成：有 Alt 数字的页面全部出现，数字不写死在本组件", () => {
    render(<ShortcutsHelp onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "快捷键" });
    const digitPages = PALETTE_PAGES.filter((p) => Boolean(p.digit));
    // 每一条导航项都能在面板里找到对应名称
    for (const p of digitPages) {
      expect(within(dialog).getByText(p.label)).toBeInTheDocument();
    }
    // Alt 键帽数量 = 带数字的页面数量（导航组只列有快捷键的页；不再手抄一份数字）
    expect(within(dialog).getAllByText("Alt")).toHaveLength(digitPages.length);
    // 没有数字键的页面不进导航快捷键组（它们本来就没有快捷键）
    const noDigit = PALETTE_PAGES.filter((p) => !p.digit);
    expect(noDigit.length).toBeGreaterThan(0);
    for (const p of noDigit) {
      expect(within(dialog).queryByText(p.label)).toBeNull();
    }
  });

  it("关闭按钮与 Esc 都能关自己；焦点由弹窗骨架接管", () => {
    const onClose = vi.fn();
    render(<ShortcutsHelp onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭快捷键" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    // 打开时焦点落在面板内（autoFocus 到第一个可聚焦元素 = 关闭按钮）
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭快捷键" }));
  });

  it("Esc 只关最内层：上面压着确认框时，快捷键面板不被一起关掉", () => {
    const closeHelp = vi.fn();
    const cancelConfirm = vi.fn();
    const help = render(<ShortcutsHelp onClose={closeHelp} />);
    const confirm = render(
      <ConfirmDialog title="确认测试" onCancel={cancelConfirm}>
        <p>内容</p>
      </ConfirmDialog>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(cancelConfirm).toHaveBeenCalledTimes(1);
    expect(closeHelp).not.toHaveBeenCalled();

    // 确认框卸载后，Esc 才轮到快捷键面板
    confirm.unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeHelp).toHaveBeenCalledTimes(1);
    help.unmount();
  });
});
