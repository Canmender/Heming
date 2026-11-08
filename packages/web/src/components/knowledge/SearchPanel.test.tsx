import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SearchHit } from "../../lib/vault/types.js";
import { SearchPanel, highlightTerms, splitHighlight } from "./SearchPanel.js";

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  rel: "notes/会议.md",
  line: 12,
  snippet: "会议结论：下周继续跟进预算",
  score: 10,
  matched: ["content"],
  ...over,
});

describe("搜索语法高亮（纯函数）", () => {
  it("从查询里取正向词：去 key 前缀、引号、排除项与纯符号", () => {
    // 等长词保持 token 顺序；长词优先（避免短词切碎长词）
    expect(highlightTerms('tag:#项目 "会议 结论" -草稿 line:预算')).toEqual([
      "会议 结论",
      "项目",
      "预算",
    ]);
  });

  it("按正向词切片并标命中（大小写不敏感、正则字符安全）", () => {
    const parts = splitHighlight("结论：a+b 正确", ["a+b"]);
    expect(parts).toEqual([
      { text: "结论：", hit: false },
      { text: "a+b", hit: true },
      { text: " 正确", hit: false },
    ]);
  });
});

describe("搜索面板", () => {
  it("空查询：语法引导 + 本地数据说明", () => {
    render(<SearchPanel query="" onQueryChange={vi.fn()} hits={[]} onOpenHit={vi.fn()} />);
    expect(screen.getByLabelText("搜索知识库")).toBeInTheDocument();
    expect(screen.getByText(/数据全部在本机/)).toBeInTheDocument();
  });

  it("输入回调；清空按钮走 onClear", () => {
    const onQueryChange = vi.fn();
    const onClear = vi.fn();
    render(
      <SearchPanel query="abc" onQueryChange={onQueryChange} hits={[]} onOpenHit={vi.fn()} onClear={onClear} />,
    );
    fireEvent.change(screen.getByLabelText("搜索知识库"), { target: { value: "abcd" } });
    expect(onQueryChange).toHaveBeenCalledWith("abcd");
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("命中行显示 rel / 行号 / 高亮片段，点击跳转", () => {
    const onOpenHit = vi.fn();
    render(
      <SearchPanel query="预算" onQueryChange={vi.fn()} hits={[hit()]} onOpenHit={onOpenHit} />,
    );
    expect(screen.getByText("notes/会议.md")).toBeInTheDocument();
    expect(screen.getByText("第 12 行")).toBeInTheDocument();
    // 命中词包在 <mark> 里
    const mark = document.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent("预算");
    fireEvent.click(screen.getByRole("button", { name: "打开 notes/会议.md 第 12 行" }));
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ rel: "notes/会议.md", line: 12 }));
  });

  it("已执行但无结果：给可操作的空态（不是只说没有）", () => {
    render(
      <SearchPanel query="找不到" searched onQueryChange={vi.fn()} hits={[]} onOpenHit={vi.fn()} />,
    );
    expect(screen.getByText(/没有匹配的笔记/)).toBeInTheDocument();
  });

  it("索引未就绪时禁用输入并说明", () => {
    render(
      <SearchPanel query="" disabled onQueryChange={vi.fn()} hits={[]} onOpenHit={vi.fn()} />,
    );
    expect(screen.getByLabelText("搜索知识库")).toBeDisabled();
    expect(screen.getByText(/索引还在建/)).toBeInTheDocument();
  });

  it("语法提示可点：把 token 拼到查询末尾（mousedown 不会被 blur 抢先收起）", () => {
    const onQueryChange = vi.fn();
    render(<SearchPanel query="会议" onQueryChange={onQueryChange} hits={[]} onOpenHit={vi.fn()} />);
    fireEvent.focus(screen.getByLabelText("搜索知识库"));
    fireEvent.mouseDown(screen.getByRole("button", { name: /按标签过滤/ }));
    expect(onQueryChange).toHaveBeenCalledWith("会议 tag:");
  });

  it("结果到 200 条时提示上限", () => {
    const hits = Array.from({ length: 200 }, (_, i) =>
      hit({ rel: `n/${i}.md`, line: i + 1, snippet: "预算" }),
    );
    render(<SearchPanel query="预算" onQueryChange={vi.fn()} hits={hits} onOpenHit={vi.fn()} />);
    expect(screen.getByText(/已到 200 条上限/)).toBeInTheDocument();
  });
});
