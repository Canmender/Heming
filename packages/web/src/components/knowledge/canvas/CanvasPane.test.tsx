import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasPane } from "./CanvasPane.js";
import { findNode, parseCanvas, type CanvasDoc } from "./canvasModel.js";

/**
 * `CanvasPane` 的行为用例：验收点是「受控 + 不丢内容 + 不越权」。
 *
 * 断言尽量落在**回调产出的文本**上（parse 回来再比对），而不是内部 state：
 * 组件对外只承诺 onChange 的那一串字符，其它都是实现细节。
 */

function parseOk(text: string): CanvasDoc {
  const result = parseCanvas(text);
  if (!result.ok) throw new Error(`回写内容本应可解析：${result.error}`);
  return result.doc;
}

const DEMO_DOC = {
  nodes: [
    { id: "a", type: "text", text: "输入笔记", x: 0, y: 0, width: 200, height: 60 },
    { id: "b", type: "text", text: "建立索引", x: 300, y: 0, width: 200, height: 60 },
    { id: "c", type: "text", text: "参与召回", x: 600, y: 0, width: 200, height: 60 },
  ],
  edges: [
    { id: "e1", fromNode: "a", toNode: "b" },
    { id: "e2", fromNode: "b", toNode: "c" },
  ],
};
const DEMO_TEXT = JSON.stringify(DEMO_DOC, null, 2);

function getNode(container: HTMLElement, id: string): Element {
  const element = container.querySelector(`[data-node-id="${id}"]`);
  if (!element) throw new Error(`找不到节点 ${id}`);
  return element;
}

function getSvg(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("找不到 svg");
  return svg as SVGSVGElement;
}

describe("CanvasPane 渲染", () => {
  it("按文档渲染节点与连线数量、文本内容", () => {
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={vi.fn()} />);
    expect(container.querySelectorAll('[data-testid="canvas-node"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="canvas-edge"]')).toHaveLength(2);
    expect(container.textContent).toContain("输入笔记");
    expect(getNode(container, "a").getAttribute("data-selected")).toBe("false");
  });

  it("四种节点类型的展示：文本/文件/链接/分组", () => {
    const text = JSON.stringify({
      nodes: [
        { id: "t", type: "text", text: "文本内容", x: 0, y: 0, width: 200, height: 60 },
        { id: "f", type: "file", file: "目录/笔记.md", x: 300, y: 0, width: 200, height: 60 },
        { id: "l", type: "link", url: "https://example.com/x", x: 600, y: 0, width: 200, height: 60 },
        { id: "g", type: "group", label: "分组标题", x: 0, y: 200, width: 400, height: 200 },
      ],
      edges: [],
    });
    const { container } = render(<CanvasPane text={text} onChange={vi.fn()} />);
    expect(container.textContent).toContain("文本内容");
    expect(container.textContent).toContain("笔记.md");
    expect(container.textContent).toContain("https://example.com/x");
    expect(container.textContent).toContain("分组标题");
    expect(getNode(container, "g").getAttribute("data-node-type")).toBe("group");
    // 分组用虚线外框区分
    expect(getNode(container, "g").querySelector("rect")?.getAttribute("stroke-dasharray")).toBe("6 4");
  });

  it("未知字段经一次编辑后仍然保留（受控组件不吞数据）", () => {
    const text = JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "text",
          text: "甲",
          x: 0,
          y: 0,
          width: 200,
          height: 60,
          color: "4",
          "custom-flag": true,
        },
      ],
      edges: [],
      metadata: { version: 2 },
    });
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={text} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "新建文本节点" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = parseOk(onChange.mock.calls[0][0] as string);
    expect(next.nodes[0].__extra).toEqual({ "custom-flag": true });
    expect(next.nodes[0].color).toBe("4");
    expect(next.__extra).toEqual({ metadata: { version: 2 } });
    expect(container.querySelectorAll('[data-testid="canvas-node"]')).toHaveLength(1);
  });
});

