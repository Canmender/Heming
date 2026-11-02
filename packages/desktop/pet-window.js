"use strict";

/**
 * 桌宠窗口的入口判定、几何计算与窗口参数（纯函数，可在 node:test 里直接断言）。
 *
 * 桌宠是独立于主窗口存在的透明置顶窗：透明、无边框、不占任务栏、且**默认鼠标穿透**。
 *
 * ★ 这里不 require("electron")：窗口参数由本文件算好，创建动作留给 main.js。
 *   main.test.js 会 require 本模块，一旦引入 electron 就会在纯 Node 下炸掉。
 */

/** 桌宠窗口的 query 标记（与 packages/web/src/lib/petWindow.ts 的 hemingWindow 对齐）。 */
const PET_WINDOW_FLAG = "hemingWindow=pet";

/** 缩放档位：固定档位而非自由缩放，避免用户拉出一个糊掉的非整数尺寸。 */
const PET_SCALES = Object.freeze([0.6, 0.8, 1.0, 1.25, 1.5]);
const DEFAULT_SCALE = 1.0;

/** 基准窗口尺寸（scale=1）：半身立绘的竖版比例。 */
const BASE_WIDTH = 300;
const BASE_HEIGHT = 420;

/** 默认落位距工作区右/下边缘的距离。 */
const EDGE_MARGIN = 24;

/** 桌宠窗口的最小可见面积（比主窗口宽松：它本来就小）。 */
const MIN_VISIBLE_WIDTH = 60;
const MIN_VISIBLE_HEIGHT = 80;

/** 默认模型（相对 web 产物根目录）。 */
const DEFAULT_MODEL_PATH = "pet/Hiyori/Hiyori.model3.json";

/**
 * 两个地址是否属于同一个应用源。
 *
 * 自定义 scheme（`app://heming`）走不了 URL 解析——非特殊 scheme 的 origin 是 "null"，
 * 拿去比较必然不命中，所以按「去掉 query/hash 后比对前缀」。
 */
function isSameAppOrigin(url, appOrigin) {
  if (typeof url !== "string" || !url) return false;
  if (typeof appOrigin !== "string" || !appOrigin) return false;
  if (appOrigin.startsWith("app://")) {
    const bare = appOrigin.replace(/\/$/, "");
    const base = url.split("?")[0].split("#")[0].replace(/\/$/, "");
    return base === bare || base.startsWith(bare + "/");
  }
  try {
    return new URL(url).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * 是否为主窗口内部弹出的桌宠窗口。
 * 判定条件（同时满足）：与主窗口同应用源 + query 里带 `hemingWindow=pet`。
 */
function isPetWindowUrl(url, appOrigin) {
  if (typeof url !== "string" || !url.includes(PET_WINDOW_FLAG)) return false;
  return isSameAppOrigin(url, appOrigin);
}

/** 把任意输入夹到最近的档位；非法值回落默认档。 */
function normalizeScale(value) {
  // ★ 不能直接 Number(value)：Number(null) 与 Number([]) 都是 0，会被"最接近的档位"
  //   算成 0.6 —— 一个缺失字段会悄悄把桌宠缩到最小档。只接受数字与非空数字字符串。
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return DEFAULT_SCALE;
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  let best = PET_SCALES[0];
  let bestDiff = Math.abs(n - best);
  for (const s of PET_SCALES) {
    const diff = Math.abs(n - s);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

/** 档位切换：dir > 0 放大一档，dir < 0 缩小一档，两端夹住（不循环）。 */
function nextScale(current, dir) {
  const cur = normalizeScale(current);
  const idx = PET_SCALES.indexOf(cur);
  const step = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  const next = Math.min(PET_SCALES.length - 1, Math.max(0, idx + step));
  return PET_SCALES[next];
}

/** 由缩放推导窗口像素尺寸（整数，避免 0.5px 造成的模糊渲染）。 */
function petWindowSize(scale) {
  const s = normalizeScale(scale);
  return {
    width: Math.round(BASE_WIDTH * s),
    height: Math.round(BASE_HEIGHT * s),
  };
}

/** 默认位置：工作区右下角，距右/下各 EDGE_MARGIN。 */
function defaultPetPosition(workArea, size) {
  const area =
    workArea && Number.isFinite(workArea.x) && Number.isFinite(workArea.y)
      ? workArea
      : { x: 0, y: 0, width: 1280, height: 800 };
  const w = size && Number.isFinite(size.width) ? size.width : BASE_WIDTH;
  const h = size && Number.isFinite(size.height) ? size.height : BASE_HEIGHT;
  return {
    x: Math.round(area.x + area.width - w - EDGE_MARGIN),
    y: Math.round(area.y + area.height - h - EDGE_MARGIN),
  };
}

function overlapOf(bounds, area) {
  const left = Math.max(bounds.x, area.x);
  const top = Math.max(bounds.y, area.y);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  return { width: right - left, height: bottom - top };
}

/** 至少要有一块够大的面积落在某个工作区里，否则视为「拖丢了」。 */
function isOnVisibleDisplay(bounds, workAreas) {
  if (!Array.isArray(workAreas) || workAreas.length === 0) return true;
  return workAreas.some((area) => {
    if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y)) return false;
    if (!Number.isFinite(area.width) || !Number.isFinite(area.height)) return false;
    const o = overlapOf(bounds, area);
    return o.width >= MIN_VISIBLE_WIDTH && o.height >= MIN_VISIBLE_HEIGHT;
  });
}

/**
 * 归一化持久化的桌宠状态：结构合法 + 落在可见显示器内才复用，否则回落默认落位。
 *
 * @param {unknown} raw 从 pet-state.json 读到的对象（可能损坏）
 * @param {Array} workAreas `screen.getAllDisplays().map(d => d.workArea)`
 * @param {{x,y,width,height}} primaryArea 主显示器工作区（回落时用）
 */
function clampPetState(raw, workAreas, primaryArea) {
  const input = raw && typeof raw === "object" ? raw : {};
  const scale = normalizeScale(input.scale);
  const size = petWindowSize(scale);
  const fallback = defaultPetPosition(primaryArea, size);

  let bounds = null;
  const b = input.bounds;
  if (
    b &&
    typeof b === "object" &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height)
  ) {
    const candidate = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: size.width,
      height: size.height,
    };
    if (isOnVisibleDisplay(candidate, workAreas)) bounds = candidate;
  }
  if (!bounds) {
    bounds = { x: fallback.x, y: fallback.y, width: size.width, height: size.height };
  }

  return {
    scale,
    bounds,
    // 上次退出时是否隐藏：重启后不自动弹出（用户明确关掉的东西不该自己回来）
    visible: input.visible === true,
  };
}

