import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PreviewPane } from "./PreviewPane.js";
import { makeIndex, pageInfo, wikiLink } from "./testFixtures.js";
import { parseWikiToken } from "./remarkWikiLinks.js";
import { decodeWikiHref, encodeWikiHref, resolveWikiTarget } from "./wikilinks.js";

describe("双链解析（最短唯一路径）", () => {
  const index = makeIndex([
    pageInfo({ rel: "notes/target.md", title: "target" }),
    pageInfo({ rel: "inbox/other.md", title: "other" }),
    pageInfo({ rel: "a/dup.md", title: "dup" }),
    pageInfo({ rel: "b/sub/dup.md", title: "dup" }),
    pageInfo({ rel: "notes/aliased.md", title: "aliased", aliases: ["别名页"] }),
  ]);

  it("按文件名精确解析；带 .md 与不带都可以", () => {
    expect(resolveWikiTarget(index, "notes/target.md", "target")).toEqual({
      rel: "notes/target.md",
      ambiguous: false,
    });
    expect(resolveWikiTarget(index, "notes/target.md", "target.md").rel).toBe("notes/target.md");
  });

  it("带路径按库根解析；前导 / 视为库根绝对", () => {
    expect(resolveWikiTarget(index, "x.md", "inbox/other").rel).toBe("inbox/other.md");
    expect(resolveWikiTarget(index, "x.md", "/inbox/other").rel).toBe("inbox/other.md");
  });

  it("别名可解析；空索引一律未解析（不猜）", () => {
    expect(resolveWikiTarget(index, "x.md", "别名页").rel).toBe("notes/aliased.md");
    expect(resolveWikiTarget(null, "x.md", "target")).toEqual({ rel: null, ambiguous: false });
    expect(resolveWikiTarget(makeIndex([]), "x.md", "target").rel).toBeNull();
  });

  it("同名歧义：取离当前文件最近的一个并标记 ambiguous", () => {
    const nearB = resolveWikiTarget(index, "b/other.md", "dup");
    expect(nearB.ambiguous).toBe(true);
    expect(nearB.rel).toBe("b/sub/dup.md");
    const nearA = resolveWikiTarget(index, "a/other.md", "dup");
    expect(nearA.rel).toBe("a/dup.md");
  });

  it("找不到返回 null", () => {
    expect(resolveWikiTarget(index, "x.md", "没有这页").rel).toBeNull();
  });

  it("渲染地址编解码往返", () => {
    const href = encodeWikiHref("link", "带 空格/页面");
    expect(href.startsWith("#vault-link/")).toBe(true);
    expect(decodeWikiHref(href)).toEqual({ kind: "link", target: "带 空格/页面" });
    expect(decodeWikiHref("https://example.com")).toBeNull();
    expect(decodeWikiHref(undefined)).toBeNull();
  });

  it("token 解析：别名 / 锚点 / 嵌入", () => {
    expect(parseWikiToken("[[a|别名]]")).toEqual({
      embed: false,
      target: "a",
      alias: "别名",
      heading: undefined,
    });
    expect(parseWikiToken("![[图片.png]]")).toEqual({
      embed: true,
      target: "图片.png",
      alias: undefined,
      heading: undefined,
    });
    expect(parseWikiToken("[[a#小节]]")?.heading).toBe("小节");
    expect(parseWikiToken("[[ ]]")).toBeNull();
  });
});