describe("CanvasPane 坏 JSON", () => {
  it("显示中文错误与原文只读预览，且任何操作都不回写", () => {
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={"{坏掉的 json" } onChange={onChange} />);
    expect(screen.getByRole("alert")).toHaveTextContent("画布不是合法 JSON");
    expect(screen.getByLabelText("画布原文只读预览")).toHaveTextContent("{坏掉的 json");

    // 没有任何工具栏写操作按钮
    expect(screen.queryByRole("button", { name: "新建文本节点" })).toBeNull();
    fireEvent.keyDown(container.querySelector('[data-testid="canvas-pane"]') as HTMLElement, {
      key: "Delete",
    });
    fireEvent.doubleClick(container.querySelector('[data-testid="canvas-pane"]') as HTMLElement);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("空文本按非法内容处理", () => {
    render(<CanvasPane text="" onChange={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("画布内容为空");
  });
});

describe("CanvasPane 只读", () => {
  it("禁用新建与删除，双击不进入编辑，拖动不回写", () => {
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={onChange} readOnly />);
    expect(screen.getByRole("button", { name: "新建文本节点" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除选中" })).toBeDisabled();
    expect(container.querySelector('[data-testid="canvas-pane"]')).toHaveAttribute(
      "data-readonly",
      "true",
    );

    fireEvent.doubleClick(getNode(container, "a"));
    expect(screen.queryByLabelText("编辑文本节点")).toBeNull();

    fireEvent.pointerDown(getNode(container, "a"), { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(getSvg(container), { clientX: 200, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(getSvg(container), { clientX: 200, clientY: 120, pointerId: 1 });

    fireEvent.keyDown(getNode(container, "b"), { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("CanvasPane 编辑交互", () => {
  it("双击文本节点弹出 textarea，失焦后回写新文本", () => {
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={onChange} />);
    fireEvent.doubleClick(getNode(container, "a"));

    const textarea = screen.getByLabelText("编辑文本节点") as HTMLTextAreaElement;
    expect(textarea.value).toBe("输入笔记");
    fireEvent.change(textarea, { target: { value: "新的输入笔记" } });
    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = parseOk(onChange.mock.calls[0][0] as string);
    expect(findNode(next, "a")?.text).toBe("新的输入笔记");
    expect(next.nodes).toHaveLength(3);
    expect(next.edges).toHaveLength(2);
  });

  it("Esc 取消编辑不回写", () => {
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={onChange} />);
    fireEvent.doubleClick(getNode(container, "a"));
    const textarea = screen.getByLabelText("编辑文本节点");
    fireEvent.change(textarea, { target: { value: "临时改动" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByLabelText("编辑文本节点")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("键盘 Enter 打开编辑（键盘可达）", () => {
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={vi.fn()} />);
    fireEvent.keyDown(getNode(container, "b"), { key: "Enter" });
    expect((screen.getByLabelText("编辑文本节点") as HTMLTextAreaElement).value).toBe("建立索引");
  });

  it("工具栏新建文本节点：追加节点并回写", () => {
    const onChange = vi.fn();
    render(<CanvasPane text={DEMO_TEXT} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "新建文本节点" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = parseOk(onChange.mock.calls[0][0] as string);
    expect(next.nodes).toHaveLength(4);
    const added = next.nodes[3];
    expect(added.type).toBe("text");
    expect(added.id).toBe("n4");
    // 新节点落在原画布右侧，且吸附 20px 网格
    expect(added.x % 20).toBe(0);
    expect(added.y % 20).toBe(0);
    expect(added.x).toBeGreaterThan(600);
  });

  it("选中节点后按 Delete 删除，并连带删除相连的边", () => {
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={onChange} />);
    fireEvent.pointerDown(getNode(container, "b"), { clientX: 5, clientY: 5, pointerId: 7 });
    fireEvent.pointerUp(getSvg(container), { clientX: 5, clientY: 5, pointerId: 7 });
    expect(getNode(container, "b").getAttribute("data-selected")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(getNode(container, "b"), { key: "Delete" });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = parseOk(onChange.mock.calls[0][0] as string);
    expect(next.nodes.map((node) => node.id)).toEqual(["a", "c"]);
    expect(next.edges).toHaveLength(0);
  });

  it("拖动节点后按网格吸附回写新位置", () => {
    const onChange = vi.fn();
    const { container } = render(<CanvasPane text={DEMO_TEXT} onChange={onChange} />);
    fireEvent.pointerDown(getNode(container, "a"), { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerMove(getSvg(container), { clientX: 163, clientY: 147, pointerId: 3 });
    fireEvent.pointerUp(getSvg(container), { clientX: 163, clientY: 147, pointerId: 3 });

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    const moved = findNode(parseOk(last), "a");
    expect(moved?.x).toBe(60);
    expect(moved?.y).toBe(40);
    // 全部落在网格上
    expect((moved?.x ?? 0) % 20).toBe(0);
    expect((moved?.y ?? 0) % 20).toBe(0);
  });

  it("单击文件节点触发 onOpenLink", () => {
    const onOpenLink = vi.fn();
    const text = JSON.stringify({
      nodes: [{ id: "f", type: "file", file: "notes/甲.md", x: 0, y: 0, width: 200, height: 60 }],
      edges: [],
    });
    const { container } = render(
      <CanvasPane text={text} onChange={vi.fn()} onOpenLink={onOpenLink} />,
    );
    fireEvent.pointerDown(getNode(container, "f"), { clientX: 10, clientY: 10, pointerId: 9 });
    fireEvent.pointerUp(getSvg(container), { clientX: 10, clientY: 10, pointerId: 9 });
    expect(onOpenLink).toHaveBeenCalledWith("notes/甲.md");
  });

  it("link 节点只放行 http(s)", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const valid = JSON.stringify({
      nodes: [{ id: "l", type: "link", url: "https://example.com/a", x: 0, y: 0, width: 200, height: 60 }],
      edges: [],
    });
    const first = render(<CanvasPane text={valid} onChange={vi.fn()} />);
    fireEvent.doubleClick(getNode(first.container, "l"));
    expect(openSpy).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");

    openSpy.mockClear();
    first.unmount();
    const unsafe = JSON.stringify({
      nodes: [{ id: "l", type: "link", url: "javascript:alert(1)", x: 0, y: 0, width: 200, height: 60 }],
      edges: [],
    });
    const second = render(<CanvasPane text={unsafe} onChange={vi.fn()} />);
    fireEvent.doubleClick(getNode(second.container, "l"));
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("图片文件节点通过 resolveAsset 异步加载", async () => {
    const resolveAsset = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const text = JSON.stringify({
      nodes: [{ id: "img", type: "file", file: "附件/图.png", x: 0, y: 0, width: 200, height: 120 }],
      edges: [],
    });
    const { container } = render(
      <CanvasPane text={text} onChange={vi.fn()} resolveAsset={resolveAsset} />,
    );
    await waitFor(() => expect(container.querySelector("image")).not.toBeNull());
    expect(resolveAsset).toHaveBeenCalledWith("附件/图.png");
    expect(container.querySelector("image")?.getAttribute("href")).toBe(
      "data:image/png;base64,AAAA",
    );
  });
});
