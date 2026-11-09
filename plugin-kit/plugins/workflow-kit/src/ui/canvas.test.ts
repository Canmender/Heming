// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工作流画布（public/canvas.js）的交互测试。
 *
 * 为什么要从 public/ 读源码再执行：canvas.js 是「经典脚本」（无 ESM 导出、无构建），
 * 页面里靠 `<script>` 直接挂 window.WFCanvas；测试里把它包成函数注入 window/document，
 * 等价于浏览器加载一次脚本，又不必依赖 jsdom 的脚本执行开关。
 *
 * 覆盖：渲染/aria、点选、多选拖动（画布坐标 + 网格吸附）、端口拖线（最近输入口）、
 * Delete/Backspace、双击空白/节点、Enter 打开、缩放/滚轮锚点/夹紧、适配视图、
 * 平移（中键/空格）、框选、运行态与禁用/pinData、readOnly、SVG 连线与箭头。
 */

// 测试由 `pnpm test` 在项目根目录启动，公开脚本固定在 <root>/public/canvas.js。
// 不用 import.meta.url：vitest 的 jsdom 环境下它不是 file: 协议，fileURLToPath 会抛错。
const CANVAS_SOURCE = readFileSync(resolve(process.cwd(), "public/canvas.js"), "utf8");

interface CanvasInstance {
  setWorkflow(workflow: unknown): CanvasInstance;
  setSelected(ids: string[]): CanvasInstance;
  setRunState(map: Record<string, unknown>): CanvasInstance;
  setReadOnly(readOnly: boolean): CanvasInstance;
  fit(): CanvasInstance;
  zoomBy(factor: number): CanvasInstance;
  getViewport(): { x: number; y: number; zoom: number };
  destroy(): void;
}

interface WFCanvasGlobal {
  mount(container: HTMLElement, callbacks?: Record<string, unknown>): CanvasInstance;
}

type Spy = ReturnType<typeof vi.fn>;

interface Spies {
  onSelect: Spy;
  onMoveNodes: Spy;
  onConnect: Spy;
  onRequestDelete: Spy;
  onOpenNode: Spy;
  onRequestAddNode: Spy;
}

interface Mounted {
  container: HTMLElement;
  instance: CanvasInstance;
  spies: Spies;
}

let mounted: CanvasInstance[] = [];

beforeAll(() => {
  // 经典脚本只会引用 window/document 这两个全局；其余（Math/Infinity 等）用 JS 自带。
  const load = new Function("window", "document", CANVAS_SOURCE);
  load(window, document);
});

beforeEach(() => {
  document.body.innerHTML = "";
  mounted = [];
});

afterEach(() => {
  for (const instance of mounted) instance.destroy();
  mounted = [];
  document.body.innerHTML = "";
});

function getWfCanvas(): WFCanvasGlobal {
  return (window as unknown as { WFCanvas: WFCanvasGlobal }).WFCanvas;
}

function makeNode(
  id: string,
  name: string,
  x: number,
  y: number,
  type = "set",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, name, type, position: { x, y }, parameters: {}, ...extra };
}

function makeWorkflow(
  nodes: Array<Record<string, unknown>>,
  connections: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "wf-test",
    name: "测试工作流",
    nodes,
    connections,
    settings: {},
    active: false,
    versionId: "ver-1",
    createdAt: 0,
    updatedAt: 0,
  };
}

function mountCanvas(workflow?: unknown): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const spies: Spies = {
    onSelect: vi.fn(),
    onMoveNodes: vi.fn(),
    onConnect: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenNode: vi.fn(),
    onRequestAddNode: vi.fn(),
  };
  const instance = getWfCanvas().mount(container, spies as unknown as Record<string, unknown>);
  mounted.push(instance);
  if (workflow !== undefined) instance.setWorkflow(workflow);
  return { container, instance, spies };
}

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".wf-canvas");
  if (!root) throw new Error("画布根节点没有挂载");
  return root;
}

function nodeCard(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`.wf-node[data-node-id="${id}"]`);
}

function fireMouse(target: EventTarget, type: string, init: MouseEventInit = {}): void {
  // 不传 view：vitest 的 jsdom 里 window 是代理对象，jsdom 会因「view 不是 Window」直接抛错；
  // 画布代码也只用 clientX/clientY/button，不需要 event.view。
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function fireWheel(target: EventTarget, init: WheelEventInit = {}): void {
  target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
}

function fireKey(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

function fireKeyUp(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(
    new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...init }),
  );
}

