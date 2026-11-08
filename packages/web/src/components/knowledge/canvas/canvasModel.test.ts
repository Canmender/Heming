import { describe, expect, it } from "vitest";
import {
  addEdge,
  addFileNode,
  addTextNode,
  canvasBounds,
  createEdgeId,
  createNodeId,
  defaultSides,
  edgeGeometry,
  emptyCanvas,
  findEdge,
  findNode,
  isVaultRelPath,
  moveNode,
  nodeAnchor,
  parseCanvas,
  removeEdge,
  removeNode,
  serializeCanvas,
  snapToGrid,
  updateNode,
  type CanvasDoc,
} from "./canvasModel.js";

/** 解析成功断言：失败时把中文原因吐出来，别让用例变成一句 "expected true"。 */
function parseOk(text: string): CanvasDoc {
  const result = parseCanvas(text);
  if (!result.ok) throw new Error(`本应解析成功：${result.error}`);
  return result.doc;
}

function parseError(text: string): string {
  const result = parseCanvas(text);
  if (result.ok) throw new Error("本应解析失败，却成功了");
  return result.error;
}

/** 真实夹具：`.tmp/demo-vault/画布/流程.canvas` 的内容（不读磁盘，保证测试自洽）。 */
const DEMO_CANVAS = `{
  "nodes": [
    { "id": "a", "type": "text", "text": "输入笔记", "x": 0, "y": 0, "width": 200, "height": 60 },
    { "id": "b", "type": "text", "text": "建立索引", "x": 300, "y": 0, "width": 200, "height": 60 },
    { "id": "c", "type": "text", "text": "参与召回", "x": 600, "y": 0, "width": 200, "height": 60 }
  ],
  "edges": [
    { "id": "e1", "fromNode": "a", "toNode": "b" },
    { "id": "e2", "fromNode": "b", "toNode": "c" }
  ]
}`;

/** 含未知字段、颜色与边侧的前向兼容夹具。 */
const FORWARD_COMPAT_CANVAS = JSON.stringify(
  {
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
        zIndex: 3,
      },
      { id: "f", type: "file", file: "notes/b.md", x: 300, y: 0, width: 200, height: 60 },
    ],
    edges: [
      {
        id: "e1",
        fromNode: "a",
        fromSide: "right",
        toNode: "f",
        toSide: "left",
        color: "2",
        "line-style": "dashed",
      },
    ],
    metadata: { version: 2 },
  },
  null,
  2,
);

describe("parseCanvas 解析", () => {
  it("解析演示画布：3 个节点 2 条边，边侧缺省时保持缺省", () => {
    const doc = parseOk(DEMO_CANVAS);
    expect(doc.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(doc.nodes[0].text).toBe("输入笔记");
    expect(doc.edges.map((edge) => edge.id)).toEqual(["e1", "e2"]);
    expect(doc.edges[0].fromSide).toBeUndefined();
    expect(doc.edges[0].toSide).toBeUndefined();
    expect(doc.__extra).toBeUndefined();
  });

  it("保留未知字段、颜色与 fromSide/toSide", () => {
    const doc = parseOk(FORWARD_COMPAT_CANVAS);
    expect(doc.nodes[0].color).toBe("4");
    expect(doc.nodes[0].__extra).toEqual({ "custom-flag": true, zIndex: 3 });
    expect(doc.edges[0].fromSide).toBe("right");
    expect(doc.edges[0].toSide).toBe("left");
    expect(doc.edges[0].color).toBe("2");
    expect(doc.edges[0].__extra).toEqual({ "line-style": "dashed" });
    expect(doc.__extra).toEqual({ metadata: { version: 2 } });
  });

  it("坐标与尺寸夹取：±100 万、宽高 20–5000", () => {
    const doc = parseOk(
      JSON.stringify({
        nodes: [{ id: "a", type: "text", x: 5_000_000, y: -5_000_000, width: 1, height: 99_999 }],
        edges: [],
      }),
    );
    expect(doc.nodes[0]).toMatchObject({ x: 1_000_000, y: -1_000_000, width: 20, height: 5000 });
  });

  it("宽高缺失时补默认值（不报错）", () => {
    const doc = parseOk(JSON.stringify({ nodes: [{ id: "a", type: "text", x: 0, y: 0 }], edges: [] }));
    expect(doc.nodes[0]).toMatchObject({ width: 200, height: 60 });
    expect(doc.nodes[0].text).toBeUndefined();
  });

  it("节点与边去重：重复 id、重复连接各保留先出现的一条", () => {
    const doc = parseOk(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", text: "第一", x: 0, y: 0 },
          { id: "a", type: "text", text: "重复", x: 0, y: 0 },
          { id: "b", type: "text", x: 200, y: 0 },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e1", fromNode: "b", toNode: "a" },
          { id: "e2", fromNode: "a", toNode: "b" },
        ],
      }),
    );
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[0].text).toBe("第一");
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0].id).toBe("e1");
  });

  it("指向不存在节点的边保留（不静默删数据）", () => {
    const doc = parseOk(
      JSON.stringify({
        nodes: [{ id: "a", type: "text", x: 0, y: 0 }],
        edges: [{ id: "e1", fromNode: "a", toNode: "ghost" }],
      }),
    );
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0].toNode).toBe("ghost");
  });

  it("边侧取值未知时原样保留", () => {
    const doc = parseOk(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0 },
          { id: "b", type: "text", x: 200, y: 0 },
        ],
        edges: [{ id: "e1", fromNode: "a", fromSide: "middle", toNode: "b", toSide: "top-left" }],
      }),
    );
    expect(doc.edges[0].fromSide).toBe("middle");
    expect(doc.edges[0].toSide).toBe("top-left");
  });
});

