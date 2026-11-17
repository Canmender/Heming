import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangeDiffDialog, type ChangeDiffState } from "./ChangeDiffDialog.js";

function state(overrides: Partial<ChangeDiffState> = {}): ChangeDiffState {
  return {
    path: "D:/库/src/a.ts",
    loading: false,
    error: null,
    before: "第一行\n第二行\n",
    after: "第一行\n第二行改过\n",
    ...overrides,
  };
}

describe("改动对照弹窗（d.207.4.110）", () => {
  it("展示文件名、统计与增删行，关掉时回调一次", () => {
    const onClose = vi.fn();
    render(<ChangeDiffDialog state={state()} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "文件改动" })).toBeInTheDocument();
    expect(screen.getByText("改动对照 · a.ts")).toBeInTheDocument();
    expect(screen.getByText("新增 1 行 · 删除 1 行")).toBeInTheDocument();
    expect(screen.getByTestId("diff-row-del")).toHaveTextContent("第二行");
    expect(screen.getByTestId("diff-row-add")).toHaveTextContent("第二行改过");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("读不到时只说原因，不画一份空对照", () => {
    render(
      <ChangeDiffDialog
        state={state({
          before: null,
          after: null,
          error: "没有可对比的备份（新建的文件没有改动前内容）",
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("没有可对比的备份");
    expect(screen.queryByTestId("diff-row-add")).toBeNull();
    expect(screen.queryByTestId("diff-row-del")).toBeNull();
  });

  it("加载中显示进度，不显示对照", () => {
    render(<ChangeDiffDialog state={state({ loading: true, before: null, after: null })} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读改动前的版本");
    expect(screen.queryByTestId("diff-row-add")).toBeNull();
  });

  it("内容一致时如实说没变化；截断时提示「只是其中一部分」", () => {
    render(
      <ChangeDiffDialog
        state={state({ before: "同一行\n", after: "同一行\n", beforeTruncated: true, afterTruncated: true })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/内容没有变化/)).toBeInTheDocument();
    expect(screen.getByText(/只读了前 256KB/)).toBeInTheDocument();
    expect(screen.getByText(/只读了前 2MB/)).toBeInTheDocument();
    expect(screen.queryByTestId("diff-row-same")).toBeNull();
  });
});

describe("改动对照弹窗 · 会话文件列表（d.210）", () => {
  const files = [
    { path: "D:/库/src/b.ts", at: 2000, writes: 3 },
    { path: "D:/库/src/a.ts", at: 1000, writes: 1 },
  ];

  it("给了 files 就列在左边，当前文件高亮，点另一条回传路径", () => {
    const onPick = vi.fn();
    render(<ChangeDiffDialog state={state()} onClose={() => {}} files={files} onPick={onPick} />);

    expect(screen.getByText("本会话改过的文件 · 2 个")).toBeInTheDocument();
    expect(screen.getByTestId("change-diff-files")).toBeInTheDocument();
    // 次数如实显示（同一文件改 3 次是有用信号）
    expect(screen.getByText("改过 3 次")).toBeInTheDocument();
    expect(screen.getByText("改过 1 次")).toBeInTheDocument();
    // 当前打开的是 a.ts
    const active = screen.getByRole("button", { name: /a\.ts/ });
    expect(active).toHaveAttribute("aria-current", "true");

    fireEvent.click(screen.getByRole("button", { name: /b\.ts/ }));
    expect(onPick).toHaveBeenCalledWith("D:/库/src/b.ts");
  });

  it("没给 files 时不显示列表，标题仍是单文件（老入口行为不变）", () => {
    render(<ChangeDiffDialog state={state()} onClose={() => {}} />);
    expect(screen.queryByTestId("change-diff-files")).toBeNull();
    expect(screen.getByText("改动对照 · a.ts")).toBeInTheDocument();
  });
});
describe("只看改动（d.239）", () => {
  const fileWithContext = {
    path: "D:/库/src/a.ts",
    loading: false,
    error: null,
    before: "一\n二\n三\n四\n五\n六\n七\n八\n九\n目标旧\n",
    after: "一\n二\n三\n四\n五\n六\n七\n八\n九\n目标新\n",
  };

  it("默认显示上下文，可切成「只看改动」且随时切回", () => {
    render(<ChangeDiffDialog state={fileWithContext} onClose={() => {}} />);
    expect(screen.getAllByTestId("diff-row-same").length).toBeGreaterThan(0);
    expect(screen.getByTestId("diff-row-count").textContent).toContain("含上下文");

    fireEvent.click(screen.getByRole("button", { name: "只看改动" }));
    expect(screen.queryAllByTestId("diff-row-same")).toHaveLength(0);
    expect(screen.getByTestId("diff-row-count").textContent).toContain("已隐藏未改动的行");
    expect(screen.getByTestId("diff-row-del").textContent).toContain("目标旧");
    expect(screen.getByTestId("diff-row-add").textContent).toContain("目标新");

    fireEvent.click(screen.getByRole("button", { name: "显示上下文" }));
    expect(screen.getAllByTestId("diff-row-same").length).toBeGreaterThan(0);
  });

  it("整份都是改动（没有上下文行）时不出这个开关，不给死按钮", () => {
    render(
      <ChangeDiffDialog
        state={{ path: "D:/库/新.md", loading: false, error: null, before: "", after: "新一\n新二\n" }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "只看改动" })).toBeNull();
  });
});
