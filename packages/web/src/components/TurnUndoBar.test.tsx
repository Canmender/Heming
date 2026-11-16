import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TurnUndoBar } from "./TurnUndoBar.js";

/**
 * 「本轮改动可撤回」（d.176）。
 *
 * 这块的价值全在「点一下就回到改动前的样子」，所以用例只盯三件事：
 * 说清改了哪几个、两个按钮各调什么、撤回中不能连点两次。
 */
describe("TurnUndoBar（d.176）", () => {
  it("说清这一轮改了哪些文件（文件名而不是整条路径）", () => {
    render(
      <TurnUndoBar
        paths={["D:/work/src/a.ts", "D:/work/docs/说明.md"]}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("本轮改了 a.ts、说明.md");
    expect(bar.textContent).toContain("改错了可以撤回");
    // 整条路径放在 title 里，需要时能看到全貌。
    expect(bar.querySelector("[title]")?.getAttribute("title")).toContain("D:/work/src/a.ts");
  });

  it("超过三个只报数量，不把整串路径铺开", () => {
    render(
      <TurnUndoBar
        paths={["D:/a.ts", "D:/b.ts", "D:/c.ts", "D:/d.ts"]}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("a.ts、b.ts、c.ts");
    expect(screen.getByRole("status").textContent).toContain("等 4 个");
  });

  it("两个按钮分别走撤回与保留", () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(<TurnUndoBar paths={["D:/a.ts"]} onUndo={onUndo} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "撤回本轮改动" }));
    expect(onUndo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("撤回中两个按钮都不能再点（避免连点造成两次撤销）", () => {
    const onUndo = vi.fn();
    render(<TurnUndoBar paths={["D:/a.ts"]} busy onUndo={onUndo} onDismiss={vi.fn()} />);

    const undo = screen.getByRole("button", { name: "正在撤回…" });
    expect(undo).toBeDisabled();
    expect(screen.getByRole("button", { name: "保留" })).toBeDisabled();
    fireEvent.click(undo);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("空数组什么都不渲染（没改文件的回合不该露头）", () => {
    const { container } = render(<TurnUndoBar paths={[]} onUndo={vi.fn()} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
