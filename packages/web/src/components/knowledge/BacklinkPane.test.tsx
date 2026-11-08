import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Heading } from "../../lib/vault/types.js";
import { BacklinkPane } from "./BacklinkPane.js";
import { wikiLink } from "./testFixtures.js";

const headings: Heading[] = [
  { level: 1, text: "来源", line: 1 },
  { level: 2, text: "细节", line: 6 },
];

function setup(overrides: Partial<React.ComponentProps<typeof BacklinkPane>> = {}) {
  const props: React.ComponentProps<typeof BacklinkPane> = {
    rel: "notes/source.md",
    backlinks: [
      wikiLink({ target: "source", from: "notes/a.md", line: 3, resolved: "notes/source.md" }),
    ],
    outlinks: [
      wikiLink({ target: "target", from: "notes/source.md", line: 5, resolved: "notes/target.md" }),
      wikiLink({ target: "待建", from: "notes/source.md", line: 7 }),
    ],
    unresolved: [wikiLink({ target: "待建", from: "notes/source.md", line: 7 })],
    headings,
    frontmatter: { title: "来源页", aliases: ["源", "来源页"] },
    onOpen: vi.fn(),
    onCreatePage: vi.fn(),
    onJumpToLine: vi.fn(),
    ...overrides,
  };
  render(<BacklinkPane {...props} />);
  return props;
}

describe("右栏面板", () => {
  it("五个 tab 都渲染，数量角标取自各自数据", () => {
    setup();
    expect(screen.getByRole("tab", { name: /反链/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /出链/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /未解析/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /大纲/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /属性/ })).toBeInTheDocument();
  });

  it("反链：点来源行打开来源页", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /打开反链来源 notes\/a\.md/ }));
    expect(props.onOpen).toHaveBeenCalledWith("notes/a.md");
  });

  it("反链为空时给引导文案（告诉用户怎么写链接）", () => {
    setup({ backlinks: [] });
    expect(screen.getByText(/还没有其它笔记链接到这里/)).toBeInTheDocument();
    expect(screen.getByText(/\[\[source\]\]/)).toBeInTheDocument();
  });

  it("出链：已解析打开目标，未解析走建页", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("tab", { name: /出链/ }));
    fireEvent.click(screen.getByRole("button", { name: /打开出链目标 notes\/target\.md/ }));
    expect(props.onOpen).toHaveBeenCalledWith("notes/target.md");
    fireEvent.click(screen.getByRole("button", { name: /创建页面 待建/ }));
    expect(props.onCreatePage).toHaveBeenCalledWith("待建");
  });

  it("未解析面板：列出断链并可一键建页", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("tab", { name: /未解析/ }));
    fireEvent.click(screen.getByRole("button", { name: /创建页面 待建/ }));
    expect(props.onCreatePage).toHaveBeenCalledWith("待建");
  });

  it("未解析为空时显示「没有未解析的链接」", () => {
    setup({ unresolved: [] });
    fireEvent.click(screen.getByRole("tab", { name: /未解析/ }));
    expect(screen.getByText("没有未解析的链接。")).toBeInTheDocument();
  });

  it("大纲：点标题跳行", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("tab", { name: /大纲/ }));
    fireEvent.click(screen.getByRole("button", { name: "跳到标题 细节" }));
    expect(props.onJumpToLine).toHaveBeenCalledWith(6);
  });

  it("属性：frontmatter 数组值以顿号连接", () => {
    setup();
    fireEvent.click(screen.getByRole("tab", { name: /属性/ }));
    expect(screen.getByText("aliases")).toBeInTheDocument();
    expect(screen.getByText("源、来源页")).toBeInTheDocument();
  });

  it("属性为空时给说明", () => {
    setup({ frontmatter: {} });
    fireEvent.click(screen.getByRole("tab", { name: /属性/ }));
    expect(screen.getByText(/这篇笔记没有属性/)).toBeInTheDocument();
  });

  it("键盘：左右方向键在 tab 间切换", () => {
    setup();
    const tablist = screen.getByRole("tablist", { name: "笔记结构与链接" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /出链/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /反链/ })).toHaveAttribute("aria-selected", "true");
  });
});
