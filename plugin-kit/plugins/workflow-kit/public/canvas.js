/**
 * 工作流画布（public/canvas.js）——原生 JS、无构建、无第三方库。
 *
 * 为什么是一个经典脚本 + 全局 API：
 * - 插件项目不引入前端构建链（CONTRACT §7），index.html 用 `<script>` 直接加载；
 * - 页面壳（app.js）只需要 `window.WFCanvas.mount(container, callbacks)` 拿到实例，
 *   画布自己不拉数据、不存工作流，移动/连线/删除一律回调给页面壳（草稿在 app.js）；
 * - 因此这里只做三件事：几何换算（屏幕 ↔ 画布）、DOM/SVG 渲染、鼠标与键盘手势。
 *
 * 与 n8n 的关系：只按公开语义独立实现（画布交互、贝塞尔连线、端口拖线），
 * 没有使用其源码或依赖（见 docs/DESIGN.md 的许可说明）。
 *
 * 交互口径（与 n8n 画布一致）：
 *   左键点节点=选中（Shift 追加/取消）；拖动节点=移动（20 网格吸附，多选一起动）；
 *   左键拖空白=框选；空格+左键拖 / 中键拖=平移；滚轮=以光标为中心缩放（0.2–2）；
 *   从输出口拖出=连线（悬停高亮最近输入口）；Delete/Backspace=删除；双击空白=加节点；
 *   双击节点或节点聚焦后 Enter=打开节点；Esc=取消当前拖线/框选。
 *
 * 实例 API（CONTRACT §7）：
 *   setWorkflow(workflow) / setSelected(ids) / setRunState(map) / setReadOnly(bool)
 *   fit() / zoomBy(factor) / getViewport()        （额外提供 destroy() 便于卸载）
 *
 * 回调（可选，缺省不做事）：
 *   onSelect(ids) / onMoveNodes(moves) / onConnect({sourceId,sourceOutput,targetId,targetInput})
 *   onRequestDelete(ids) / onOpenNode(id) / onRequestAddNode({x,y})
 */