describe("WFCanvas 渲染与可访问性", () => {
  it("挂载出带 aria 的画布、渲染节点卡片与空态切换", () => {
    const { container, instance } = mountCanvas();
    const root = rootOf(container);
    expect(root.getAttribute("role")).toBe("application");
    expect(root.getAttribute("aria-label")).toBe("工作流画布");
    expect(root.getAttribute("tabindex")).toBe("0");

    const empty = container.querySelector<HTMLElement>(".wf-canvas__empty");
    expect(empty).not.toBeNull();
    expect(empty?.hidden).toBe(false);

    instance.setWorkflow(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );

    expect(container.querySelectorAll(".wf-node").length).toBe(2);
    expect(empty?.hidden).toBe(true);
    const card = nodeCard(container, "a");
    expect(card?.getAttribute("role")).toBe("button");
    expect(card?.getAttribute("tabindex")).toBe("0");
    expect(card?.getAttribute("aria-label")).toBe("节点 节点 A");
    expect(card?.getAttribute("data-run-state")).toBe("idle");
    expect(card?.style.left).toBe("100px");
    expect(card?.style.top).toBe("100px");
  });

  it("渲染 SVG 贝塞尔连线与箭头，并按选中态强调", () => {
    const { container, instance } = mountCanvas();
    instance.setWorkflow(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)], {
        a: { main: [[{ node: "b", type: "main", index: 0 }]] },
      }),
    );
    const edge = container.querySelector<SVGPathElement>(".wf-edge");
    expect(edge).not.toBeNull();
    expect(edge?.getAttribute("d")).toContain("C");
    expect(edge?.getAttribute("marker-end")).toContain("url(#");
    expect(edge?.getAttribute("data-edge-source")).toBe("a");
    expect(edge?.getAttribute("data-edge-target")).toBe("b");

    instance.setSelected(["a"]);
    const emphasized = container.querySelector<SVGPathElement>(".wf-edge");
    expect(emphasized?.getAttribute("stroke")).toBe("#1a1a1a");
  });
});

