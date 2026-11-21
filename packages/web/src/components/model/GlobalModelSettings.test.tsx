import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { GlobalModelSettings } from "./GlobalModelSettings.js";

/**
 * 全局模型设置（后缀 / 压缩 / 窗口上限）：onRun 抛错时 busy 必须解除，否则控件永久禁用。
 */
const baseProps = {
  suffix: { mode: "off" as const },
  compact: { fullContext: false },
  contextCap: {},
  capSupported: true,
  cliReady: true,
};

describe("GlobalModelSettings · busy 收口", () => {
  it("onRun 拒绝后所有控件不再禁用（d.412 回归）", async () => {
    const onRun = vi.fn(async () => {
      throw new Error("内核断开");
    });
    render(<GlobalModelSettings {...baseProps} onRun={onRun} />);

    const select = screen.getByLabelText("模型名字后缀") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "on" } });
    const save = screen.getByRole("button", { name: "保存后缀" });
    fireEvent.click(save);

    // 拒绝之后 busy 必须清掉：下拉与按钮都恢复可用，且不会一直转圈。
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(save).not.toHaveAttribute("aria-busy", "true");
  });
});