describe("parseCanvas 非法输入", () => {
  it.each([
    ["", "画布内容为空，无法解析。"],
    ["{oops", "画布不是合法 JSON"],
    ["[]", "画布根节点必须是对象"],
    ['"字符串"', "画布根节点必须是对象"],
    ['{"nodes":[]}', "画布缺少 edges 数组"],
    ['{"edges":[]}', "画布缺少 nodes 数组"],
    ['{"nodes":[{"type":"text","x":0,"y":0}],"edges":[]}', "缺少 id"],
    ['{"nodes":[{"id":"a","type":"text","y":0}],"edges":[]}', "缺少有效坐标"],
    ['{"nodes":[{"id":"a","type":"image","x":0,"y":0}],"edges":[]}', "不受支持"],
    ['{"nodes":[{"id":"a","type":"text","x":0,"y":0}],"edges":[{"id":"e1"}]}', "缺少 fromNode"],
    ['{"nodes":[],"edges":[{"fromNode":"a","toNode":"b"}]}', "缺少 id"],
  ])("拒绝 %j 并给出中文原因", (text, fragment) => {
    const error = parseError(text);
    expect(error).toContain(fragment);
  });
});

describe("serializeCanvas 序列化", () => {
  it("键序稳定、2 空格缩进、末尾换行", () => {
    const out = serializeCanvas(parseOk(FORWARD_COMPAT_CANVAS));
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('\n  "nodes": [');
    const raw = JSON.parse(out) as { nodes: Array<Record<string, unknown>> };
    expect(Object.keys(raw.nodes[0]).slice(0, 7)).toEqual([
      "id",
      "type",
      "x",
      "y",
      "width",
      "height",
      "text",
    ]);
    expect(Object.keys(raw.nodes[0])).toContain("custom-flag");
  });

  it("往返保真：未知字段、颜色、边侧解析后等价，二次序列化逐字节一致", () => {
    const first = parseOk(FORWARD_COMPAT_CANVAS);
    const out = serializeCanvas(first);
    expect(out).toContain('"custom-flag": true');
    expect(out).toContain('"line-style": "dashed"');
    expect(out).toContain('"fromSide": "right"');
    expect(out).toContain('"toSide": "left"');
    expect(out).toContain('"metadata"');
    expect(out).not.toContain("__extra");

    const second = parseOk(out);
    expect(second).toEqual(first);
    expect(serializeCanvas(second)).toBe(out);
  });

  it("演示画布往返后等价（边侧缺省不被凭空补值）", () => {
    const first = parseOk(DEMO_CANVAS);
    const out = serializeCanvas(first);
    expect(out).not.toContain("fromSide");
    expect(parseOk(out)).toEqual(first);
  });

  it("空画布序列化", () => {
    expect(serializeCanvas(emptyCanvas())).toBe('{\n  "nodes": [],\n  "edges": []\n}\n');
  });

  it("__extra 按字典序输出（同样文档永远同样字符串）", () => {
    const doc = parseOk(
      JSON.stringify({ nodes: [], edges: [], zeta: 1, alpha: 2, middle: { a: 1 } }),
    );
    const raw = JSON.parse(serializeCanvas(doc)) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["nodes", "edges", "alpha", "middle", "zeta"]);
  });
});