describe("WFCanvas 选择与拖动", () => {
  it("点选节点回调 onSelect，Shift 追加多选", () => {
    const { container, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    const cardA = nodeCard(container, "a");
    if (!cardA) throw new Error("缺少节点 a");
    fireMouse(cardA, "mousedown", { button: 0, clientX: 120, clientY: 120 });
    fireMouse(window, "mouseup", { clientX: 120, clientY: 120 });
    expect(spies.onSelect).toHaveBeenCalledWith(["a"]);

    const cardB = nodeCard(container, "b");
    if (!cardB) throw new Error("缺少节点 b");
    fireMouse(cardB, "mousedown", {
      button: 0,
      clientX: 420,
      clientY: 260,
      shiftKey: true,
    });
    fireMouse(window, "mouseup", { clientX: 420, clientY: 260 });
    expect(spies.onSelect).toHaveBeenLastCalledWith(["a", "b"]);
    expect(cardB.classList.contains("wf-node--selected")).toBe(true);
    expect(cardA.classList.contains("wf-node--selected")).toBe(true);
    // 没有位移就不该有移动回调
    expect(spies.onMoveNodes).not.toHaveBeenCalled();
  });

  it("拖动节点松手只回调一次 onMoveNodes（画布坐标 + 20 网格吸附）", () => {
    const { container, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    const cardA = nodeCard(container, "a");
    if (!cardA) throw new Error("缺少节点 a");
    fireMouse(cardA, "mousedown", { button: 0, clientX: 120, clientY: 120 });
    fireMouse(window, "mousemove", { clientX: 160, clientY: 160 });
    // 拖动过程中不回调，只有松手时一次性提交，避免页面壳每次都写草稿
    expect(spies.onMoveNodes).not.toHaveBeenCalled();
    fireMouse(window, "mouseup", { clientX: 160, clientY: 160 });
    expect(spies.onMoveNodes).toHaveBeenCalledTimes(1);
    expect(spies.onMoveNodes).toHaveBeenCalledWith([
      { id: "a", position: { x: 140, y: 140 } },
    ]);
    expect(cardA.style.left).toBe("140px");
    expect(cardA.style.top).toBe("140px");
  });

  it("多选后拖动任一选中节点会一起移动", () => {
    const { container, instance, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    instance.setSelected(["a", "b"]);
    const cardA = nodeCard(container, "a");
    if (!cardA) throw new Error("缺少节点 a");
    fireMouse(cardA, "mousedown", { button: 0, clientX: 120, clientY: 120 });
    fireMouse(window, "mousemove", { clientX: 140, clientY: 140 });
    fireMouse(window, "mouseup", { clientX: 140, clientY: 140 });
    expect(spies.onMoveNodes).toHaveBeenCalledWith([
      { id: "a", position: { x: 120, y: 120 } },
      { id: "b", position: { x: 420, y: 260 } },
    ]);
  });
});

describe("WFCanvas 端口拖线与删除", () => {
  it("从输出口拖到目标节点时高亮并回调最近输入口", () => {
    const { container, spies } = mountCanvas(
      makeWorkflow([
        makeNode("a", "节点 A", 100, 100),
        makeNode("b", "合并", 400, 240, "merge"),
      ]),
    );
    const output = container.querySelector<HTMLElement>(
      '.wf-node__port[data-node-id="a"][data-port-kind="output"][data-port-index="0"]',
    );
    if (!output) throw new Error("缺少输出端口");
    fireMouse(output, "mousedown", { button: 0, clientX: 308, clientY: 138 });
    fireMouse(window, "mousemove", { clientX: 400, clientY: 289 });

    expect(container.querySelectorAll(".wf-edge--temp").length).toBe(1);
    const active = container.querySelectorAll(".wf-node__port--active");
    expect(active.length).toBe(1);
    expect(active[0].getAttribute("data-port-index")).toBe("1");

    fireMouse(window, "mouseup", { clientX: 400, clientY: 289 });
    expect(spies.onConnect).toHaveBeenCalledWith({
      sourceId: "a",
      sourceOutput: 0,
      targetId: "b",
      targetInput: 1,
    });
    expect(container.querySelectorAll(".wf-edge--temp").length).toBe(0);
  });

  it("取消拖线（松手在空白处）不回调 onConnect", () => {
    const { container, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    const output = container.querySelector<HTMLElement>(
      '.wf-node__port[data-node-id="a"][data-port-kind="output"]',
    );
    if (!output) throw new Error("缺少输出端口");
    fireMouse(output, "mousedown", { button: 0, clientX: 308, clientY: 138 });
    fireMouse(window, "mousemove", { clientX: 700, clientY: 500 });
    fireMouse(window, "mouseup", { clientX: 700, clientY: 500 });
    expect(spies.onConnect).not.toHaveBeenCalled();
  });

  it("Delete 与 Backspace 删除选中节点（一次性回调全部 id）", () => {
    const { container, instance, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    instance.setSelected(["a", "b"]);
    const root = rootOf(container);
    fireKey(root, { key: "Delete" });
    expect(spies.onRequestDelete).toHaveBeenCalledWith(["a", "b"]);
    fireKey(root, { key: "Backspace" });
    expect(spies.onRequestDelete).toHaveBeenCalledTimes(2);
  });
});

describe("WFCanvas 双击与键盘", () => {
  it("双击空白按画布坐标回调 onRequestAddNode，双击节点回调 onOpenNode", () => {
    const { container, spies } = mountCanvas(makeWorkflow([makeNode("a", "节点 A", 100, 100)]));
    const root = rootOf(container);
    root.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }),
    );
    expect(spies.onRequestAddNode).toHaveBeenCalledWith({ x: 300, y: 200 });

    const card = nodeCard(container, "a");
    if (!card) throw new Error("缺少节点 a");
    card.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }),
    );
    expect(spies.onOpenNode).toHaveBeenCalledWith("a");
  });

  it("节点聚焦后按 Enter 打开节点", () => {
    const { container, spies } = mountCanvas(makeWorkflow([makeNode("a", "节点 A", 100, 100)]));
    const card = nodeCard(container, "a");
    if (!card) throw new Error("缺少节点 a");
    fireKey(card, { key: "Enter" });
    expect(spies.onOpenNode).toHaveBeenCalledWith("a");
  });
});

