import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GraphPane } from "./GraphPane.js";
import { makeIndex, pageInfo, wikiLink } from "./testFixtures.js";

function sample() {
  return makeIndex(
    [
      pageInfo({ rel: "notes/a.md", title: "a" }),
      pageInfo({ rel: "notes/b.md", title: "b" }),
      pageInfo({ rel: "notes/c.md", title: "c" }),
    ],
    [
      wikiLink({ target: "b", from: "notes/a.md", resolved: "notes/b.md" }),
      wikiLink({ target: "c", from: "notes/b.md", resolved: "notes/c.md" }),
    ],
  );
}

describe("图谱面板", () => {
  it("索引为空：给空态提示，不画空画布", () => {
    render(<GraphPane index={null} onOpen={vi.fn()} />);
    expect(screen.getByText(/还没有页面/)).toBeInTheDocument();
  });

  it("全库：统计页数与链接数，并说明度数是全库口径", () => {
    render(<GraphPane index={sample()} onOpen={vi.fn()} />);
    expect(screen.getByText("3 页 · 2 条链接")).toBeInTheDocument();
    expect(screen.getByText(/节点大小按全库度数/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全库" })).toHaveAttribute("aria-pressed", "true");
  });

  it("点节点打开页面", () => {
    const onOpen = vi.fn();
    render(<GraphPane index={sample()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "打开页面 b" }));
    expect(onOpen).toHaveBeenCalledWith("notes/b.md");
  });

  it("没有当前页时局部图不可用", () => {
    render(<GraphPane index={sample()} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "局部" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "局部" }).getAttribute("title")).toContain(
      "先打开一篇笔记",
    );
  });

  it("局部图：按当前页 1–2 跳裁剪节点", () => {
    render(<GraphPane index={sample()} activeRel="notes/b.md" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "局部" }));
    expect(screen.getByText(/以 notes\/b\.md 为中心 1 跳/)).toBeInTheDocument();
    // b 的 1 跳邻居是 a 和 c
    expect(screen.getAllByRole("button", { name: /打开页面/ })).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "局部 2 跳" }));
    expect(screen.getByText(/以 notes\/b\.md 为中心 2 跳/)).toBeInTheDocument();
  });

  it("局部图只有一个孤立页时仍画出该节点，不误报空库", () => {
    const index = makeIndex([pageInfo({ rel: "only.md", title: "only" })], []);
    render(<GraphPane index={index} activeRel="only.md" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "局部" }));
    expect(screen.getByText(/1 页 · 0 条链接/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开页面 only" })).toBeInTheDocument();
  });
});