(function (global) {
  "use strict";

  // ── 尺寸与常量 ─────────────────────────────────────────────────────

  var NODE_WIDTH = 208;
  var NODE_HEIGHT = 76;
  var MIN_ZOOM = 0.2;
  var MAX_ZOOM = 2;
  var ZOOM_STEP = 1.2;
  var GRID_SIZE = 20;
  var PORT_HIT_RADIUS = 18;
  var FIT_PADDING = 80;
  var MAX_FIT_ZOOM = 1.5;
  var DRAG_THRESHOLD = 3;
  var FALLBACK_WIDTH = 800;
  var FALLBACK_HEIGHT = 600;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var mountSeq = 0;

  // 节点 type → 字形（画布不依赖 app.js 的图标表；只用来区分「看起来像什么」）。
  // 不用 emoji：CONTRACT 要求无 emoji，这里用 1–3 个字/字母缩写。
  var TYPE_GLYPHS = {
    manualTrigger: "手",
    scheduleTrigger: "时",
    errorTrigger: "错",
    executeWorkflowTrigger: "子",
    httpRequest: "HTTP",
    code: "码",
    set: "设",
    if: "判",
    switch: "分",
    merge: "并",
    splitInBatches: "批",
    splitOut: "拆",
    filter: "滤",
    sort: "排",
    limit: "限",
    removeDuplicates: "去",
    aggregate: "汇",
    itemLists: "列",
    wait: "等",
    noOperation: "空",
    stopAndError: "停",
    executeWorkflow: "流",
    dateTime: "日",
    crypto: "密",
    xml: "XML",
    llm: "AI",
    mcpTool: "MCP",
    notification: "通"
  };

  // 画布拿不到节点类型注册表（不拉数据、不 import），所以输入/输出口数量用
  // 「常见类型表 + 命名兜底」推断；页面壳若在 workflow 节点上附带 inputs/outputs
  // 数字（可选扩展），优先使用它——这样 Switch 这类动态输出也能被正确画出来。
  var INPUT_COUNTS = { merge: 2 };
  var OUTPUT_COUNTS = { if: 2, splitInBatches: 2 };

  // ── 小工具 ─────────────────────────────────────────────────────────

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function clampZoom(zoom) {
    var value = Number(zoom);
    if (!isFinite(value)) return 1;
    return clamp(value, MIN_ZOOM, MAX_ZOOM);
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function snapToGrid(value) {
    return Math.round(value / GRID_SIZE) * GRID_SIZE;
  }

  function sameIds(left, right) {
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  function closest(element, selector) {
    var current = element;
    while (current && current.nodeType === 1) {
      if (typeof current.matches === "function" && current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function isEditableTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    var tag = (target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return target.isContentEditable === true;
  }

  function glyphFor(type) {
    if (TYPE_GLYPHS[type]) return TYPE_GLYPHS[type];
    if (/Trigger$/.test(String(type || ""))) return "触";
    var letters = String(type || "").replace(/[^a-zA-Z]/g, "");
    if (letters.length > 0) return letters.slice(0, 2).toUpperCase();
    return "节";
  }

  // ── 端口数量与几何 ─────────────────────────────────────────────────

  function declaredCount(value) {
    if (typeof value === "number" && isFinite(value) && value >= 0) return Math.floor(value);
    if (Array.isArray(value)) return value.length;
    return null;
  }

  function inputCountOf(node) {
    var declared = declaredCount(node && node.inputs);
    if (declared !== null) return declared;
    if (!node) return 0;
    if (INPUT_COUNTS[node.type] !== undefined) return INPUT_COUNTS[node.type];
    if (/Trigger$/.test(String(node.type || ""))) return 0;
    return 1;
  }

  function outputCountOf(node) {
    var declared = declaredCount(node && node.outputs);
    if (declared !== null) return declared;
    if (!node) return 0;
    if (OUTPUT_COUNTS[node.type] !== undefined) return OUTPUT_COUNTS[node.type];
    if (node.type === "switch") {
      // Switch 的输出口数量跟随 rules；没有 rules 时至少保留「全部兜底」一个口。
      var rules = node.parameters && node.parameters.rules;
      if (Array.isArray(rules) && rules.length > 0) return rules.length + 1;
      return 2;
    }
    return 1;
  }

  function nodeRectAt(position) {
    return {
      x: position.x,
      y: position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    };
  }

  function inputPortPoint(position, index, count) {
    var total = Math.max(1, count);
    return {
      x: position.x,
      y: position.y + (NODE_HEIGHT * (index + 1)) / (total + 1)
    };
  }

  function outputPortPoint(position, index, count) {
    var total = Math.max(1, count);
    return {
      x: position.x + NODE_WIDTH,
      y: position.y + (NODE_HEIGHT * (index + 1)) / (total + 1)
    };
  }

  function bezierPath(from, to) {
    var control = Math.max(40, Math.min(160, Math.abs(to.x - from.x) * 0.5));
    return (
      "M " +
      round(from.x) +
      " " +
      round(from.y) +
      " C " +
      round(from.x + control) +
      " " +
      round(from.y) +
      ", " +
      round(to.x - control) +
      " " +
      round(to.y) +
      ", " +
      round(to.x) +
      " " +
      round(to.y)
    );
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y)
    };
  }

  function distance(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function screenToCanvas(point, viewport) {
    return {
      x: (point.x - viewport.x) / viewport.zoom,
      y: (point.y - viewport.y) / viewport.zoom
    };
  }

  function canvasToScreen(point, viewport) {
    return {
      x: point.x * viewport.zoom + viewport.x,
      y: point.y * viewport.zoom + viewport.y
    };
  }

  function createSvgElement(tag) {
    return document.createElementNS(SVG_NS, tag);
  }

  // ── mount ──────────────────────────────────────────────────────────

  function mount(container, callbacks) {
    if (!container || container.nodeType !== 1) {
      throw new TypeError("WFCanvas.mount(container, callbacks)：container 必须是 DOM 元素");
    }
    var cb = callbacks || {};
    var uid = "wf-canvas-" + ++mountSeq;
    var markerId = uid + "-arrow";

    var state = {
      workflow: { nodes: [], connections: {} },
      nodes: [],
      positions: {}, // 节点 id → 画布坐标（拖动时先本地生效，松手再回调）
      connections: {},
      selected: [],
      runState: {},
      readOnly: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      drag: null, // { ids, startClient, startPositions, delta, moved }
      connect: null, // { from, current, hover }
      box: null, // { start, current, additive }
      pan: null, // { startClient, startViewport }
      detachGesture: null,
      spaceHeld: false,
      nodeEls: {},
      destroyed: false
    };

    // ── 骨架 DOM ────────────────────────────────────────────────────

    var root = document.createElement("div");
    root.className = "wf-canvas";
    root.setAttribute("role", "application");
    root.setAttribute("aria-label", "工作流画布");
    root.setAttribute("data-wf-canvas", uid);
    root.tabIndex = 0;

    var svg = createSvgElement("svg");
    svg.setAttribute("class", "wf-canvas__edges");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    // 连线层不参与命中、也不裁掉画布负坐标处的线；写内联是为了不依赖 canvas.css 的加载顺序。
    svg.style.pointerEvents = "none";
    svg.style.overflow = "visible";

    var defs = createSvgElement("defs");
    var marker = createSvgElement("marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("viewBox", "0 0 8 8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto");
    var arrow = createSvgElement("path");
    arrow.setAttribute("d", "M 0 1 L 6 4 L 0 7 z");
    arrow.setAttribute("fill", "#a8a8a0");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);

    var edgeGroup = createSvgElement("g");
    edgeGroup.setAttribute("class", "wf-canvas__edge-group");
    svg.appendChild(edgeGroup);

    var world = document.createElement("div");
    world.className = "wf-canvas__world";

    var boxEl = document.createElement("div");
    boxEl.className = "wf-canvas__box";
    boxEl.hidden = true;

    var emptyEl = document.createElement("div");
    emptyEl.className = "wf-canvas__empty";
    emptyEl.textContent = "还没有节点 · 双击空白处添加第一个节点";

    var toolbar = document.createElement("div");
    toolbar.className = "wf-canvas__toolbar";
    toolbar.setAttribute("data-toolbar", "");

    var zoomLabel = document.createElement("span");
    zoomLabel.className = "wf-canvas__zoom";
    zoomLabel.setAttribute("data-zoom-label", "");
    zoomLabel.textContent = "100%";

    function makeToolbarButton(label, text, onClick) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "wf-canvas__btn";
      button.setAttribute("aria-label", label);
      button.textContent = text;
      button.addEventListener("click", onClick);
      return button;
    }

    toolbar.appendChild(makeToolbarButton("缩小", "−", function () { zoomBy(1 / ZOOM_STEP); }));
    toolbar.appendChild(zoomLabel);
    toolbar.appendChild(makeToolbarButton("放大", "+", function () { zoomBy(ZOOM_STEP); }));
    toolbar.appendChild(makeToolbarButton("适配视图", "适配", function () { fit(); }));

    root.appendChild(svg);
    root.appendChild(world);
    root.appendChild(boxEl);
    root.appendChild(emptyEl);
    root.appendChild(toolbar);
    container.appendChild(root);

    // ── 回调与状态应用 ──────────────────────────────────────────────

    function emit(name, payload) {
      var handler = cb[name];
      if (typeof handler === "function") handler(payload);
    }

    function measure() {
      return {
        width: root.clientWidth || FALLBACK_WIDTH,
        height: root.clientHeight || FALLBACK_HEIGHT
      };
    }

    function localPoint(event) {
      var rect = root.getBoundingClientRect();
      return {
        x: (event.clientX || 0) - (rect.left || 0),
        y: (event.clientY || 0) - (rect.top || 0)
      };
    }

    function positionOf(node) {
      var base = state.positions[node.id] || node.position || { x: 0, y: 0 };
      var drag = state.drag;
      if (drag && drag.moved && drag.ids.indexOf(node.id) >= 0) {
        return { x: base.x + drag.delta.x, y: base.y + drag.delta.y };
      }
      return { x: base.x, y: base.y };
    }

    function indexNodes() {
      var byId = {};
      for (var i = 0; i < state.nodes.length; i += 1) byId[state.nodes[i].id] = state.nodes[i];
      return byId;
    }

    function applyViewport() {
      var viewport = state.viewport;
      world.style.transform =
        "translate(" + round(viewport.x) + "px, " + round(viewport.y) + "px) scale(" + round(viewport.zoom) + ")";
      edgeGroup.setAttribute(
        "transform",
        "translate(" + round(viewport.x) + " " + round(viewport.y) + ") scale(" + round(viewport.zoom) + ")"
      );
      root.setAttribute("data-zoom", String(round(viewport.zoom)));
      zoomLabel.textContent = Math.round(viewport.zoom * 100) + "%";
      // 网格随缩放/平移走：点距 20 画布像素，偏移量与视口一致
      var gap = GRID_SIZE * viewport.zoom;
      root.style.backgroundSize = gap + "px " + gap + "px";
      root.style.backgroundPosition = round(viewport.x) + "px " + round(viewport.y) + "px";
      drawEdges();
    }

    function applySelectedClasses() {
      for (var i = 0; i < state.nodes.length; i += 1) {
        var node = state.nodes[i];
        var card = state.nodeEls[node.id];
        if (!card) continue;
        var selected = state.selected.indexOf(node.id) >= 0;
        card.classList.toggle("wf-node--selected", selected);
        card.setAttribute("aria-pressed", selected ? "true" : "false");
      }
    }

    function normalizeRunState(value) {
      if (typeof value === "string") return { state: value };
      if (value && typeof value === "object") {
        return {
          state: typeof value.state === "string" ? value.state : "idle",
          itemCount: typeof value.itemCount === "number" && isFinite(value.itemCount) ? value.itemCount : undefined
        };
      }
      return { state: "idle" };
    }

    function applyRunStateClasses() {
      for (var i = 0; i < state.nodes.length; i += 1) {
        var node = state.nodes[i];
        var card = state.nodeEls[node.id];
        if (!card) continue;
        var run = normalizeRunState(state.runState[node.id]);
        var known = run.state === "running" || run.state === "success" || run.state === "error";
        card.setAttribute("data-run-state", known ? run.state : "idle");
        var itemsEl = card.querySelector(".wf-node__items");
        if (itemsEl) {
          if (typeof run.itemCount === "number") {
            itemsEl.textContent = run.itemCount + " 项";
            itemsEl.hidden = false;
          } else {
            itemsEl.textContent = "";
            itemsEl.hidden = true;
          }
        }
      }
    }

    function setActivePort(portInfo) {
      var previous = world.querySelectorAll(".wf-node__port--active");
      for (var i = 0; i < previous.length; i += 1) previous[i].classList.remove("wf-node__port--active");
      if (!portInfo) return;
      var selector =
        '.wf-node__port[data-node-id="' +
        portInfo.nodeId +
        '"][data-port-kind="input"][data-port-index="' +
        portInfo.index +
        '"]';
      var element = world.querySelector(selector);
      if (element) element.classList.add("wf-node__port--active");
    }

    function applySelected(ids) {
      state.selected = Array.isArray(ids) ? ids.slice() : [];
      applySelectedClasses();
      drawEdges();
    }

    // ── 节点渲染 ────────────────────────────────────────────────────

    function createPort(node, kind, index, count) {
      var port = document.createElement("span");
      port.className = "wf-node__port wf-node__port--" + kind;
      port.setAttribute("data-port", "");
      port.setAttribute("data-node-id", node.id);
      port.setAttribute("data-port-kind", kind);
      port.setAttribute("data-port-index", String(index));
      port.setAttribute(
        "aria-label",
        (node.name || node.type) + (kind === "input" ? " 输入 " : " 输出 ") + (index + 1)
      );
      port.style.top = ((index + 1) / (count + 1)) * 100 + "%";
      return port;
    }

    function buildNodeCard(node) {
      var position = positionOf(node);
      var card = document.createElement("div");
      card.className = "wf-node";
      card.setAttribute("data-node-id", node.id);
      card.setAttribute("data-node-type", node.type || "");
      card.setAttribute("data-run-state", "idle");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", "节点 " + (node.name || node.type || node.id));
      card.style.left = round(position.x) + "px";
      card.style.top = round(position.y) + "px";
      card.style.width = NODE_WIDTH + "px";
      card.style.height = NODE_HEIGHT + "px";
      if (node.disabled) {
        card.classList.add("wf-node--disabled");
        card.setAttribute("aria-disabled", "true");
      }

      var glyph = document.createElement("span");
      glyph.className = "wf-node__glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = glyphFor(node.type);

      var body = document.createElement("span");
      body.className = "wf-node__body";
      var title = document.createElement("span");
      title.className = "wf-node__title";
      title.textContent = node.name || node.type || node.id;
      var sub = document.createElement("span");
      sub.className = "wf-node__sub";
      sub.textContent = (node.type || "未知类型") + (node.disabled ? " · 已禁用" : "");
      body.appendChild(title);
      body.appendChild(sub);

      var badges = document.createElement("span");
      badges.className = "wf-node__badges";
      var itemsEl = document.createElement("span");
      itemsEl.className = "wf-node__items";
      itemsEl.hidden = true;
      badges.appendChild(itemsEl);

      if (Array.isArray(node.pinData) && node.pinData.length > 0) {
        var pin = document.createElement("span");
        pin.className = "wf-node__pin";
        pin.setAttribute("data-pin", "true");
        pin.setAttribute("aria-label", "已固定数据");
        pin.setAttribute("title", "已固定数据（运行时直接使用这组输出）");
        pin.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M9 4h6l-1 5.5 3.5 3.5h-11l3.5-3.5z"/><path d="M12 13v7"/></svg>';
        badges.appendChild(pin);
      }

      card.appendChild(glyph);
      card.appendChild(body);
      card.appendChild(badges);

      var inputs = inputCountOf(node);
      for (var i = 0; i < inputs; i += 1) card.appendChild(createPort(node, "input", i, inputs));
      var outputs = outputCountOf(node);
      for (var j = 0; j < outputs; j += 1) card.appendChild(createPort(node, "output", j, outputs));

      // Enter 打开节点（Delete 冒泡到画布根节点统一处理）
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          emit("onOpenNode", node.id);
        }
      });

      return card;
    }

    function renderNodes() {
      world.textContent = "";
      state.nodeEls = {};
      for (var i = 0; i < state.nodes.length; i += 1) {
        var node = state.nodes[i];
        var card = buildNodeCard(node);
        world.appendChild(card);
        state.nodeEls[node.id] = card;
      }
      emptyEl.hidden = state.nodes.length > 0;
      applySelectedClasses();
      applyRunStateClasses();
    }

    function syncNodePositions() {
      for (var i = 0; i < state.nodes.length; i += 1) {
        var node = state.nodes[i];
        var card = state.nodeEls[node.id];
        if (!card) continue;
        var position = positionOf(node);
        card.style.left = round(position.x) + "px";
        card.style.top = round(position.y) + "px";
      }
    }

    // ── 连线渲染 ────────────────────────────────────────────────────

    function drawEdges() {
      edgeGroup.textContent = "";
      var byId = indexNodes();
      var connections = state.connections || {};
      var sourceIds = Object.keys(connections);
      for (var s = 0; s < sourceIds.length; s += 1) {
        var sourceId = sourceIds[s];
        var source = byId[sourceId];
        if (!source) continue;
        var ports = connections[sourceId];
        var mains = ports && Array.isArray(ports.main) ? ports.main : [];
        var outputCount = outputCountOf(source);
        var sourcePosition = positionOf(source);
        for (var outputIndex = 0; outputIndex < mains.length; outputIndex += 1) {
          if (outputIndex >= outputCount) continue; // 旧连接引用了不存在的输出口：不画
          var targets = Array.isArray(mains[outputIndex]) ? mains[outputIndex] : [];
          var from = outputPortPoint(sourcePosition, outputIndex, outputCount);
          for (var t = 0; t < targets.length; t += 1) {
            var target = targets[t] || {};
            var targetNode = byId[target.node];
            if (!targetNode) continue;
            var inputCount = inputCountOf(targetNode);
            var inputIndex =
              typeof target.index === "number" && target.index >= 0 ? target.index : 0;
            if (inputIndex >= inputCount) continue;
            var to = inputPortPoint(positionOf(targetNode), inputIndex, inputCount);
            var path = createSvgElement("path");
            path.setAttribute("d", bezierPath(from, to));
            path.setAttribute("class", "wf-edge");
            path.setAttribute("fill", "none");
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("marker-end", "url(#" + markerId + ")");
            path.setAttribute("vector-effect", "non-scaling-stroke");
            path.setAttribute("data-edge-source", sourceId);
            path.setAttribute("data-edge-target", targetNode.id);
            path.setAttribute("data-edge-output", String(outputIndex));
            path.setAttribute("data-edge-input", String(inputIndex));
            var active =
              state.selected.indexOf(sourceId) >= 0 || state.selected.indexOf(targetNode.id) >= 0;
            path.setAttribute("stroke", active ? "#1a1a1a" : "#b9b9b1");
            path.setAttribute("stroke-width", active ? "2" : "1.5");
            edgeGroup.appendChild(path);
          }
        }
      }
      drawTempEdge();
    }

    function drawTempEdge() {
      if (!state.connect) return;
      var from = state.connect.from.point;
      var to = state.connect.hover ? state.connect.hover.point : state.connect.current;
      var path = createSvgElement("path");
      path.setAttribute("d", bezierPath(from, to));
      path.setAttribute("class", "wf-edge wf-edge--temp");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#1a1a1a");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-dasharray", "5 4");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("marker-end", "url(#" + markerId + ")");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      edgeGroup.appendChild(path);
    }

    // ── 手势公共 ────────────────────────────────────────────────────

    function attachGesture(move, up) {
      // 只清理「上一组监听」，不动当前手势状态：调用方通常在 attach 之前就已把
      // drag/box/connect 写进 state，若在这里调 cancelGesture 会把刚建立的手势清掉。
      detachGesture();
      var moveHandler = function (event) {
        move(event);
      };
      var upHandler = function (event) {
        detachGesture();
        up(event);
      };
      window.addEventListener("mousemove", moveHandler);
      window.addEventListener("mouseup", upHandler);
      state.detachGesture = function () {
        window.removeEventListener("mousemove", moveHandler);
        window.removeEventListener("mouseup", upHandler);
        state.detachGesture = null;
      };
    }

    function detachGesture() {
      if (state.detachGesture) state.detachGesture();
    }

    function cancelGesture() {
      detachGesture();
      state.drag = null;
      state.pan = null;
      state.box = null;
      state.connect = null;
      state.gesture = null;
      boxEl.hidden = true;
      root.classList.remove("wf-canvas--panning");
      setActivePort(null);
    }

    // ── 平移 ────────────────────────────────────────────────────────

    function startPan(event) {
      event.preventDefault();
      var startClient = localPoint(event);
      var startViewport = { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom };
      state.pan = { startClient: startClient, startViewport: startViewport };
      root.classList.add("wf-canvas--panning");
      attachGesture(
        function (moveEvent) {
          var point = localPoint(moveEvent);
          state.viewport.x = startViewport.x + (point.x - startClient.x);
          state.viewport.y = startViewport.y + (point.y - startClient.y);
          applyViewport();
        },
        function () {
          state.pan = null;
          root.classList.remove("wf-canvas--panning");
        }
      );
    }

    // ── 选中 ────────────────────────────────────────────────────────

    function selectNode(nodeId, additive) {
      var selected = state.selected.slice();
      var isSelected = selected.indexOf(nodeId) >= 0;
      if (additive) {
        selected = isSelected
          ? selected.filter(function (id) { return id !== nodeId; })
          : selected.concat([nodeId]);
      } else if (!isSelected) {
        selected = [nodeId];
      }
      if (!sameIds(selected, state.selected)) {
        applySelected(selected);
        emit("onSelect", selected.slice());
      }
      return selected;
    }

    // ── 节点拖动 ────────────────────────────────────────────────────

    function startNodeDrag(ids, event) {
      var startClient = localPoint(event);
      var startPositions = {};
      for (var i = 0; i < ids.length; i += 1) {
        var node = state.nodes.filter(function (item) { return item.id === ids[i]; })[0];
        if (!node) continue;
        var position = state.positions[node.id] || node.position || { x: 0, y: 0 };
        startPositions[node.id] = { x: position.x, y: position.y };
      }
      state.drag = {
        ids: ids.slice(),
        startClient: startClient,
        startPositions: startPositions,
        delta: { x: 0, y: 0 },
        moved: false
      };
      attachGesture(
        function (moveEvent) {
          var drag = state.drag;
          if (!drag) return;
          var point = localPoint(moveEvent);
          var delta = {
            x: (point.x - drag.startClient.x) / state.viewport.zoom,
            y: (point.y - drag.startClient.y) / state.viewport.zoom
          };
          if (
            Math.abs(delta.x) > DRAG_THRESHOLD ||
            Math.abs(delta.y) > DRAG_THRESHOLD
          ) {
            drag.moved = true;
          }
          drag.delta = delta;
          if (!drag.moved) return;
          syncNodePositions();
          drawEdges();
        },
        function () {
          var drag = state.drag;
          if (!drag) return;
          if (drag.moved) {
            var moves = [];
            for (var i = 0; i < drag.ids.length; i += 1) {
              var id = drag.ids[i];
              var start = drag.startPositions[id];
              if (!start) continue;
              var next = {
                x: snapToGrid(start.x + drag.delta.x),
                y: snapToGrid(start.y + drag.delta.y)
              };
              state.positions[id] = next;
              moves.push({ id: id, position: { x: next.x, y: next.y } });
            }
            state.drag = null;
            syncNodePositions();
            drawEdges();
            if (moves.length > 0) emit("onMoveNodes", moves);
          } else {
            state.drag = null;
          }
        }
      );
    }

    // ── 端口拖线 ────────────────────────────────────────────────────

    function findNearestInput(point, excludeNodeId) {
      var best = null;
      for (var i = 0; i < state.nodes.length; i += 1) {
        var node = state.nodes[i];
        if (node.id === excludeNodeId) continue;
        var count = inputCountOf(node);
        if (count <= 0) continue;
        var position = positionOf(node);
        var rect = nodeRectAt(position);
        var nearRect =
          point.x >= rect.x - 24 &&
          point.x <= rect.x + rect.width + 24 &&
          point.y >= rect.y - 24 &&
          point.y <= rect.y + rect.height + 24;
        for (var index = 0; index < count; index += 1) {
          var portPoint = inputPortPoint(position, index, count);
          var portDistance = distance(point, portPoint);
          if (!nearRect && portDistance > PORT_HIT_RADIUS) continue;
          if (!best || portDistance < best.distance) {
            best = {
              nodeId: node.id,
              index: index,
              point: portPoint,
              distance: portDistance
            };
          }
        }
      }
      return best;
    }

    function startConnect(portEl, event) {
      var nodeId = portEl.getAttribute("data-node-id");
      var index = Number(portEl.getAttribute("data-port-index")) || 0;
      var node = state.nodes.filter(function (item) { return item.id === nodeId; })[0];
      if (!node) return;
      var from = {
        nodeId: nodeId,
        kind: "output",
        index: index,
        point: outputPortPoint(positionOf(node), index, outputCountOf(node))
      };
      state.connect = {
        from: from,
        current: screenToCanvas(localPoint(event), state.viewport),
        hover: null
      };
      drawEdges();
      attachGesture(
        function (moveEvent) {
          var connect = state.connect;
          if (!connect) return;
          var point = screenToCanvas(localPoint(moveEvent), state.viewport);
          var hover = findNearestInput(point, connect.from.nodeId);
          connect.current = point;
          connect.hover = hover;
          setActivePort(hover);
          drawEdges();
        },
        function () {
          var connect = state.connect;
          state.connect = null;
          setActivePort(null);
          drawEdges();
          if (!connect || !connect.hover) return;
          emit("onConnect", {
            sourceId: connect.from.nodeId,
            sourceOutput: connect.from.index,
            targetId: connect.hover.nodeId,
            targetInput: connect.hover.index
          });
        }
      );
    }

    // ── 框选 ────────────────────────────────────────────────────────

    function startBox(event) {
      var start = screenToCanvas(localPoint(event), state.viewport);
      state.box = { start: start, current: start, additive: event.shiftKey === true };
      boxEl.hidden = false;
      updateBoxElement();
      attachGesture(
        function (moveEvent) {
          var box = state.box;
          if (!box) return;
          box.current = screenToCanvas(localPoint(moveEvent), state.viewport);
          updateBoxElement();
        },
        function () {
          var box = state.box;
          state.box = null;
          boxEl.hidden = true;
          if (!box) return;
          var rect = rectFromPoints(box.start, box.current);
          if (rect.width < 4 && rect.height < 4) {
            // 空白处单击：清空选中（按住 Shift 时保留，方便追加选择）
            if (!box.additive && state.selected.length > 0) {
              applySelected([]);
              emit("onSelect", []);
            }
            return;
          }
          var hits = [];
          for (var i = 0; i < state.nodes.length; i += 1) {
            var node = state.nodes[i];
            if (rectsIntersect(rect, nodeRectAt(positionOf(node)))) hits.push(node.id);
          }
          var selected = box.additive
            ? state.selected.concat(
                hits.filter(function (id) { return state.selected.indexOf(id) < 0; })
              )
            : hits;
          applySelected(selected);
          emit("onSelect", selected.slice());
        }
      );
    }

    function updateBoxElement() {
      var box = state.box;
      if (!box) {
        boxEl.hidden = true;
        return;
      }
      var viewport = state.viewport;
      var left = Math.min(box.start.x, box.current.x) * viewport.zoom + viewport.x;
      var top = Math.min(box.start.y, box.current.y) * viewport.zoom + viewport.y;
      var width = Math.abs(box.start.x - box.current.x) * viewport.zoom;
      var height = Math.abs(box.start.y - box.current.y) * viewport.zoom;
      boxEl.style.left = round(left) + "px";
      boxEl.style.top = round(top) + "px";
      boxEl.style.width = round(width) + "px";
      boxEl.style.height = round(height) + "px";
    }

    // ── 鼠标事件：画布根节点统一分发 ────────────────────────────────

    function onRootMouseDown(event) {
      if (state.destroyed) return;
      if (event.button === 1) {
        // 中键拖 = 平移（阻止浏览器自动滚动）
        startPan(event);
        return;
      }
      if (event.button !== 0) return;
      var target = event.target;
      if (closest(target, "[data-toolbar]")) return; // 工具条按钮自己处理 click

      root.focus();

      if (state.spaceHeld) {
        startPan(event);
        return;
      }

      var portEl = closest(target, "[data-port]");
      if (portEl) {
        event.preventDefault();
        var portNode = closest(portEl, "[data-node-id]");
        var portNodeId = portNode ? portNode.getAttribute("data-node-id") : null;
        if (portEl.getAttribute("data-port-kind") === "output" && !state.readOnly) {
          if (portNodeId) selectNode(portNodeId, event.shiftKey);
          startConnect(portEl, event);
        } else if (portNodeId) {
          selectNode(portNodeId, event.shiftKey);
        }
        return;
      }

      var nodeEl = closest(target, "[data-node-id]");
      if (nodeEl) {
        event.preventDefault();
        var nodeId = nodeEl.getAttribute("data-node-id");
        var selected = selectNode(nodeId, event.shiftKey);
        if (state.readOnly) return;
        // Shift 把节点从选中里去掉时不再启动拖动
        if (selected.indexOf(nodeId) < 0) return;
        startNodeDrag(selected, event);
        return;
      }

      startBox(event);
    }

    function onRootDoubleClick(event) {
      if (state.destroyed) return;
      var target = event.target;
      if (closest(target, "[data-toolbar]")) return;
      var nodeEl = closest(target, "[data-node-id]");
      if (nodeEl) {
        emit("onOpenNode", nodeEl.getAttribute("data-node-id"));
        return;
      }
      if (state.readOnly) return;
      var point = screenToCanvas(localPoint(event), state.viewport);
      emit("onRequestAddNode", { x: Math.round(point.x), y: Math.round(point.y) });
    }

    function onWheel(event) {
      if (state.destroyed) return;
      event.preventDefault();
      var point = localPoint(event);
      // 指数曲线：滚一格（deltaY≈100）大约缩放 1.16，手感与常见画布一致
      var factor = Math.exp(-(event.deltaY || 0) * 0.0015);
      zoomAt(point, factor);
    }

    // ── 键盘 ────────────────────────────────────────────────────────

    function onRootKeyDown(event) {
      if (state.destroyed) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (isEditableTarget(event.target)) return;
        if (state.readOnly) return;
        if (state.selected.length === 0) return;
        event.preventDefault();
        emit("onRequestDelete", state.selected.slice());
        return;
      }
      if (event.key === "Escape") {
        if (state.connect || state.box) {
          event.preventDefault();
          cancelGesture();
          drawEdges();
        }
      }
    }

    function onWindowKeyDown(event) {
      if (state.destroyed) return;
      if (event.key === " " || event.code === "Space") {
        if (isEditableTarget(event.target)) return;
        state.spaceHeld = true;
        root.classList.add("wf-canvas--space");
      }
    }

    function onWindowKeyUp(event) {
      if (state.destroyed) return;
      if (event.key === " " || event.code === "Space") {
        state.spaceHeld = false;
        root.classList.remove("wf-canvas--space");
      }
    }

    // ── 缩放/适配 ───────────────────────────────────────────────────

    function zoomAt(anchor, factor) {
      var viewport = state.viewport;
      var nextZoom = clampZoom(viewport.zoom * factor);
      if (nextZoom === viewport.zoom) return;
      var canvasPoint = screenToCanvas(anchor, viewport);
      viewport.zoom = nextZoom;
      viewport.x = anchor.x - canvasPoint.x * nextZoom;
      viewport.y = anchor.y - canvasPoint.y * nextZoom;
      applyViewport();
    }

    function zoomBy(factor) {
      var numeric = Number(factor);
      if (!isFinite(numeric) || numeric <= 0) return api;
      var size = measure();
      zoomAt({ x: size.width / 2, y: size.height / 2 }, numeric);
      return api;
    }

    function fit() {
      var size = measure();
      if (state.nodes.length === 0) {
        state.viewport = { x: 0, y: 0, zoom: 1 };
        applyViewport();
        return api;
      }
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      for (var i = 0; i < state.nodes.length; i += 1) {
        var node = state.nodes[i];
        var position = state.positions[node.id] || node.position || { x: 0, y: 0 };
        var rect = nodeRectAt(position);
        if (rect.x < minX) minX = rect.x;
        if (rect.y < minY) minY = rect.y;
        if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
        if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
      }
      var width = Math.max(1, maxX - minX);
      var height = Math.max(1, maxY - minY);
      var zoom = clampZoom(
        Math.min(
          (size.width - FIT_PADDING * 2) / width,
          (size.height - FIT_PADDING * 2) / height,
          MAX_FIT_ZOOM
        )
      );
      state.viewport = {
        x: size.width / 2 - (minX + width / 2) * zoom,
        y: size.height / 2 - (minY + height / 2) * zoom,
        zoom: zoom
      };
      applyViewport();
      return api;
    }

    // ── 实例 API ────────────────────────────────────────────────────

    function setWorkflow(workflow) {
      var source = workflow && typeof workflow === "object" ? workflow : {};
      var nodes = Array.isArray(source.nodes) ? source.nodes : [];
      state.nodes = [];
      state.positions = {};
      for (var i = 0; i < nodes.length; i += 1) {
        var raw = nodes[i];
        if (!raw || typeof raw !== "object" || !raw.id) continue;
        var position = raw.position && typeof raw.position === "object" ? raw.position : { x: 0, y: 0 };
        var node = {
          id: String(raw.id),
          name: typeof raw.name === "string" ? raw.name : String(raw.id),
          type: typeof raw.type === "string" ? raw.type : "",
          disabled: raw.disabled === true,
          pinData: Array.isArray(raw.pinData) ? raw.pinData : undefined,
          parameters: raw.parameters && typeof raw.parameters === "object" ? raw.parameters : undefined,
          inputs: raw.inputs,
          outputs: raw.outputs,
          position: {
            x: typeof position.x === "number" && isFinite(position.x) ? position.x : 0,
            y: typeof position.y === "number" && isFinite(position.y) ? position.y : 0
          }
        };
        state.nodes.push(node);
        state.positions[node.id] = { x: node.position.x, y: node.position.y };
      }
      state.connections =
        source.connections && typeof source.connections === "object" ? source.connections : {};
      // 已不存在的节点从选中里剔除，避免 Delete 回调带上幽灵 id
      state.selected = state.selected.filter(function (id) {
        return state.positions[id] !== undefined;
      });
      state.drag = null;
      state.connect = null;
      state.box = null;
      renderNodes();
      applyViewport();
      return api;
    }

    function setSelected(ids) {
      applySelected(Array.isArray(ids) ? ids : []);
      return api;
    }

    function setRunState(map) {
      state.runState = map && typeof map === "object" ? map : {};
      applyRunStateClasses();
      return api;
    }

    function setReadOnly(readOnly) {
      state.readOnly = readOnly === true;
      root.classList.toggle("wf-canvas--readonly", state.readOnly);
      root.setAttribute("aria-readonly", state.readOnly ? "true" : "false");
      return api;
    }

    function getViewport() {
      return { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom };
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      cancelGesture();
      root.removeEventListener("mousedown", onRootMouseDown);
      root.removeEventListener("dblclick", onRootDoubleClick);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("keydown", onRootKeyDown);
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      if (root.parentNode === container) container.removeChild(root);
    }

    var api = {
      setWorkflow: setWorkflow,
      setSelected: setSelected,
      setRunState: setRunState,
      setReadOnly: setReadOnly,
      fit: fit,
      zoomBy: zoomBy,
      getViewport: getViewport,
      destroy: destroy
    };

    // ── 事件绑定与首帧 ──────────────────────────────────────────────

    root.addEventListener("mousedown", onRootMouseDown);
    root.addEventListener("dblclick", onRootDoubleClick);
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("keydown", onRootKeyDown);
    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);

    renderNodes();
    applyViewport();

    return api;
  }

  global.WFCanvas = { mount: mount };
})(typeof window !== "undefined" ? window : this);
