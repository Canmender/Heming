import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { VaultIndex } from "../../lib/vault/types.js";
import { QuickOpen } from "./QuickOpen.js";
import type { QuickOpenNote } from "./quickOpenModel.js";

/** 假排序函数：只按标题包含过滤，顺序固定（真排序在引擎用例里覆盖）。 */
function fakeRank(index: VaultIndex | null, query: string): QuickOpenNote[] {
  if (!index) return [];
  const notes = [...index.pages.values()].map((page) => ({
    rel: page.rel,
    title: page.title,
    dir: page.rel.includes("/") ? page.rel.split("/").slice(0, -1).join("/") : "",
    matchKind: "title" as const,
  }));
  const q = query.trim().toLowerCase();
  return (q ? notes.filter((note) => note.title.toLowerCase().includes(q)) : notes).slice(0, 10);
}

/** 最小索引（只用到 pages）。 */
function tinyIndex(): VaultIndex {
  return {
    pages: new Map([
      ["notes/a.md", { rel: "notes/a.md", title: "阿尔法" }],
      ["notes/b.md", { rel: "notes/b.md", title: "贝塔" }],
    ]),
    links: [],
    backlinks: new Map(),
    unresolved: [],
    tags: new Map(),
    orphans: [],
    ambiguous: new Map(),
  } as unknown as VaultIndex;
}

describe("快速切换（Ctrl+O 浮层）", () => {
  it("打开时列出候选（含所属目录），关闭时不渲染", () => {
    const { rerender } = render(
      <QuickOpen open={false} index={tinyIndex()} onClose={vi.fn()} onOpen={vi.fn()} rank={fakeRank} />,
    );
    expect(screen.queryByRole("dialog", { name: "快速切换笔记" })).not.toBeInTheDocument();
    rerender(
      <QuickOpen open index={tinyIndex()} onClose={vi.fn()} onOpen={vi.fn()} rank={fakeRank} />,
    );
    expect(screen.getByRole("dialog", { name: "快速切换笔记" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "打开 阿尔法" })).toBeInTheDocument();
    expect(screen.getAllByText(/notes/).length).toBeGreaterThan(0);
  });

  it("输入过滤；↑↓ 移动；Enter 打开；打开后关闭", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<QuickOpen open index={tinyIndex()} onClose={onClose} onOpen={onOpen} rank={fakeRank} />);
    const input = screen.getByLabelText("输入笔记名快速切换");
    fireEvent.change(input, { target: { value: "贝" } });
    expect(screen.queryByRole("option", { name: "打开 阿尔法" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("notes/b.md");
    expect(onClose).toHaveBeenCalled();
  });

  it("↑↓ 切换选中项", () => {
    render(<QuickOpen open index={tinyIndex()} onClose={vi.fn()} onOpen={vi.fn()} rank={fakeRank} />);
    const input = screen.getByLabelText("输入笔记名快速切换");
    expect(screen.getByRole("option", { name: "打开 阿尔法" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "打开 贝塔" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: "打开 阿尔法" })).toHaveAttribute("aria-selected", "true");
  });

  it("Esc 关闭", () => {
    const onClose = vi.fn();
    render(<QuickOpen open index={tinyIndex()} onClose={onClose} onOpen={vi.fn()} rank={fakeRank} />);
    fireEvent.keyDown(screen.getByLabelText("输入笔记名快速切换"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("索引未就绪 / 无匹配：给可读空态", () => {
    render(<QuickOpen open index={null} onClose={vi.fn()} onOpen={vi.fn()} rank={fakeRank} />);
    expect(screen.getByText(/索引还没建好/)).toBeInTheDocument();
  });
});
