import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TagPanel, normalizeTags } from "./TagPanel.js";

describe("标签面板", () => {
  const tags = new Map<string, string[]>([
    ["项目", ["a.md", "b.md", "c.md"]],
    ["资料/前端", ["a.md"]],
    ["随笔", ["b.md", "c.md"]],
  ]);

  it("按数量降序排列（同数量按名称）", () => {
    expect(normalizeTags(tags)).toEqual([
      { tag: "项目", count: 3 },
      { tag: "随笔", count: 2 },
      { tag: "资料/前端", count: 1 },
    ]);
  });

  it("点击标签按标签过滤；再点一次取消过滤", () => {
    const onSelectTag = vi.fn();
    const { rerender } = render(<TagPanel tags={tags} onSelectTag={onSelectTag} />);
    fireEvent.click(screen.getByRole("button", { name: "按标签 项目 过滤（3 篇）" }));
    expect(onSelectTag).toHaveBeenCalledWith("项目");

    rerender(<TagPanel tags={tags} activeTag="项目" onSelectTag={onSelectTag} />);
    const active = screen.getByRole("button", { name: "按标签 项目 过滤（3 篇）" });
    expect(active).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(active);
    expect(onSelectTag).toHaveBeenLastCalledWith(null);
  });

  it("提供「清除过滤」入口", () => {
    const onSelectTag = vi.fn();
    render(<TagPanel tags={tags} activeTag="项目" onSelectTag={onSelectTag} />);
    expect(screen.getByText("#项目", { selector: "span.font-medium" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除标签过滤：项目" }));
    expect(onSelectTag).toHaveBeenCalledWith(null);
  });

  it("筛选框按子串过滤标签，不匹配时给空态", () => {
    render(<TagPanel tags={tags} onSelectTag={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("筛选标签"), { target: { value: "前" } });
    expect(screen.getByText("#资料/前端")).toBeInTheDocument();
    expect(screen.queryByText("#项目")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("筛选标签"), { target: { value: "不存在" } });
    expect(screen.getByText(/没有匹配「不存在」的标签/)).toBeInTheDocument();
  });

  it("空标签库：说明去哪儿写标签", () => {
    render(<TagPanel tags={new Map()} onSelectTag={vi.fn()} />);
    expect(screen.getByText(/还没有标签/)).toBeInTheDocument();
  });

  it("也接受 [{tag,count}] 形式（记忆页/测试可以传派生数据）", () => {
    render(
      <TagPanel
        tags={[
          { tag: "b", count: 1 },
          { tag: "a", count: 2 },
        ]}
        onSelectTag={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "按标签 a 过滤（2 篇）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按标签 b 过滤（1 篇）" })).toBeInTheDocument();
  });
});
