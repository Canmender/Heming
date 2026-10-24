import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFileBlobText, fetchFileBlobUrl } from "../lib/api.js";
import { FilePreviewModal, MarkdownLite } from "./FilePreviewModal.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchFileBlobUrl: vi.fn(), fetchFileBlobText: vi.fn() };
});

const file = { id: "f1", owner: "me", name: "a.md", mime: "text/markdown", size: 10, updatedAt: "" };

describe("FilePreviewModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("markdown 渲染标题与粗体为 React 节点（无 innerHTML）", async () => {
    vi.mocked(fetchFileBlobText).mockResolvedValue("# 标题\n**加粗** 正文");
    render(<FilePreviewModal file={file} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
    expect(screen.getByText("加粗").tagName).toBe("STRONG");
  });

  it("图片走 blob url", async () => {
    vi.mocked(fetchFileBlobUrl).mockResolvedValue("blob:mock");
    render(<FilePreviewModal file={{ ...file, name: "a.png", mime: "image/png" }} onClose={() => {}} />);
    const img = await screen.findByAltText("a.png");
    expect(img.getAttribute("src")).toBe("blob:mock");
  });

  it("不支持的 mime 提示并给下载入口", async () => {
    vi.mocked(fetchFileBlobUrl).mockResolvedValue("blob:dl");
    render(<FilePreviewModal file={{ ...file, name: "a.zip", mime: "application/zip" }} onClose={() => {}} />);
    expect(await screen.findByText(/不支持内嵌预览/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /下载/ })).toBeTruthy();
  });

  it("加载失败显示原因并可重试", async () => {
    vi.mocked(fetchFileBlobText).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("恢复了");
    render(<FilePreviewModal file={file} onClose={() => {}} />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    // 点重试重跑加载，成功后进入正文
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("恢复了")).toBeTruthy();
  });

  it("script 字样作为文本渲染（React 文本节点转义，不产生脚本元素）", async () => {
    vi.mocked(fetchFileBlobText).mockResolvedValue("<script>alert(1)</script>");
    const { container } = render(<FilePreviewModal file={file} onClose={() => {}} />);
    expect(await screen.findByText("<script>alert(1)</script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });

  it("关闭按钮触发 onClose，且用细线 SVG 而不是文本「×」", async () => {
    vi.mocked(fetchFileBlobText).mockResolvedValue("正文");
    const onClose = vi.fn();
    render(<FilePreviewModal file={file} onClose={onClose} />);
    await screen.findByText("正文");
    const close = screen.getByLabelText("关闭预览");
    expect(close.textContent).not.toContain("×");
    expect(close.querySelector("svg")).toBeTruthy();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MarkdownLite", () => {
  it("列表与围栏代码块渲染为 ul/pre", () => {
    render(<MarkdownLite text={"- 甲\n- 乙\n\n```\ncode()\n```"} />);
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("code()").tagName).toBe("PRE");
  });

  it("行内 code 与加粗拆成元素，其余文本节点", () => {
    render(<MarkdownLite text={"跑 `run()` 与 **冲**"} />);
    expect(screen.getByText("run()").tagName).toBe("CODE");
    expect(screen.getByText("冲").tagName).toBe("STRONG");
  });
});
