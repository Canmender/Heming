/**
 * Obsidian Canvas（`.canvas`）文档模型：解析、序列化与全部编辑操作。
 *
 * 三条硬约束（界面组件 `CanvasPane` 与本文件共同遵守）：
 * 1. **未知字段不丢**：`.canvas` 是纯 JSON，Obsidian 版本升级会多出新键；解析时把
 *    不认识的键收进 `__extra`，序列化时原样写回（`__extra` 本身不落盘），保证
 *    「解析 → 序列化 → 再解析」得到等价文档。
 * 2. **坏内容不回写**：解析失败只返回中文错误，由调用方切成只读预览；这里的任何
 *    编辑函数都不会拿到「半懂」的文档，更不会替用户覆盖原文件。
 * 3. **纯函数**：没有 React、没有 IO。所有编辑操作返回**新**文档，绝不修改入参
 *    （界面因此可以安全地拿旧文档重放拖动）。
 */

/** 画布节点类型：Obsidian 目前只有这四种。 */
export type CanvasNodeType = "text" | "file" | "link" | "group";

/** 连线端点所在的边。 */
export type CanvasSide = "top" | "right" | "bottom" | "left";

export const CANVAS_NODE_TYPES: readonly CanvasNodeType[] = ["text", "file", "link", "group"];
export const CANVAS_SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];

/** 坐标绝对值上限：超过这个量级的画布基本是数据损坏，夹住而不是让 SVG 失焦。 */
export const COORD_MAX = 1_000_000;
/** 节点尺寸夹取范围。 */
export const MIN_NODE_SIZE = 20;
export const MAX_NODE_SIZE = 5000;
/** 拖动吸附网格（与 Obsidian 的观感一致）。 */
export const GRID_SIZE = 20;
/** 新节点的默认尺寸。 */
export const DEFAULT_NODE_WIDTH = 200;
export const DEFAULT_NODE_HEIGHT = 60;

/**
 * 画布节点。`text/file/url/label/color` 都是可选：按类型只用到其中一部分
 * （text→text、file→file、link→url、group→label），但解析时不按类型丢弃，
 * 以免「Obsidian 里以后允许 text 节点带 color」之类的小扩展被我们抹掉。
 */
export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  /** 文件节点指向的库内相对路径（`/` 分隔，不含库根）。 */
  file?: string;
  /** 链接节点地址；渲染时只放行 http(s)。 */
  url?: string;
  /** 分组节点的标题。 */
  label?: string;
  /** Obsidian 色板预设（"1"–"6"）或十六进制色值，按原样保留。 */
  color?: string;
  /** 不认识的键（前向兼容），序列化时原样写回。 */
  __extra?: Record<string, unknown>;
}

/** 画布连线。`fromSide/toSide` 用宽松的 string：Obsidian 将来加新边侧时也不丢值。 */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  label?: string;
  color?: string;
  __extra?: Record<string, unknown>;
}

/** 一份画布文档。 */
export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 顶层不认识的键（前向兼容）。 */
  __extra?: Record<string, unknown>;
}

export type CanvasParseResult = { ok: true; doc: CanvasDoc } | { ok: false; error: string };

const NODE_KEYS = ["id", "type", "x", "y", "width", "height", "text", "file", "url", "label", "color"] as const;
const EDGE_KEYS = ["id", "fromNode", "fromSide", "toNode", "toSide", "label", "color"] as const;
const DOC_KEYS = ["nodes", "edges"] as const;

const NODE_KEY_SET = new Set<string>(NODE_KEYS);
const EDGE_KEY_SET = new Set<string>(EDGE_KEYS);
const DOC_KEY_SET = new Set<string>(DOC_KEYS);

/* ------------------------------------------------------------ 基础工具 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  // Math.max/min 顺带把 -0 归一成 +0，避免序列化出 "-0" 这种怪异值。
  return Math.max(min, Math.min(max, value));
}

function clampCoord(value: number): number {
  return clamp(value, -COORD_MAX, COORD_MAX);
}

function clampSize(value: number): number {
  return clamp(value, MIN_NODE_SIZE, MAX_NODE_SIZE);
}

/** 网格吸附：返回离 value 最近的网格点。 */
export function snapToGrid(value: number, grid: number = GRID_SIZE): number {
  if (!Number.isFinite(value)) return 0;
  const step = Number.isFinite(grid) && grid > 0 ? grid : GRID_SIZE;
  return Math.round(value / step) * step;
}

