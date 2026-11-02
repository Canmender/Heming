import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MarkdownMessage } from "./MarkdownMessage";

/**
 * markdown 渲染的契约。
 *
 * 这里 mock 掉 shiki：真加载语法定义在 jsdom 里又慢又依赖 wasm，
 * 而本组件要验证的是「**有没有把高亮接上**」和「**接不上时会不会崩**」，
 * 高亮本身的正确性属于 shiki 的责任范围。
 */

// 用「带实现的 mock」而不是 vi.fn<签名>()：后者在这个 vitest 版本的泛型约束下
// 会被判为不满足 (...args: any[]) => any，类型检查过不了。
const highlightCode = vi.fn(
  async (_code: string, _lang: string): Promise<string | null> => null,
);

vi.mock("../lib/markdown/highlight.js", () => ({
  highlightCode: (code: string, lang: string) => highlightCode(code, lang),
}));

describe("MarkdownMessage", () => {
  beforeEach(() => {
    highlightCode.mockReset();
    highlightCode.mockResolvedValue('<pre class="shiki"><code><span>HIGHLIGHTED</span></code></pre>');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("空正文不渲染任何内容", () => {
    const { container } = render(<MarkdownMessage text="" />);
    expect(container.innerHTML).toBe("");
  });

  it("块级代码：带语言标签与复制按钮，并调用高亮", async () => {
    render(<MarkdownMessage text={"```ts\nconst a = 1;\n```"} />);
    // 语言标签来自围栏标注
    expect(screen.getByText("ts")).toBeTruthy();
    expect(screen.getByLabelText("复制代码")).toBeTruthy();
    await waitFor(() => expect(highlightCode).toHaveBeenCalledWith("const a = 1;", "ts"));
    await waitFor(() => expect(screen.getByText("HIGHLIGHTED")).toBeTruthy());
  });

  it("流式中不触发高亮（避免每个分片都重新解析）", async () => {
    render(<MarkdownMessage text={"```py\nprint(1)\n```"} streaming />);
    expect(screen.getByLabelText("复制代码")).toBeTruthy();
    // 给微任务一个机会：若误触发，这里会看到调用
    await Promise.resolve();
    expect(highlightCode).not.toHaveBeenCalled();
    // 内容仍然可见（纯文本回落）
    expect(screen.getByText(/print\(1\)/)).toBeTruthy();
  });

  it("未知语言：高亮返回 null 时回落纯文本，不报错", async () => {
    highlightCode.mockResolvedValue(null);
    render(<MarkdownMessage text={"```不存在的语言\nsome code\n```"} />);
    // 语言标签照常显示（用户写什么就显示什么）
    expect(screen.getByText("不存在的语言")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/some code/)).toBeTruthy());
  });

  it("高亮抛错不影响正文渲染", async () => {
    // 让 mock **始终** reject，但用 `mockImplementation` 而不是 `mockRejectedValue`：
    // 后者返回的 rejected Promise 在 React 渲染中被 await 而组件没 catch
    // → 产生 unhandled rejection 噪音（全量测试里表现为一条与本用例无关的报错）。
    //
    // 真实场景是「高亮失败，组件降级成纯文本」——组件内部有 catch，
    // 噪音来自**测试的 mock 与组件的 catch 之间的竞态**（StrictMode 下会调用多次）。
    // 这里让 reject 发生在调用侧且被组件的 catch 接住，用 try/catch 吞掉即可。
    highlightCode.mockImplementation(async () => {
      throw new Error("语法加载失败");
    });
    render(<MarkdownMessage text={"```js\nx\n```"} />);
    // 正文照样出来（高亮失败只是降级）
    await waitFor(() => expect(screen.getByText(/x/)).toBeTruthy());
  });

  it("行内代码不当作代码块（无复制按钮）", () => {
    render(<MarkdownMessage text={"用 `pnpm build` 构建"} />);
    expect(screen.getByText("pnpm build")).toBeTruthy();
    expect(screen.queryByLabelText("复制代码")).toBeNull();
  });

  it("复制按钮把代码写进剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MarkdownMessage text={"```js\nconst x = 42;\n```"} />);
    fireEvent.click(screen.getByLabelText("复制代码"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const x = 42;"));
    await waitFor(() => expect(screen.getByText("已复制")).toBeTruthy());
  });

  it("GFM 表格渲染成真表格", () => {
    render(<MarkdownMessage text={"| 项 | 值 |\n| --- | --- |\n| 版本 | 1.0 |"} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("版本")).toBeTruthy();
  });

  it("列表、引用、标题都渲染成对应语义元素", () => {
    const { container } = render(
      <MarkdownMessage text={"## 标题\n\n- 一\n- 二\n\n> 引用"} />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("标题");
    expect(container.querySelectorAll("li").length).toBe(2);
    expect(container.querySelector("blockquote")).toBeTruthy();
  });

  it("链接带 noopener noreferrer（消息内容不可信）", () => {
    render(<MarkdownMessage text={"[点我](https://example.com)"} />);
    const link = screen.getByText("点我");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("行内公式与块级公式渲染为 KaTeX，而不是裸源码", () => {
    const { container } = render(
      <MarkdownMessage text={"质能方程 $E=mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$"} />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).toBeTruthy();
    // 原始 $ 标记不应出现在可见文本里
    expect(container.textContent).not.toContain("$E=mc^2$");
  });

  it("图片点击打开 lightbox 显示原图，Esc 关闭", async () => {
    render(<MarkdownMessage text={"![猫](https://example.com/cat.png)"} />);
    fireEvent.click(screen.getByRole("button", { name: "查看图片 猫" }));
    const dialog = screen.getByRole("dialog", { name: "查看大图" });
    expect(dialog).toBeTruthy();
    const img = screen.getByTestId("markdown-lightbox-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://example.com/cat.png");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "查看大图" })).toBeNull());
  });

  /* ───────────── ③-4 安全复审：注入面回归（markdown 是模型输出） ───────────── */

  it("原始 HTML 一律按文本处理：script/img onerror 不会被解析成元素、也不会执行", () => {
    const { container } = render(
      <MarkdownMessage
        text={'<script>window.__xss = 1</script>\n\n<img src="x" onerror="window.__xss = 2">'}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    // 以文本形式可见（说明没有悄悄吞掉用户看到的原文）
    expect(container.textContent).toContain("<script>");
  });

  it("危险协议的链接被清洗：javascript: 不会进 href", () => {
    render(<MarkdownMessage text={"[点我](javascript:alert(1))"} />);
    const link = screen.getByText("点我");
    expect(link.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
  });

  it("KaTeX 默认不信任 \\href/\\htmlClass：不产生 javascript: 链接", () => {
    const { container } = render(
      <MarkdownMessage text={"$\\href{javascript:alert(1)}{点我}$"} />,
    );
    const anchors = [...container.querySelectorAll("a")];
    for (const a of anchors) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    }
  });

  it("代码块内容按文本渲染（shiki HTML 由本库转义生成）", async () => {
    highlightCode.mockResolvedValue(
      '<pre class="shiki"><code><span>&lt;img src=x onerror=alert(1)&gt;</span></code></pre>',
    );
    const { container } = render(<MarkdownMessage text={"```html\n<img src=x onerror=alert(1)>\n```"} />);
    await waitFor(() => expect(container.querySelector(".shiki")).toBeTruthy());
    // 代码块里只会有一个由 shiki 生成的 <span>，不会把内容解析成真实 img
    expect(container.querySelector("img")).toBeNull();
  });
});