/**
 * 模型路径白名单：只接受相对 web 产物根目录的路径。
 *
 * 为什么不用绝对的路径拼接：这个字符串最终会进 `app://heming/...` 的 URL，
 * 一旦允许 `..` 或盘符，就等于给渲染层留了一个读任意文件的入口
 * （app-protocol.js 虽有路径穿越防护，但这里不该依赖下游兜底）。
 */
function sanitizeModelPath(input) {
  if (typeof input !== "string") return DEFAULT_MODEL_PATH;
  const raw = input.trim();
  if (!raw) return DEFAULT_MODEL_PATH;
  // 绝对路径直接拒绝：不能先剥掉前导斜杠再当相对路径用——那会把 /etc/x.model3.json
  // 变成 etc/x.model3.json，看着"已在根内"，实际指向一个本不该被寻址的位置。
  if (raw.startsWith("/") || raw.startsWith("\\")) return DEFAULT_MODEL_PATH;
  // 统一分隔符后逐段校验：不允许空段、`.`、`..`，也不允许盘符/协议前缀
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.includes(":") || normalized.includes("//")) return DEFAULT_MODEL_PATH;
  const parts = normalized.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return DEFAULT_MODEL_PATH;
  // 必须是 .model3.json 或 .model.json（Cubism 3/4 与 2.1 两种约定）
  if (!/\.model3?\.json$/i.test(normalized)) return DEFAULT_MODEL_PATH;
  // 字符白名单：中文目录名也放行（用户可能自己命名），但排除控制符与引号
  if (!/^[\p{L}\p{N}\-_. /]+$/u.test(normalized)) return DEFAULT_MODEL_PATH;
  if (normalized.length > 200) return DEFAULT_MODEL_PATH;
  return normalized;
}

/**
 * 桌宠窗口参数。
 *
 * ★ `backgroundThrottling:false`：置顶窗口被别的窗口完全遮挡时，Chromium 会判定它
 *   不可见并暂停 rAF/定时器——表现是「切走再回来，角色卡在上一帧」。与 splash 同源问题。
 *
 * ★ `hasShadow:false`：透明无边框窗口画阴影会在角色周围留一圈灰边。
 *
 * ★ 不设 `focusable:false`：用户点角色要输入文字，窗口必须能拿到焦点。
 *   首次显示用 showInactive() 避免抢走用户正在打字的焦点。
 */