function collectExtra(
  source: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** 输出顺序固定的 __extra 键（按字典序，保证同样输入永远序列化出同样字符串）。 */
function orderedExtra(
  extra: Record<string, unknown> | undefined,
  known: ReadonlySet<string>,
): Array<[string, unknown]> {
  if (!extra) return [];
  return Object.keys(extra)
    .filter((key) => !known.has(key) && extra[key] !== undefined)
    .sort()
    .map((key) => [key, extra[key]]);
}

/* ------------------------------------------------------------ 解析 */

function parseNode(value: unknown, index: number, seen: Set<string>): CanvasNode | string | null {
  if (!isRecord(value)) return `第 ${index + 1} 个节点不是对象。`;

  const id = value.id;
  if (typeof id !== "string" || id.trim() === "") return `第 ${index + 1} 个节点缺少 id。`;
  if (seen.has(id)) return null; // 重复 id：保留先出现的那一个
  seen.add(id);

  const type = value.type;
  if (typeof type !== "string" || !(CANVAS_NODE_TYPES as readonly string[]).includes(type)) {
    return `节点 ${id} 的类型“${String(type)}”不受支持（只支持 text / file / link / group）。`;
  }

  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
    return `节点 ${id} 缺少有效坐标（x / y 必须是数字）。`;
  }

  // 宽高缺失时给默认值：任务口径只把「缺 id / 缺坐标」定为错误，宽高写成默认
  // 是可恢复的小损失，报错反而让用户连只读预览都难对照。
  const width = isFiniteNumber(value.width) ? value.width : DEFAULT_NODE_WIDTH;
  const height = isFiniteNumber(value.height) ? value.height : DEFAULT_NODE_HEIGHT;

  const node: CanvasNode = {
    id,
    type: type as CanvasNodeType,
    x: clampCoord(value.x),
    y: clampCoord(value.y),
    width: clampSize(width),
    height: clampSize(height),
  };
  if (typeof value.text === "string") node.text = value.text;
  if (typeof value.file === "string") node.file = value.file;
  if (typeof value.url === "string") node.url = value.url;
  if (typeof value.label === "string") node.label = value.label;
  if (typeof value.color === "string") node.color = value.color;
  const extra = collectExtra(value, NODE_KEY_SET);
  if (extra) node.__extra = extra;
  return node;
}

function connectionKey(fromNode: string, fromSide: string | undefined, toNode: string, toSide: string | undefined): string {
  return [fromNode, fromSide ?? "", toNode, toSide ?? ""].join("\u0000");
}

function parseEdge(
  value: unknown,
  index: number,
  seenIds: Set<string>,
  seenLinks: Set<string>,
): CanvasEdge | string | null {
  if (!isRecord(value)) return `第 ${index + 1} 条边不是对象。`;

  const id = value.id;
  if (typeof id !== "string" || id.trim() === "") return `第 ${index + 1} 条边缺少 id。`;
  if (seenIds.has(id)) return null; // 重复 id：保留先出现的那一条
  seenIds.add(id);

  const fromNode = value.fromNode;
  const toNode = value.toNode;
  if (typeof fromNode !== "string" || fromNode.trim() === "" || typeof toNode !== "string" || toNode.trim() === "") {
    return `边 ${id} 缺少 fromNode / toNode。`;
  }

  const fromSide = typeof value.fromSide === "string" ? value.fromSide : undefined;
  const toSide = typeof value.toSide === "string" ? value.toSide : undefined;
  const linkKey = connectionKey(fromNode, fromSide, toNode, toSide);
  if (seenLinks.has(linkKey)) return null; // 同向同边的重复连线
  seenLinks.add(linkKey);

  // 指向不存在节点的边**保留**（不静默删数据）；渲染层查不到节点时跳过绘制，
  // 用户删掉节点时 `removeNode` 会连带清理，因此编辑一次后自然收敛。

  const edge: CanvasEdge = { id, fromNode, toNode };
  if (fromSide !== undefined) edge.fromSide = fromSide;
  if (toSide !== undefined) edge.toSide = toSide;
  if (typeof value.label === "string") edge.label = value.label;
  if (typeof value.color === "string") edge.color = value.color;
  const extra = collectExtra(value, EDGE_KEY_SET);
  if (extra) edge.__extra = extra;
  return edge;
}