describe("预览面板", () => {
  const index = makeIndex(
    [pageInfo({ rel: "notes/target.md", title: "target" }), pageInfo({ rel: "notes/图.png", title: "图" })],
    [],
  );

  it("普通 markdown 结构照常渲染", () => {
    render(<PreviewPane rel="a.md" text={"# 标题\n\n- 一\n- 二\n\n> 引用"} index={index} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByText("一")).toBeInTheDocument();
    expect(screen.getByText("引用")).toBeInTheDocument();
  });

  it("已解析双链渲染成可点 chip 并带别名", () => {
    const onOpenLink = vi.fn();
    render(
      <PreviewPane rel="notes/source.md" text={"看 [[target|别名]]"} index={index} onOpenLink={onOpenLink} />,
    );
    const chip = screen.getByRole("button", { name: "打开页面 别名" });
    chip.click();
    expect(onOpenLink).toHaveBeenCalledWith("notes/target.md");
  });

  it("未解析双链：提示未创建，点击走建页回调", () => {
    const onCreatePage = vi.fn();
    render(
      <PreviewPane rel="notes/source.md" text={"看 [[不存在的页]]"} index={index} onCreatePage={onCreatePage} />,
    );
    expect(screen.getByText("未创建")).toBeInTheDocument();
    screen.getByRole("button", { name: "创建页面 不存在的页（当前未解析）" }).click();
    expect(onCreatePage).toHaveBeenCalledWith("不存在的页");
  });

  it("代码块与行内代码里的 [[链接]] 不算双链", () => {
    const text = ["行内 `[[inline]]`", "", "```md", "[[fence]]", "```"].join("\n");
    render(<PreviewPane rel="a.md" text={text} index={index} />);
    expect(screen.queryByRole("button", { name: /inline/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fence/ })).not.toBeInTheDocument();
    // 原文保留在代码里
    expect(screen.getByText("[[fence]]")).toBeInTheDocument();
  });

  it("![[图片]] 通过 resolveImage 渲染 data URL 图片", async () => {
    const resolveImage = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    render(
      <PreviewPane
        rel="notes/source.md"
        text={"![[notes/图.png]]"}
        index={index}
        resolveImage={resolveImage}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("vault-preview-image")).toBeInTheDocument());
    expect(resolveImage).toHaveBeenCalledWith("notes/图.png");
    expect(screen.getByTestId("vault-preview-image")).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA",
    );
  });

  it("![[笔记]] 限深嵌入：顶层嵌入一次，内层不再递归", () => {
    const resolveDoc = vi.fn((rel: string) =>
      rel === "notes/target.md" ? { rel, text: `嵌入正文 [[notes/target.md]]` } : null,
    );
    render(
      <PreviewPane
        rel="notes/source.md"
        text={"![[target]]"}
        index={index}
        resolveDoc={resolveDoc}
        onOpenLink={() => {}}
      />,
    );
    expect(screen.getByText("嵌入：notes/target.md")).toBeInTheDocument();
    expect(screen.getByText("嵌入正文")).toBeInTheDocument();
    // 内层再出现的 `![[...]]` 已经到深度上限，退回普通 chip（防环）
    expect(screen.getByRole("button", { name: "打开页面 notes/target.md" })).toBeInTheDocument();
  });

  it("不注入 raw HTML：正文里的 script 标签不会变成元素", () => {
    const { container } = render(
      <PreviewPane rel="a.md" text={'<script>alert("x")</script>'} index={index} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText('<script>alert("x")</script>')).toBeInTheDocument();
  });

  it("外链只放行 http(s)/mailto，其它协议降级为文字", () => {
    render(
      <PreviewPane
        rel="a.md"
        text={"[官网](https://example.com) [坏链](javascript:alert(1))"}
        index={index}
      />,
    );
    expect(screen.getByRole("link", { name: "官网" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.queryByRole("link", { name: "坏链" })).not.toBeInTheDocument();
    expect(screen.getByText("坏链")).toBeInTheDocument();
  });

  it("空正文给空态提示", () => {
    render(<PreviewPane rel="a.md" text="   " index={index} />);
    expect(screen.getByText(/这篇笔记还是空的/)).toBeInTheDocument();
  });

  it("外部 resolve 覆盖默认解析", () => {
    const onOpenLink = vi.fn();
    render(
      <PreviewPane
        rel="a.md"
        text={"[[故意]]"}
        index={index}
        resolve={(target) => (target === "故意" ? "notes/target.md" : null)}
        onOpenLink={onOpenLink}
      />,
    );
    screen.getByRole("button", { name: "打开页面 故意" }).click();
    expect(onOpenLink).toHaveBeenCalledWith("notes/target.md");
  });
});

describe("预览面板 · 反链链接行号元数据", () => {
  it("wikiLink 夹具默认 1 基行号", () => {
    expect(wikiLink({ target: "a", from: "b.md" }).line).toBe(1);
  });
});