describe("WFCanvas 缩放、平移与框选", () => {
  it("工具条缩放与滚轮锚点缩放改变视口，并夹紧在 0.2–2", () => {
    const { container, instance } = mountCanvas(makeWorkflow([makeNode("a", "节点 A", 100, 100)]));
    const root = rootOf(container);
    const zoomIn = container.querySelector<HTMLElement>('[aria-label="放大"]');
    if (!zoomIn) throw new Error("缺少放大按钮");
    zoomIn.click();
    expect(instance.getViewport().zoom).toBeCloseTo(1.2, 5);

    const before = instance.getViewport();
    const anchor = { x: 300, y: 200 };
    const canvasBefore = {
      x: (anchor.x - before.x) / before.zoom,
      y: (anchor.y - before.y) / before.zoom,
    };
    fireWheel(root, { deltaY: -120, clientX: anchor.x, clientY: anchor.y });
    const after = instance.getViewport();
    expect(after.zoom).toBeGreaterThan(before.zoom);
    // 以光标为中心：光标下的画布坐标在缩放前后不变
    expect((anchor.x - after.x) / after.zoom).toBeCloseTo(canvasBefore.x, 5);
    expect((anchor.y - after.y) / after.zoom).toBeCloseTo(canvasBefore.y, 5);

    instance.zoomBy(100);
    expect(instance.getViewport().zoom).toBe(2);
    instance.zoomBy(0.0001);
    expect(instance.getViewport().zoom).toBe(0.2);
  });

  it("适配视图把内容居中（800×600 兜底尺寸下计算可预期）", () => {
    const { container, instance } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    const fitButton = container.querySelector<HTMLElement>('[aria-label="适配视图"]');
    if (!fitButton) throw new Error("缺少适配按钮");
    fitButton.click();
    const viewport = instance.getViewport();
    // 内容包围盒 508×216，可视 800×600 减去两侧 80 padding → 640/508
    expect(viewport.zoom).toBeCloseTo(640 / 508, 4);
    const centerX = (100 + 608) / 2;
    const centerY = (100 + 316) / 2;
    expect(centerX * viewport.zoom + viewport.x).toBeCloseTo(400, 3);
    expect(centerY * viewport.zoom + viewport.y).toBeCloseTo(300, 3);
  });

  it("中键拖与空格 + 左键拖都平移视口", () => {
    const { container, instance } = mountCanvas(makeWorkflow([makeNode("a", "节点 A", 100, 100)]));
    const root = rootOf(container);

    fireMouse(root, "mousedown", { button: 1, clientX: 100, clientY: 100 });
    fireMouse(window, "mousemove", { clientX: 150, clientY: 130 });
    fireMouse(window, "mouseup", { clientX: 150, clientY: 130 });
    expect(instance.getViewport()).toMatchObject({ x: 50, y: 30 });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space" }));
    fireMouse(root, "mousedown", { button: 0, clientX: 200, clientY: 200 });
    fireMouse(window, "mousemove", { clientX: 220, clientY: 210 });
    fireMouse(window, "mouseup", { clientX: 220, clientY: 210 });
    fireKeyUp(window, { key: " ", code: "Space" });
    expect(instance.getViewport()).toMatchObject({ x: 70, y: 40 });
  });

  it("空白拖出选框只选中相交的节点", () => {
    const { container, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100), makeNode("b", "节点 B", 400, 240)]),
    );
    const root = rootOf(container);
    fireMouse(root, "mousedown", { button: 0, clientX: 50, clientY: 50 });
    fireMouse(window, "mousemove", { clientX: 350, clientY: 220 });
    const box = container.querySelector<HTMLElement>(".wf-canvas__box");
    expect(box?.hidden).toBe(false);
    fireMouse(window, "mouseup", { clientX: 350, clientY: 220 });
    expect(box?.hidden).toBe(true);
    expect(spies.onSelect).toHaveBeenLastCalledWith(["a"]);
  });
});

describe("WFCanvas 状态与 readOnly", () => {
  it("运行态描边、items 数、禁用灰显与 pinData 标记", () => {
    const { container, instance } = mountCanvas(
      makeWorkflow([
        makeNode("a", "节点 A", 100, 100, "set", { pinData: [{ json: { id: 1 } }] }),
        makeNode("b", "节点 B", 400, 240, "set", { disabled: true }),
      ]),
    );
    instance.setRunState({ a: { state: "running", itemCount: 5 }, b: "error" });

    const cardA = nodeCard(container, "a");
    const cardB = nodeCard(container, "b");
    expect(cardA?.getAttribute("data-run-state")).toBe("running");
    expect(cardA?.querySelector(".wf-node__items")?.textContent).toBe("5 项");
    expect(cardA?.querySelector(".wf-node__pin")).not.toBeNull();
    expect(cardA?.classList.contains("wf-node--selected")).toBe(false);

    expect(cardB?.getAttribute("data-run-state")).toBe("error");
    expect(cardB?.classList.contains("wf-node--disabled")).toBe(true);
    expect(cardB?.getAttribute("aria-disabled")).toBe("true");
    expect(cardB?.querySelector(".wf-node__pin")).toBeNull();
  });

  it("readOnly 下禁止拖动/删除/加节点，但仍可选中", () => {
    const { container, instance, spies } = mountCanvas(
      makeWorkflow([makeNode("a", "节点 A", 100, 100)]),
    );
    instance.setReadOnly(true);
    const root = rootOf(container);
    const cardA = nodeCard(container, "a");
    if (!cardA) throw new Error("缺少节点 a");

    fireMouse(cardA, "mousedown", { button: 0, clientX: 120, clientY: 120 });
    fireMouse(window, "mousemove", { clientX: 160, clientY: 160 });
    fireMouse(window, "mouseup", { clientX: 160, clientY: 160 });
    expect(spies.onMoveNodes).not.toHaveBeenCalled();
    expect(spies.onSelect).toHaveBeenCalledWith(["a"]);

    fireKey(root, { key: "Delete" });
    expect(spies.onRequestDelete).not.toHaveBeenCalled();

    root.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }),
    );
    expect(spies.onRequestAddNode).not.toHaveBeenCalled();
  });
});