/**
 * 解析 `.canvas` 文本。
 *
 * 失败时只返回中文原因（界面据此显示错误 + 原文只读预览），**不抛异常**：
 * 画布内容来自用户文件，任何一段损坏都不该让整个知识库页白屏。
 */
export function parseCanvas(text: string): CanvasParseResult {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "画布内容为空，无法解析。" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `画布不是合法 JSON：${detail}` };
  }

  if (!isRecord(raw)) {
    return { ok: false, error: "画布根节点必须是对象（形如 {\"nodes\":[],\"edges\":[]}）。" };
  }
  if (!Array.isArray(raw.nodes)) return { ok: false, error: "画布缺少 nodes 数组。" };
  if (!Array.isArray(raw.edges)) return { ok: false, error: "画布缺少 edges 数组。" };

  const nodes: CanvasNode[] = [];
  const nodeIds = new Set<string>();
  for (let index = 0; index < raw.nodes.length; index += 1) {
    const outcome = parseNode(raw.nodes[index], index, nodeIds);
    if (typeof outcome === "string") return { ok: false, error: outcome };
    if (outcome) nodes.push(outcome);
  }

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  const edgeLinks = new Set<string>();
  for (let index = 0; index < raw.edges.length; index += 1) {
    const outcome = parseEdge(raw.edges[index], index, edgeIds, edgeLinks);
    if (typeof outcome === "string") return { ok: false, error: outcome };
    if (outcome) edges.push(outcome);
  }

  const doc: CanvasDoc = { nodes, edges };
  const extra = collectExtra(raw, DOC_KEY_SET);
  if (extra) doc.__extra = extra;
  return { ok: true, doc };
}

/* ------------------------------------------------------------ 序列化 */

function serializeNode(node: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    x: clampCoord(isFiniteNumber(node.x) ? node.x : 0),
    y: clampCoord(isFiniteNumber(node.y) ? node.y : 0),
    width: clampSize(isFiniteNumber(node.width) ? node.width : DEFAULT_NODE_WIDTH),
    height: clampSize(isFiniteNumber(node.height) ? node.height : DEFAULT_NODE_HEIGHT),
  };
  if (node.text !== undefined) out.text = node.text;
  if (node.file !== undefined) out.file = node.file;
  if (node.url !== undefined) out.url = node.url;
  if (node.label !== undefined) out.label = node.label;
  if (node.color !== undefined) out.color = node.color;
  for (const [key, value] of orderedExtra(node.__extra, NODE_KEY_SET)) out[key] = value;
  return out;
}

function serializeEdge(edge: CanvasEdge): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: edge.id,
    fromNode: edge.fromNode,
  };
  // 边侧/标签/颜色缺省就**不写**：原文件没写时序列化也不能凭空补一个值，
  // 否则「解析 → 序列化 → 再解析」不再等价（渲染层另有 defaultSides 兜底）。
  if (edge.fromSide !== undefined) out.fromSide = edge.fromSide;
  out.toNode = edge.toNode;
  if (edge.toSide !== undefined) out.toSide = edge.toSide;
  if (edge.label !== undefined) out.label = edge.label;
  if (edge.color !== undefined) out.color = edge.color;
  for (const [key, value] of orderedExtra(edge.__extra, EDGE_KEY_SET)) out[key] = value;
  return out;
}

/**
 * 序列化为 Obsidian 可读的字符串：键序稳定、2 空格缩进、末尾换行。
 * 同样的文档永远得到同样的字符串（拖动落盘不会产生无意义 diff）。
 */
export function serializeCanvas(doc: CanvasDoc): string {
  const out: Record<string, unknown> = {
    nodes: doc.nodes.map(serializeNode),
    edges: doc.edges.map(serializeEdge),
  };
  for (const [key, value] of orderedExtra(doc.__extra, DOC_KEY_SET)) out[key] = value;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/* ------------------------------------------------------------ 查询与几何 */

export function findNode(doc: CanvasDoc, id: string | null | undefined): CanvasNode | null {
  if (!id) return null;
  return doc.nodes.find((node) => node.id === id) ?? null;
}

export function findEdge(doc: CanvasDoc, id: string | null | undefined): CanvasEdge | null {
  if (!id) return null;
  return doc.edges.find((edge) => edge.id === id) ?? null;
}

/** 节点某一侧的中点坐标（连线的端点）。 */
export function nodeAnchor(node: CanvasNode, side: string | undefined): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    default:
      return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }
}

