/**
 * Obsidian Canvas 视图的对外入口。
 *
 * 接入方（知识库页 / 命令面板 / 未来的画布 tab）只从这里 import：
 * `CanvasPane` 是受控组件，`canvasModel` 里是纯函数（解析/序列化/编辑），
 * 两者都不碰存储与 IPC。
 */
export { CanvasPane } from "./CanvasPane.js";
export type { CanvasPaneProps } from "./CanvasPane.js";
export {
  CANVAS_NODE_TYPES,
  CANVAS_SIDES,
  COORD_MAX,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  GRID_SIZE,
  MAX_NODE_SIZE,
  MIN_NODE_SIZE,
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
} from "./canvasModel.js";
export type {
  AddEdgeInput,
  AddTextNodeInput,
  CanvasDoc,
  CanvasEdge,
  CanvasEdgeGeometry,
  CanvasNode,
  CanvasNodePatch,
  CanvasNodeType,
  CanvasParseResult,
  CanvasSide,
} from "./canvasModel.js";