function petWindowOptions(state) {
  const s = state && typeof state === "object" ? state : {};
  const scale = normalizeScale(s.scale);
  const size = petWindowSize(scale);
  const bounds = s.bounds && typeof s.bounds === "object" ? s.bounds : {};
  const x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0;
  const y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0;

  return {
    x,
    y,
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    title: "桌宠",
    autoHideMenuBar: true,
    webPreferences: {
      preload: s.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
}

/**
 * 由主窗口的加载地址拼出桌宠窗口地址。
 *
 * 桌宠是**独立 HTML 入口**（`pet.html`，Vite 多入口产出）：这样那个常驻的 300×420
 * 透明窗口只加载 pixi + Live2D 自己的代码，不背整个应用 bundle。
 * 所以这里要把入口文件名换掉，而不是简单挂个 query。
 *
 * 各种输入形态都要能处理：
 *   app://heming/index.html  → app://heming/pet.html?hemingWindow=pet
 *   app://heming/            → app://heming/pet.html?hemingWindow=pet
 *   app://heming             → app://heming/pet.html?hemingWindow=pet
 *   http://host/sub/         → http://host/sub/pet.html?hemingWindow=pet
 * 原有 query 保留（hash 丢弃：它在这里没有意义，拼在 hash 后面也不进 query）。
 */
function petUrl(baseUrl) {
  const raw = typeof baseUrl === "string" && baseUrl ? baseUrl : "app://heming/index.html";
  const withoutHash = raw.split("#")[0];
  const qIdx = withoutHash.indexOf("?");
  let pathPart = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const query = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : "";

  // 去掉末尾的 html 入口文件名（index.html / 任意 .html），换成 pet.html
  pathPart = pathPart.replace(/\/[^/]*\.html?$/i, "/");
  if (!pathPart.endsWith("/")) pathPart += "/";

  const params = new URLSearchParams(query);
  params.set("hemingWindow", "pet");
  return `${pathPart}pet.html?${params.toString()}`;
}

/**
 * 拖拽时的窗口目标位置。
 *
 * ★ 坐标系真相只有一个：渲染层上报的 `clientX/clientY` 会随窗口移动而失真
 *   （窗口本身在动，同一个屏幕点在渲染层里的坐标每帧都不一样），所以拖拽起点记的是
 *   **屏幕光标坐标**（screen.getCursorScreenPoint）与**当时的窗口原点**，
 *   位移 = 当前屏幕光标 - 起点屏幕光标。
 *
 * @param {{cursorX:number,cursorY:number,windowX:number,windowY:number}} origin
 * @param {{x:number,y:number}} cursor 当前屏幕光标
 */
function draggedPosition(origin, cursor) {
  if (!origin || typeof origin !== "object") return null;
  if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return null;
  const { cursorX, cursorY, windowX, windowY } = origin;
  if (![cursorX, cursorY, windowX, windowY].every(Number.isFinite)) return null;
  return {
    x: Math.round(windowX + (cursor.x - cursorX)),
    y: Math.round(windowY + (cursor.y - cursorY)),
  };
}

/**
 * 解析桌宠状态文件的文本。
 *
 * ★ 必须剥掉 UTF-8 BOM：Windows 上用 PowerShell / 记事本存过的 JSON 常带 BOM，
 *   而 `JSON.parse` 对 BOM 直接抛错——被上层 catch 吞掉后表现为
 *   「桌宠明明该显示却不出现」，且没有任何提示。这是真机上踩过的坑。
 */
function parsePetStateJson(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null; // 损坏：交给 clampPetState 回落默认
  }
}

module.exports = {
  PET_WINDOW_FLAG,
  PET_SCALES,
  DEFAULT_SCALE,
  BASE_WIDTH,
  BASE_HEIGHT,
  EDGE_MARGIN,
  DEFAULT_MODEL_PATH,
  isSameAppOrigin,
  isPetWindowUrl,
  normalizeScale,
  nextScale,
  petWindowSize,
  defaultPetPosition,
  isOnVisibleDisplay,
  clampPetState,
  sanitizeModelPath,
  petWindowOptions,
  petUrl,
  draggedPosition,
  parsePetStateJson,
};