/** 未指定边侧时，按两个节点的相对位置挑一对「最近」的边。 */
export function defaultSides(
  from: CanvasNode,
  to: CanvasNode,
): { fromSide: CanvasSide; toSide: CanvasSide } {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

export interface CanvasEdgeGeometry {
  x1: number;
  y1: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  x2: number;
  y2: number;
}

function sideNormal(side: string | undefined): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    default:
      return { x: 0, y: 0 };
  }
}

/** 三次贝塞尔几何：端点 + 控制点。边侧缺省时按相对位置推断。 */
export function edgeGeometry(
  from: CanvasNode,
  to: CanvasNode,
  fromSide?: string,
  toSide?: string,
): CanvasEdgeGeometry {
  const sides = defaultSides(from, to);
  const startSide = fromSide ?? sides.fromSide;
  const endSide = toSide ?? sides.toSide;
  const start = nodeAnchor(from, startSide);
  const end = nodeAnchor(to, endSide);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const reach = Math.max(40, distance * 0.4);
  const n1 = sideNormal(startSide);
  const n2 = sideNormal(endSide);
  return {
    x1: start.x,
    y1: start.y,
    cx1: start.x + n1.x * reach,
    cy1: start.y + n1.y * reach,
    cx2: end.x + n2.x * reach,
    cy2: end.y + n2.y * reach,
    x2: end.x,
    y2: end.y,
  };
}

/** 所有节点的外包框（空画布返回 0 尺寸框），供「复位视图」用。 */
export function canvasBounds(doc: CanvasDoc): { x: number; y: number; width: number; height: number } {
  if (doc.nodes.length === 0) return { x: 0, y: 0, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of doc.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: Math.max(MIN_NODE_SIZE, maxX - minX), height: Math.max(MIN_NODE_SIZE, maxY - minY) };
}

/* ------------------------------------------------------------ 编辑操作 */

/** 生成一个当前文档里没被占用的节点 id（确定性，便于测试与 diff）。 */
export function createNodeId(doc: CanvasDoc): string {
  const used = new Set(doc.nodes.map((node) => node.id));
  let index = doc.nodes.length + 1;
  while (used.has(`n${index}`)) index += 1;
  return `n${index}`;
}

/** 生成一个当前文档里没被占用的连线 id。 */
export function createEdgeId(doc: CanvasDoc): string {
  const used = new Set(doc.edges.map((edge) => edge.id));
  let index = doc.edges.length + 1;
  while (used.has(`e${index}`)) index += 1;
  return `e${index}`;
}

export interface AddTextNodeInput {
  id?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
}

/** 新增文本节点。 */
export function addTextNode(doc: CanvasDoc, input: AddTextNodeInput): CanvasDoc {
  const id = input.id ?? createNodeId(doc);
  if (doc.nodes.some((node) => node.id === id)) return doc;
  const node: CanvasNode = {
    id,
    type: "text",
    x: clampCoord(input.x),
    y: clampCoord(input.y),
    width: clampSize(input.width ?? DEFAULT_NODE_WIDTH),
    height: clampSize(input.height ?? DEFAULT_NODE_HEIGHT),
    text: input.text ?? "",
  };
  if (input.color !== undefined) node.color = input.color;
  return { ...doc, nodes: [...doc.nodes, node] };
}

/**
 * 库内相对路径校验：拒绝绝对路径、盘符 / 协议前缀、`..`、空段与 NUL。
 * 桌面桥在主进程还会再夹一次，这里只是让界面尽早拒绝明显错误的输入。
 */
