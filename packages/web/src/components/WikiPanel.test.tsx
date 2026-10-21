import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { WikiPanel } from "./WikiPanel.js";
import { createMemoryWikiBridge, renderPage, type WikiBridge } from "../lib/wiki/index.js";

/** 带初始文件的桥：测试里 seed 一些页面，避免每次点保存才造数据。 */
function seeded(): WikiBridge & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const bridge: WikiBridge & { files: Map<string, string> } = {
    files,
    async info() {
      return { root: "/tmp/test-wiki", exists: files.size > 0 };
    },
    async list() {
      return [...files.keys()].sort();
    },
    async read(rel) {
      return files.get(rel) ?? null;
    },
    async write(rel, content) {
      files.set(rel, content);
      return { path: rel, bytes: content.length };
    },
    async remove(rel) {
      return files.delete(rel);
    },
    async log(kind, title) {
      const day = new Date().toISOString().slice(0, 10);
      files.set("log.md", `${files.get("log.md") ?? ""}\n## [${day}] ${kind} | ${title}\n`);
      return true;
    },
  };
  files.set(
    "wiki/concepts/llm.md",
    renderPage({ title: "LLM", tags: ["ai"], body: "大语言模型。相关：[[和鸣]]" }),
  );
  files.set("wiki/entities/heming.md", renderPage({ title: "和鸣", body: "本项目。用了 [[LLM]]。" }));
  files.set("wiki/notes/lonely.md", renderPage({ title: "孤立", body: "谁都不链接我" }));
  return bridge;
}

describe("WikiPanel 三视图", () => {
  it("空库时提示怎么开始，且图谱视图有引导文案", async () => {
    const bridge = createMemoryWikiBridge();
    render(<WikiPanel bridge={bridge} />);
    expect(await screen.findByText(/还没有页面/)).toBeInTheDocument();
  });

  it("读出已有页面：数量与图谱边数都对", async () => {
    render(<WikiPanel bridge={seeded()} />);
    // 3 页；LLM→和鸣 与 和鸣→LLM 各一条边（双向链接是两个方向，都算）
    // 文案被 JSX 拆成多个文本节点，直接查容器全文最稳
    await waitFor(() => {
      expect(document.body.textContent).toContain("3 页 · 2 链接");
    });
  });

  it("「目录」视图列出全部页面并标出孤儿页链接数", async () => {
    render(<WikiPanel bridge={seeded()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "目录" }));
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("孤立")).toBeInTheDocument();
    // LLM 指向和鸣有 1 条出链 + 1 条入链 = degree 2
    expect(document.body.textContent).toContain("概念 · 2 链接");
    expect(document.body.textContent).toContain("笔记 · 0 链接");
  });

  it("目录检索按标题与正文过滤", async () => {
    render(<WikiPanel bridge={seeded()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "目录" }));
    fireEvent.change(screen.getByLabelText("检索知识库"), { target: { value: "大语言" } });
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.queryByText("和鸣")).not.toBeInTheDocument();
  });

  it("点目录条目进页面视图，能读到正文", async () => {
    render(<WikiPanel bridge={seeded()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "目录" }));
    fireEvent.click(await screen.findByText("LLM"));
    expect(await screen.findByLabelText("页面标题")).toHaveValue("LLM");
    // 正文已剥掉 frontmatter，只剩内容本身
    expect((screen.getByLabelText("页面正文") as HTMLTextAreaElement).value).toContain("大语言模型");
    expect((screen.getByLabelText("页面正文") as HTMLTextAreaElement).value).not.toContain("title:");
  });

  it("保存：写页面 + 同步 index.md + 追加 log.md", async () => {
    const bridge = seeded();
    render(<WikiPanel bridge={bridge} />);
    fireEvent.click(await screen.findByRole("tab", { name: "目录" }));
    fireEvent.click(screen.getByText("LLM"));
    fireEvent.click(await screen.findByLabelText("页面正文"));
    fireEvent.change(screen.getByLabelText("页面正文"), {
      target: { value: "大语言模型。相关：[[和鸣]]\n补充：多模态。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(bridge.files.get("wiki/concepts/LLM.md")).toContain("多模态"));
    expect(bridge.files.get("index.md")).toContain("[[LLM]]");
    expect(bridge.files.get("log.md")).toContain("] edit | LLM");
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
  });

  it("改标题会换文件名落盘（slug 化）", async () => {
    const bridge = seeded();
    render(<WikiPanel bridge={bridge} />);
    fireEvent.click(await screen.findByRole("tab", { name: "目录" }));
    fireEvent.click(screen.getByText("LLM"));
    fireEvent.change(await screen.findByLabelText("页面标题"), {
      target: { value: "大语言 模型?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      // 尾部 ? 被替换后又被去重连字符收掉，最终是 大语言-模型
      expect([...bridge.files.keys()]).toContain("wiki/concepts/大语言-模型.md"),
    );
  });

  it("「＋概念」新建空白页，保存后进列表", async () => {
    const bridge = seeded();
    render(<WikiPanel bridge={bridge} />);
    fireEvent.click(await screen.findByRole("button", { name: "＋概念" }));
    fireEvent.change(await screen.findByLabelText("页面标题"), { target: { value: "新概念" } });
    fireEvent.change(screen.getByLabelText("页面正文"), { target: { value: "内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(bridge.files.get("wiki/concepts/新概念.md")).toContain("内容"));
  });

  it("删除页面后从列表消失，并记一条 log", async () => {
    const bridge = seeded();
    render(<WikiPanel bridge={bridge} />);
    fireEvent.click(await screen.findByRole("tab", { name: "目录" }));
    fireEvent.click(screen.getByText("孤立"));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除页面" })).getByRole("button", {
        name: "删除",
      }),
    );
    await waitFor(() => expect(bridge.files.has("wiki/notes/lonely.md")).toBe(false));
    expect(bridge.files.get("log.md")).toContain("] delete |");
  });

  it("「规约」按钮写入 schema.md，已存在时不覆盖", async () => {
    const bridge = seeded();
    render(<WikiPanel bridge={bridge} />);
    fireEvent.click(await screen.findByRole("button", { name: "规约" }));
    await waitFor(() => expect(bridge.files.get("schema.md")).toContain("三层结构"));
    // 改成自定义内容后再点，不该被默认规约覆盖
    bridge.files.set("schema.md", "我自己的规约");
    fireEvent.click(screen.getByRole("button", { name: "规约" }));
    await waitFor(() => expect(bridge.files.get("schema.md")).toBe("我自己的规约"));
  });

  it("浏览器临时模式给出明确提示", async () => {
    // 不传 bridge → 走 resolveWikiBridge，jsdom 下无 preload 桥 → 临时模式
    render(<WikiPanel />);
    expect(await screen.findByText(/浏览器临时模式/)).toBeInTheDocument();
  });

  it("图谱视图渲染节点与图例，可拖动缩放控件", async () => {
    render(<WikiPanel bridge={seeded()} />);
    const graph = await screen.findByRole("application", { name: "知识库图谱，可缩放与拖动" });
    expect(graph).toBeInTheDocument();
    expect(screen.getByLabelText("放大图谱")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("放大图谱"));
    expect(screen.getByRole("button", { name: "复位图谱" })).toHaveTextContent("115%");
  });
});