describe("编辑操作（纯函数）", () => {
  function twoNodes(): CanvasDoc {
    let doc = addTextNode(emptyCanvas(), { id: "a", x: 0, y: 0, text: "甲" });
    doc = addTextNode(doc, { id: "b", x: 300, y: 0, text: "乙" });
    return doc;
  }

  it("addTextNode 返回新文档且不改入参", () => {
    const doc = emptyCanvas();
    const snapshot = JSON.stringify(doc);
    const next = addTextNode(doc, { x: 33, y: 47, text: "新节点" });
    expect(doc.nodes).toHaveLength(0);
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]).toMatchObject({ type: "text", text: "新节点", width: 200, height: 60 });
    expect(next).not.toBe(doc);
  });

  it("createNodeId / createEdgeId 避开已占用 id", () => {
    const doc = twoNodes();
    expect(createNodeId(doc)).toBe("n3");
    expect(doc.nodes.some((node) => node.id === createNodeId(doc))).toBe(false);
    expect(createEdgeId(doc)).toBe("e1");
  });

  it("addTextNode 撞 id 时原样返回", () => {
    const doc = twoNodes();
    expect(addTextNode(doc, { id: "a", x: 0, y: 0 })).toBe(doc);
  });

  it("updateNode 改文本，节点不存在时原样返回", () => {
    const doc = twoNodes();
    const next = updateNode(doc, "a", { text: "改过" });
    expect(findNode(next, "a")?.text).toBe("改过");
    expect(findNode(doc, "a")?.text).toBe("甲");
    expect(updateNode(doc, "ghost", { text: "x" })).toBe(doc);
  });

  it("moveNode 默认吸附 20px 网格，关闭吸附后保留原值", () => {
    const doc = twoNodes();
    const snapped = moveNode(doc, "a", 33, 47);
    expect(findNode(snapped, "a")).toMatchObject({ x: 40, y: 40 });
    const raw = moveNode(doc, "a", 33, 47, { snap: false });
    expect(findNode(raw, "a")).toMatchObject({ x: 33, y: 47 });
    expect(findNode(doc, "a")).toMatchObject({ x: 0, y: 0 });
  });

  it("snapToGrid 取最近网格点（含负数与空值）", () => {
    expect(snapToGrid(7)).toBe(0);
    expect(snapToGrid(10)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    expect(snapToGrid(-31)).toBe(-40);
    expect(snapToGrid(Number.NaN)).toBe(0);
    // 非法网格回退默认 20
    expect(snapToGrid(33, 0)).toBe(40);
  });

  it("removeNode 连带删除相连边", () => {
    let doc = twoNodes();
    doc = addEdge(doc, { id: "e1", fromNode: "a", toNode: "b" });
    const next = removeNode(doc, "a");
    expect(next.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(next.edges).toHaveLength(0);
    expect(removeNode(doc, "ghost")).toBe(doc);
  });

  it("addEdge 拒绝自环、重复连接与端点不存在", () => {
    const doc = twoNodes();
    expect(addEdge(doc, { fromNode: "a", toNode: "a" })).toBe(doc);
    expect(addEdge(doc, { fromNode: "a", toNode: "ghost" })).toBe(doc);
    const withEdge = addEdge(doc, { id: "e1", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" });
    expect(withEdge.edges).toHaveLength(1);
    // 同向同边重复
    expect(addEdge(withEdge, { fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" })).toBe(withEdge);
    // 反向不算重复（Obsidian 里两条独立箭头）
    expect(addEdge(withEdge, { id: "e2", fromNode: "b", toNode: "a" }).edges).toHaveLength(2);
    // 撞 id
    expect(addEdge(withEdge, { id: "e1", fromNode: "b", toNode: "a" })).toBe(withEdge);
  });

  it("removeEdge 删除连线，不存在时原样返回", () => {
    let doc = twoNodes();
    doc = addEdge(doc, { id: "e1", fromNode: "a", toNode: "b" });
    const without = removeEdge(doc, "e1");
    expect(without.edges).toHaveLength(0);
    expect(without).not.toBe(doc);
    expect(findEdge(doc, "e1")).not.toBeNull();
    // 边已经不在了：再删一次原样返回
    expect(removeEdge(without, "e1")).toBe(without);
  });

  it("addFileNode 只接受库内相对路径", () => {
    const doc = emptyCanvas();
    const next = addFileNode(doc, { id: "f1", file: "notes/甲.md", x: 0, y: 0 });
    expect(next.nodes[0]).toMatchObject({ type: "file", file: "notes/甲.md" });
    for (const bad of ["/abs/a.md", "../a.md", "C:/a.md", "http://x/a.md", "a//b.md", ""]) {
      expect(addFileNode(doc, { file: bad, x: 0, y: 0 })).toBe(doc);
    }
    // 反斜杠会被归一成 /，仍然是合法库内路径
    expect(addFileNode(doc, { file: "notes\\乙.md", x: 0, y: 0 }).nodes[0].file).toBe("notes/乙.md");
  });

  it("isVaultRelPath 拒绝绝对路径、协议前缀与路径穿越", () => {
    expect(isVaultRelPath("notes/a.md")).toBe(true);
    expect(isVaultRelPath("a.md")).toBe(true);
    expect(isVaultRelPath("notes/画布/流程.canvas")).toBe(true);
    expect(isVaultRelPath("")).toBe(false);
    expect(isVaultRelPath("/etc/passwd")).toBe(false);
    expect(isVaultRelPath("C:\\Windows\\a.md")).toBe(false);
    expect(isVaultRelPath("file:///a.md")).toBe(false);
    expect(isVaultRelPath("../a.md")).toBe(false);
    expect(isVaultRelPath("a/../b.md")).toBe(false);
    expect(isVaultRelPath("./a.md")).toBe(false);
    expect(isVaultRelPath("a\u0000b.md")).toBe(false);
  });
});

describe("几何辅助", () => {
  function node(over: Partial<{ id: string; x: number; y: number; width: number; height: number }> = {}) {
    return {
      id: over.id ?? "a",
      type: "text" as const,
      x: over.x ?? 0,
      y: over.y ?? 0,
      width: over.width ?? 200,
      height: over.height ?? 60,
    };
  }

  it("nodeAnchor 取各边中点", () => {
    const target = node();
    expect(nodeAnchor(target, "top")).toEqual({ x: 100, y: 0 });
    expect(nodeAnchor(target, "bottom")).toEqual({ x: 100, y: 60 });
    expect(nodeAnchor(target, "left")).toEqual({ x: 0, y: 30 });
    expect(nodeAnchor(target, "right")).toEqual({ x: 200, y: 30 });
    expect(nodeAnchor(target, "unknown")).toEqual({ x: 100, y: 30 });
  });

  it("defaultSides 按相对位置选最近的一对边", () => {
    const left = node({ id: "a", x: 0, y: 0 });
    const right = node({ id: "b", x: 400, y: 0 });
    expect(defaultSides(left, right)).toEqual({ fromSide: "right", toSide: "left" });
    expect(defaultSides(right, left)).toEqual({ fromSide: "left", toSide: "right" });
    const below = node({ id: "c", x: 0, y: 400 });
    expect(defaultSides(left, below)).toEqual({ fromSide: "bottom", toSide: "top" });
    expect(defaultSides(below, left)).toEqual({ fromSide: "top", toSide: "bottom" });
  });

  it("edgeGeometry 端点落在节点边上，控制点沿法线外扩", () => {
    const geometry = edgeGeometry(node({ x: 0, y: 0 }), node({ id: "b", x: 400, y: 0 }));
    expect(geometry).toMatchObject({ x1: 200, y1: 30, x2: 400, y2: 30 });
    expect(geometry.cx1).toBeGreaterThan(geometry.x1);
    expect(geometry.cx2).toBeLessThan(geometry.x2);
  });

  it("canvasBounds 覆盖全部节点，空画布给默认尺寸", () => {
    const doc: CanvasDoc = {
      nodes: [node({ x: 0, y: 0 }), node({ id: "b", x: 300, y: 120 })],
      edges: [],
    };
    expect(canvasBounds(doc)).toEqual({ x: 0, y: 0, width: 500, height: 180 });
    expect(canvasBounds(emptyCanvas())).toMatchObject({ width: 200, height: 60 });
  });
});
