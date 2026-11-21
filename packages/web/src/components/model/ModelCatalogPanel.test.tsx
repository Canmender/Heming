import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModelCatalogPanel } from "./ModelCatalogPanel.js";
import type { ModelRow } from "../../lib/modelCatalog.js";

/**
 * 模型目录面板：「测试全部模型」跑完后按钮要能再点，剪贴板缺失不能假报「已复制」。
 */
function row(id: string): ModelRow {
  return {
    id,
    provider: "openai",
    name: id,
    efforts: [],
    vision: false,
    inCatalog: true,
  };
}

const onRunOk = vi.fn(async () => ({ ok: true, text: "ok" }));

describe("ModelCatalogPanel · 批量测试与复制", () => {
  it("测试全部跑完后按钮可再点，结果行仍在（d.412 回归）", async () => {
    onRunOk.mockClear();
    render(
      <ModelCatalogPanel rows={[row("openai/gpt-x")]} disabled={[]} cliReady onRun={onRunOk} />,
    );
    const testAll = screen.getByRole("button", { name: "测试全部模型" });
    fireEvent.click(testAll);
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("测试完 1 个模型"));
    // 旧写法：bulk 非 null → 按钮永久禁用。修复后结果行保留，但按钮可再点。
    expect(testAll).not.toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("1 个通过");
  });

  it("剪贴板不可用时复制按钮不假报「已复制」（d.412 回归）", async () => {
    const original = navigator.clipboard;
    // 模拟不安全上下文里没有剪贴板 API
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      render(
        <ModelCatalogPanel rows={[row("openai/gpt-x")]} disabled={[]} cliReady onRun={onRunOk} />,
      );
      const copy = screen.getByRole("button", { name: /复制模型 ID/ });
      fireEvent.click(copy);
      await waitFor(() => expect(screen.getByText("复制 ID")).toBeInTheDocument());
      expect(screen.queryByText("已复制")).toBeNull();
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
    }
  });
});