export function isVaultRelPath(rel: string): boolean {
  if (typeof rel !== "string") return false;
  const value = rel.replace(/\\/g, "/").trim();
  if (value === "") return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false; // http: / file: / C:
  if (value.startsWith("/")) return false;
  if (value.includes("\u0000")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** 新增文件节点（`file` 指向库内相对路径）。非法路径或无此文件时返回原文档。 */
export function addFileNode(
  doc: CanvasDoc,
  input: { id?: string; file: string; x: number; y: number; width?: number; height?: number; color?: string },
): CanvasDoc {
  const file = typeof input.file === "string" ? input.file.replace(/\\/g, "/").trim() : "";
  if (!isVaultRelPath(file)) return doc;
  const id = input.id ?? createNodeId(doc);
  if (doc.nodes.some((node) => node.id === id)) return doc;
  const node: CanvasNode = {
    id,
    type: "file",
    file,
    x: clampCoord(input.x),
    y: clampCoord(input.y),
    width: clampSize(input.width ?? DEFAULT_NODE_WIDTH),
    height: clampSize(input.height ?? DEFAULT_NODE_HEIGHT),
  };
  if (input.color !== undefined) node.color = input.color;
  return { ...doc, nodes: [...doc.nodes, node] };
}

export type CanvasNodePatch = Partial<Pick<CanvasNode, "x" | "y" | "width" | "height" | "text" | "file" | "url" | "label" | "color">>;

/** 更新节点字段（重算宽高与坐标夹取）；节点不存在时原样返回。 */
export function updateNode(doc: CanvasDoc, id: string, patch: CanvasNodePatch): CanvasDoc {
  const existing = findNode(doc, id);
  if (!existing) return doc;
  const next: CanvasNode = { ...existing };
  if (patch.x !== undefined && Number.isFinite(patch.x)) next.x = clampCoord(patch.x);
  if (patch.y !== undefined && Number.isFinite(patch.y)) next.y = clampCoord(patch.y);
  if (patch.width !== undefined && Number.isFinite(patch.width)) next.width = clampSize(patch.width);
  if (patch.height !== undefined && Number.isFinite(patch.height)) next.height = clampSize(patch.height);
  if (patch.text !== undefined) next.text = patch.text;
  if (patch.file !== undefined) next.file = patch.file;
  if (patch.url !== undefined) next.url = patch.url;
  if (patch.label !== undefined) next.label = patch.label;
  if (patch.color !== undefined) next.color = patch.color;
  return { ...doc, nodes: doc.nodes.map((node) => (node.id === id ? next : node)) };
}

/** 移动节点（默认吸附 20px 网格）；节点不存在时原样返回。 */
export function moveNode(
  doc: CanvasDoc,
  id: string,
  x: number,
  y: number,
  options: { snap?: boolean; grid?: number } = {},
): CanvasDoc {
  const snap = options.snap ?? true;
  const grid = options.grid ?? GRID_SIZE;
  const nextX = snap ? snapToGrid(x, grid) : x;
  const nextY = snap ? snapToGrid(y, grid) : y;
  return updateNode(doc, id, { x: nextX, y: nextY });
}

/** 删除节点，并连带删掉所有与它相连的边。 */
export function removeNode(doc: CanvasDoc, id: string): CanvasDoc {
  if (!findNode(doc, id)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => node.id !== id),
    edges: doc.edges.filter((edge) => edge.fromNode !== id && edge.toNode !== id),
  };
}

export interface AddEdgeInput {
  id?: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  label?: string;
  color?: string;
}

/**
 * 新增连线。自环、端点不存在、重复连接（同向同边）一律拒绝，返回原文档——
 * 界面凭返回值是否变化决定要不要 onChange。
 */
export function addEdge(doc: CanvasDoc, input: AddEdgeInput): CanvasDoc {
  if (input.fromNode === input.toNode) return doc;
  const ids = new Set(doc.nodes.map((node) => node.id));
  if (!ids.has(input.fromNode) || !ids.has(input.toNode)) return doc;
  const key = connectionKey(input.fromNode, input.fromSide, input.toNode, input.toSide);
  if (doc.edges.some((edge) => connectionKey(edge.fromNode, edge.fromSide, edge.toNode, edge.toSide) === key)) {
    return doc;
  }
  const id = input.id ?? createEdgeId(doc);
  if (doc.edges.some((edge) => edge.id === id)) return doc;
  const edge: CanvasEdge = { id, fromNode: input.fromNode, toNode: input.toNode };
  if (input.fromSide !== undefined) edge.fromSide = input.fromSide;
  if (input.toSide !== undefined) edge.toSide = input.toSide;
  if (input.label !== undefined) edge.label = input.label;
  if (input.color !== undefined) edge.color = input.color;
  return { ...doc, edges: [...doc.edges, edge] };
}

/** 删除连线（不存在时原样返回）。 */
export function removeEdge(doc: CanvasDoc, id: string): CanvasDoc {
  if (!findEdge(doc, id)) return doc;
  return { ...doc, edges: doc.edges.filter((edge) => edge.id !== id) };
}

/** 空文档（新建 `.canvas` 时用）。 */
export function emptyCanvas(): CanvasDoc {
  return { nodes: [], edges: [] };
}
