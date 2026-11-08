import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorPane, type EditorHandle, type EditorHostOptions, type EditorLoader } from "./EditorPane.js";

/**
 * 假编辑器加载器：jsdom 里不加载真的 CodeMirror，只记录挂载参数、暴露句柄，
 * 用例据此断言「DOM 存在 + 回调接线」，不测像素（与任务口径一致）。
 */
function fakeEditor(initialDoc = "") {
  let options: EditorHostOptions | null = null;
  let doc = initialDoc;
  const handle: EditorHandle = {
    getValue: vi.fn(() => doc),
    setValue: vi.fn((next: string) => {
      doc = next;
    }),
    focus: vi.fn(),
    destroy: vi.fn(),
  };
  const loader: EditorLoader = vi.fn(async (_host: HTMLElement, opts: EditorHostOptions) => {
    options = opts;
    doc = opts.doc;
    return handle;
  });
  return {
    loader,
    handle,
    /** 用例里模拟「用户在编辑器里打字」。 */
    type(next: string) {
      doc = next;
      act(() => options?.onDocChange(next));
    },
    /** 模拟编辑器里按 Ctrl+S（CodeMirror keymap 路径）。 */
    triggerSave() {
      act(() => options?.onSave());
    },
    get options() {
      return options;
    },
  };
}

describe("知识库编辑器面板", () => {
  it("source 模式：渲染 CodeMirror 宿主与状态条，加载器拿到初始正文", async () => {
    const fake = fakeEditor("初始正文");
    render(
      <EditorPane rel="notes/a.md" text="初始正文" mode="source" dirty={false} loader={fake.loader} />,
    );
    await waitFor(() => expect(fake.loader).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("vault-editor-host")).toBeInTheDocument();
    expect(fake.options?.doc).toBe("初始正文");
    expect(screen.getByText("已保存")).toBeInTheDocument();
    // source 模式不渲染预览
    expect(screen.queryByTestId("vault-preview-pane")).not.toBeInTheDocument();
  });

  it("脏标记：dirty 时状态条提示有未保存修改", async () => {
    const fake = fakeEditor();
    render(<EditorPane rel="a.md" text="" mode="source" dirty loader={fake.loader} />);
    await waitFor(() => expect(fake.loader).toHaveBeenCalled());
    expect(screen.getByText("有未保存的修改")).toBeInTheDocument();
  });

  it("用户输入回调 onChange；Ctrl/⌘+S 回调 onSave", async () => {
    const fake = fakeEditor("a");
    const onChange = vi.fn();
    const onSave = vi.fn();
    render(
      <EditorPane
        rel="a.md"
        text="a"
        mode="source"
        dirty
        onChange={onChange}
        onSave={onSave}
        loader={fake.loader}
      />,
    );
    await waitFor(() => expect(fake.loader).toHaveBeenCalled());

    fake.type("a 新增");
    expect(onChange).toHaveBeenCalledWith("a 新增");

    fireEvent.keyDown(screen.getByTestId("editor-pane"), { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);

    // Meta+S（mac）同样生效
    fireEvent.keyDown(screen.getByTestId("editor-pane"), { key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("工具栏保存按钮：dirty 时可点，保存中禁用", async () => {
    const fake = fakeEditor();
    const onSave = vi.fn();
    const { rerender } = render(
      <EditorPane rel="a.md" text="" mode="source" dirty onSave={onSave} loader={fake.loader} />,
    );
    await waitFor(() => expect(fake.loader).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "保存当前笔记" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    rerender(
      <EditorPane rel="a.md" text="" mode="source" dirty saving onSave={onSave} loader={fake.loader} />,
    );
    expect(screen.getByText("保存中…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存当前笔记" })).toBeDisabled();
  });

  it("外部正文变化同步进编辑器（watch 改了文件）", async () => {
    const fake = fakeEditor("旧");
    const { rerender } = render(
      <EditorPane rel="a.md" text="旧" mode="source" dirty={false} loader={fake.loader} />,
    );
    await waitFor(() => expect(fake.loader).toHaveBeenCalled());
    rerender(<EditorPane rel="a.md" text="新" mode="source" dirty={false} loader={fake.loader} />);
    await waitFor(() => expect(fake.handle.setValue).toHaveBeenCalledWith("新"));
  });

  it("read 模式：不挂编辑器，只渲染预览", async () => {
    const fake = fakeEditor();
    render(
      <EditorPane
        rel="a.md"
        text="正文"
        mode="read"
        dirty={false}
        loader={fake.loader}
        renderPreview={() => <p>预览内容</p>}
      />,
    );
    expect(screen.queryByTestId("vault-editor-host")).not.toBeInTheDocument();
    expect(screen.getByText("预览内容")).toBeInTheDocument();
    expect(fake.loader).not.toHaveBeenCalled();
  });

  it("split 模式：左编辑器 + 右预览同时在", async () => {
    const fake = fakeEditor();
    render(
      <EditorPane
        rel="a.md"
        text="正文"
        mode="split"
        dirty={false}
        loader={fake.loader}
        renderPreview={() => <p>预览内容</p>}
      />,
    );
    await waitFor(() => expect(fake.loader).toHaveBeenCalled());
    expect(screen.getByTestId("vault-editor-host")).toBeInTheDocument();
    expect(screen.getByTestId("vault-preview-pane")).toHaveTextContent("预览内容");
  });

  it("切换文件会销毁旧编辑器、按新正文重建", async () => {
    const first = fakeEditor("一");
    const { rerender } = render(
      <EditorPane rel="a.md" text="一" mode="source" dirty={false} loader={first.loader} />,
    );
    await waitFor(() => expect(first.loader).toHaveBeenCalled());
    rerender(<EditorPane rel="b.md" text="二" mode="source" dirty={false} loader={first.loader} />);
    await waitFor(() => expect(first.handle.destroy).toHaveBeenCalled());
    await waitFor(() => expect(first.loader).toHaveBeenCalledTimes(2));
    expect(first.options?.doc).toBe("二");
  });

  it("保存失败的错误提示直接显示（不自己编文案）", () => {
    render(
      <EditorPane
        rel="a.md"
        text=""
        mode="source"
        dirty
        error="文件已被外部修改，请先对比再保存"
        loader={fakeEditor().loader}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("文件已被外部修改，请先对比再保存");
  });

  it("编辑器加载失败时给出可读提示，不白屏", async () => {
    const loader: EditorLoader = vi.fn(async () => {
      throw new Error("chunk 下载失败");
    });
    render(<EditorPane rel="a.md" text="正文" mode="source" dirty={false} loader={loader} />);
    await waitFor(() =>
      expect(screen.getByText(/编辑器加载失败：chunk 下载失败/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId("vault-editor-host")).toBeInTheDocument();
  });
});
