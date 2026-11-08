"use strict";

/**
 * 界面插件（desktopWidget）的规格归一化、入口判定与几何计算（纯函数，不 require electron）。
 *
 * 由 d.46 的 `pet-window.js` 泛化而来（d.98）：桌宠当时是"写死的一个窗口"，
 * 现在是"清单声明的一类窗口"——尺寸、缩放档位、透明/置顶/穿透、位置边距全部来自
 * `plugin.json` 的 `contributions.desktopWidgets[0]`，本文件负责把那份 JSON 归一化成
 * 宿主敢直接用的 spec，并把 pet 时代的几何语义**逐条保留**：
 * 固定档位而非自由缩放、默认落位贴工作区右下角、拖拽收尾先吸附再钳制、
 * 至少留一块可见区域能拖回来、状态文件剥 BOM。
 *
 * ★ 为什么主进程还要再校验一遍清单：清单在 web 侧已过 zod，但落盘后的
 *   `plugin.json` 是**用户机器上的文件**，第三方可以改；主进程只按自己这份
 *   "能做什么" 的判断建窗口与放 CSP，不信任落盘内容（纵深防御）。
 *
 * ★ 这里不 require("electron")：`main.test.js` 会 require 本模块，引入 electron
 *   会在纯 Node 下炸掉（与 pet-window.js 同一取舍）。
 */

/** widget 窗口的 URL scheme：`widget://<pluginId>/<entry>`，每个插件独立 origin。 */
const WIDGET_SCHEME = "widget";

/** 一个插件本轮只允许 1 个 widget（规格 §2.3）。 */
const MAX_WIDGETS_PER_PLUGIN = 1;

const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/**
 * 插件 id（清单 `id`，含点，如 `heming.pet`）：`widget://` 的 host 段就是它，
 * 所以这里必须允许点——URL host 允许点，而 widget 自己的 id 不允许（便于拼状态文件名）。
 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WIDGET_NAME_MAX = 32;
const WIDGET_ENTRY_MAX = 200;
const MIN_WIDGET_SIZE = 96;
const MAX_WIDGET_SIZE = 1024;
const MAX_SCALES = 6;
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;
const ICON_MAX_BYTES = 256 * 1024;

/** 缩放档位缺省：单档 1.0（插件没声明 scales 时就是固定尺寸）。 */
const DEFAULT_SCALES = Object.freeze([1]);
const DEFAULT_SCALE = 1;

/** 默认位置：工作区右下角，距右/下各 EDGE_MARGIN（pet 时代的口径）。 */
const EDGE_MARGIN = 24;
const MAX_MARGIN = 200;

/** 窗口最小可见面积（与外层持久化校验同一口径）。 */
const MIN_VISIBLE_WIDTH = 60;
const MIN_VISIBLE_HEIGHT = 80;

/** 拖拽收尾时贴到工作区边缘的吸附阈值（像素）。 */
const SNAP_PX = 12;

/** 托盘菜单可声明的项（宿主渲染，插件只能选，不能自定义）。 */
const TRAY_ITEMS = Object.freeze(["toggle", "clickThrough", "resetPosition", "settings", "scaleUp", "scaleDown"]);
const DEFAULT_TRAY_ITEMS = Object.freeze(["toggle", "clickThrough", "resetPosition", "settings"]);

/** 设置表单支持的字段类型（规格 §2.3）。 */
const SETTINGS_FIELD_TYPES = Object.freeze(["boolean", "select", "text", "number", "agent"]);

/** 气泡/跳转可直达的主窗口页面（与命令面板页面目录子集对齐；白名单在进程边界上判）。 */
const WIDGET_PAGE_ALLOWLIST = Object.freeze(["settings", "team", "tasks", "staff", "infohub"]);

/**
 * 归一化一个包内相对路径（entry / icon / tray.icon 共用）。
 *
 * 拒绝：非字符串、空、绝对路径、协议前缀、`..`/`.` 段、反斜杠、NUL、超长。
 * 这里不依赖下游 app-protocol 的防穿越——一个坏 entry 会让 `loadURL` 指到包外。
 *
 * @returns {string|null} 归一化后的 POSIX 相对路径
 */
function normalizeRelativeAssetPath(raw, maxLength = WIDGET_ENTRY_MAX) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > maxLength) return null;
  if (text.includes("\0") || text.includes("\\")) return null;
  if (text.startsWith("/") || text.startsWith("//")) return null;
  // 协议前缀（http:、widget:、file: …）：entry 只能是包内相对路径
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  const parts = text.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** 归一化缩放档位数组：1–6 档、递增、0.5–2、≤2 位小数；非法返回 null。 */
function normalizeScales(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_SCALES];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCALES) return null;
  const scales = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value < SCALE_MIN || value > SCALE_MAX) return null;
    if (Math.round(value * 100) !== value * 100) return null; // 超过两位小数
    if (scales.length > 0 && value <= scales[scales.length - 1]) return null; // 必须严格递增
    scales.push(value);
  }
  return scales;
}

/** 把任意输入夹到最近的档位；非法值回落该 widget 的默认档。 */
function normalizeScale(spec, value) {
  const scales = scalesOf(spec);
  const fallback = defaultScaleOf(spec);
  // ★ 不能直接 Number(value)：Number(null) 与 Number([]) 都是 0，会被"最接近的档位"
  //   算成最小档 —— 一个缺失字段会悄悄把窗口缩到最小。
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  let best = scales[0];
  let bestDiff = Math.abs(n - best);
  for (const s of scales) {
    const diff = Math.abs(n - s);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

function scalesOf(spec) {
  const scales = spec && Array.isArray(spec.scales) && spec.scales.length > 0 ? spec.scales : DEFAULT_SCALES;
  return scales;
}

function defaultScaleOf(spec) {
  const scales = scalesOf(spec);
  const wanted = spec && Number.isFinite(spec.defaultScale) ? spec.defaultScale : DEFAULT_SCALE;
  return scales.includes(wanted) ? wanted : scales[0];
}

/** 档位切换：dir > 0 放大一档，dir < 0 缩小一档，两端夹住（不循环）。 */
function nextScale(spec, current, dir) {
  const scales = scalesOf(spec);
  const cur = normalizeScale(spec, current);
  const idx = Math.max(0, scales.indexOf(cur));
  const step = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  return scales[Math.min(scales.length - 1, Math.max(0, idx + step))];
}

/** 由缩放推导窗口像素尺寸（整数，避免 0.5px 造成的模糊渲染）。 */
function widgetWindowSize(spec, scale) {
  const s = normalizeScale(spec, scale);
  const base = baseSizeOf(spec);
  return { width: Math.round(base.width * s), height: Math.round(base.height * s) };
}

function baseSizeOf(spec) {
  const width = spec && Number.isFinite(spec.width) ? spec.width : MIN_WIDGET_SIZE;
  const height = spec && Number.isFinite(spec.height) ? spec.height : MIN_WIDGET_SIZE;
  return { width, height };
}

function marginOf(spec) {
  const margin = spec && spec.position && Number.isFinite(spec.position.margin) ? spec.position.margin : EDGE_MARGIN;
  return Math.min(MAX_MARGIN, Math.max(0, margin));
}

/** 默认位置：工作区右下角，距右/下各 margin。 */
function defaultWidgetPosition(spec, workArea, size) {
  const area =
    workArea && Number.isFinite(workArea.x) && Number.isFinite(workArea.y)
      ? workArea
      : { x: 0, y: 0, width: 1280, height: 800 };
  const base = baseSizeOf(spec);
  const w = size && Number.isFinite(size.width) ? size.width : base.width;
  const h = size && Number.isFinite(size.height) ? size.height : base.height;
  const margin = marginOf(spec);
  return {
    x: Math.round(area.x + area.width - w - margin),
    y: Math.round(area.y + area.height - h - margin),
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
 * 归一化持久化的 widget 状态（`state.json`）：结构合法 + 落在可见显示器内才复用，
 * 否则回落默认落位。与 pet 时代 `clampPetState` 语义一致，只是尺寸/档位来自 spec。
 *
 * @param {object} spec 归一化后的 desktopWidget
 * @param {unknown} raw `state.json` 解析出来的对象（可能损坏）
 * @param {Array} workAreas `screen.getAllDisplays().map(d => d.workArea)`
 * @param {{x,y,width,height}} primaryArea 主显示器工作区（回落时用）
 */
function clampWidgetState(spec, raw, workAreas, primaryArea) {
  const input = raw && typeof raw === "object" ? raw : {};
  const scale = normalizeScale(spec, input.scale);
  const size = widgetWindowSize(spec, scale);
  const fallback = defaultWidgetPosition(spec, primaryArea, size);

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
 * widget 窗口参数。
 *
 * ★ `backgroundThrottling:false`：置顶透明窗被别的窗口完全遮挡时 Chromium 会判定它
 *   不可见并暂停 rAF/定时器——表现是「切走再回来，角色卡在上一帧」。隐藏时由宿主
 *   显式暂停渲染（plugin-host 的 setPaused），**不能**靠 backgroundThrottling 节流，
 *   否则透明窗首帧卡顿的已知问题会回来。
 * ★ `hasShadow:false` + 无边框：透明窗画阴影会在角色周围留一圈灰边。
 * ★ 不设 `focusable:false`：用户点角色要输入文字，窗口必须能拿到焦点；
 *   首次显示用 showInactive() 避免抢走用户正在打字的焦点。
 */
function widgetWindowOptions(spec, state, preloadPath) {
  const s = state && typeof state === "object" ? state : {};
  const scale = normalizeScale(spec, s.scale);
  const size = widgetWindowSize(spec, scale);
  const bounds = s.bounds && typeof s.bounds === "object" ? s.bounds : {};
  const x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0;
  const y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0;
  const transparent = spec && spec.transparent === true;
  const alwaysOnTop = spec && spec.alwaysOnTop === true;
  const skipTaskbar = !spec || spec.skipTaskbar !== false;
  const resizable = spec ? spec.resizable === true : false;

  return {
    x,
    y,
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    transparent,
    resizable,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar,
    hasShadow: false,
    backgroundColor: transparent ? "#00000000" : "#000000",
    alwaysOnTop,
    title: (spec && spec.name) || "桌面小组件",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
}

/**
 * widget 入口地址：`widget://<pluginId>/<entry>`。
 *
 * 独立 origin 是这条设计的**安全基石**：widget 页读不到 `app://heming` 的
 * localStorage（会话、记忆、偏好都在那儿），也拿不到主窗的任何同源凭据。
 */
function widgetUrl(pluginId, entry) {
  const id = typeof pluginId === "string" ? pluginId.trim().toLowerCase() : "";
  const path = normalizeRelativeAssetPath(entry);
  if (!PLUGIN_ID_RE.test(id) || !path) return null;
  return `${WIDGET_SCHEME}://${id}/${path}`;
}

/** 是否为某个插件自己的页面（导航闸用：不许离开本插件的 origin）。 */
function isSameWidgetOrigin(url, pluginId) {
  if (typeof url !== "string" || !url) return false;
  const id = typeof pluginId === "string" ? pluginId.trim().toLowerCase() : "";
  if (!PLUGIN_ID_RE.test(id)) return false;
  const prefix = `${WIDGET_SCHEME}://${id}`;
  const bare = url.split("?")[0].split("#")[0].toLowerCase();
  return bare === prefix || bare.startsWith(`${prefix}/`);
}

/**
 * 拖拽时的窗口目标位置。
 *
 * ★ 坐标系真相只有一个：渲染层上报的 `clientX/clientY` 会随窗口移动而失真
 *   （窗口本身在动，同一个屏幕点在渲染层里的坐标每帧都不一样），所以拖拽起点记的是
 *   **屏幕光标坐标**（screen.getCursorScreenPoint）与**当时的窗口原点**，
 *   位移 = 当前屏幕光标 - 起点屏幕光标。
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
 * 拖拽收尾的窗口位置：**先吸附、再钳制**。
 *
 * 收尾要单独算一次：拖拽过程中窗口跟着光标走（可以短暂出屏），抬起时若原样停住，
 * 用户会遇到两个问题——贴着屏幕边缘时永远差几像素（视觉上"没贴住"），以及拖得太狠后
 * 窗口留在屏幕外、再也点不回来（位置还会被持久化，重启也回不来）。
 *
 * 规则：
 * 1. 选**重叠面积最大**的工作区作为目标（多显示器：吸到当前所在那块屏的边缘）；
 *    完全出屏时改选最近的一块，保证能拖回来。
 * 2. 四条边各自判断：距离 ≤ SNAP_PX 就把窗口贴到该边。
 * 3. 两个方向都钳制「至少留 MIN_VISIBLE_* 露在工作区内」——与 isOnVisibleDisplay
 *    同一口径，因此收尾后的位置一定能通过重启校验。
 */
function settleWidgetPosition(spec, pos, size, workAreas) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  const base = baseSizeOf(spec);
  const width = size && Number.isFinite(size.width) && size.width > 0 ? size.width : base.width;
  const height = size && Number.isFinite(size.height) && size.height > 0 ? size.height : base.height;
  const start = { x: Math.round(pos.x), y: Math.round(pos.y) };
  const areas = Array.isArray(workAreas)
    ? workAreas.filter(
        (area) =>
          area &&
          Number.isFinite(area.x) &&
          Number.isFinite(area.y) &&
          Number.isFinite(area.width) &&
          Number.isFinite(area.height),
      )
    : [];
  // 拿不到显示器信息（测试/异形环境）：只保证坐标是整数，不做裁剪
  if (areas.length === 0) return start;

  const bounds = { x: start.x, y: start.y, width, height };
  let target = null;
  let bestOverlap = -1;
  for (const area of areas) {
    const overlap = overlapOf(bounds, area);
    const score = Math.max(0, overlap.width) * Math.max(0, overlap.height);
    if (score > bestOverlap) {
      bestOverlap = score;
      target = area;
    }
  }
  if (!target || bestOverlap <= 0) {
    let bestDistance = Infinity;
    for (const area of areas) {
      const dx = start.x + width / 2 - (area.x + area.width / 2);
      const dy = start.y + height / 2 - (area.y + area.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        target = area;
      }
    }
  }

  return {
    x: clampToVisible(
      snapToEdge(start.x, width, target.x, target.width),
      width,
      target.x,
      target.width,
      MIN_VISIBLE_WIDTH,
    ),
    y: clampToVisible(
      snapToEdge(start.y, height, target.y, target.height),
      height,
      target.y,
      target.height,
      MIN_VISIBLE_HEIGHT,
    ),
  };
}

/** 一维吸附：起点贴工作区起点或窗口末端贴工作区末端，取更近的那条边。 */
function snapToEdge(start, size, areaStart, areaSize) {
  const toStart = Math.abs(start - areaStart);
  const toEnd = Math.abs(start + size - (areaStart + areaSize));
  if (toStart <= SNAP_PX && toStart <= toEnd) return areaStart;
  if (toEnd <= SNAP_PX) return areaStart + areaSize - size;
  return start;
}

/**
 * 一维钳制：窗口起点夹到「右/下边至少露出 minVisible」与「左/上边至少露出 minVisible」
 * 之间。窗口比工作区还小时，两个约束都成立，拖出屏幕后仍能抓住一块。
 */
function clampToVisible(start, size, areaStart, areaSize, minVisible) {
  const need = Math.min(minVisible, size);
  const lower = areaStart + need - size;
  const upper = areaStart + areaSize - need;
  if (lower > upper) return areaStart; // 工作区连两块最小可见都放不下：贴齐起点兜底
  return Math.min(upper, Math.max(lower, start));
}

/**
 * 解析状态文件文本（`state.json`）。
 *
 * ★ 必须剥掉 UTF-8 BOM：Windows 上用 PowerShell / 记事本存过的 JSON 常带 BOM，
 *   而 `JSON.parse` 对 BOM 直接抛错——被上层 catch 吞掉后表现为「窗口明明该显示却不出现」。
 *   这是真机上踩过的坑（pet 时代的状态文件），迁移到插件目录后仍会遇到。
 */
function parseWidgetStateJson(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null; // 损坏：交给 clampWidgetState 回落默认
  }
}

/**
 * 归一化「打开哪一页」的载荷（widget 的 openPage）。
 *
 * 兼容三种形状：`undefined`/无参（→ null，调用方按「打开设置」处理）、字符串 page、
 * `{ page }`；不在白名单里一律回落 null。白名单在进程边界上判，不信任渲染层。
 */
function normalizeWidgetPage(raw) {
  const value =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw.page
        : undefined;
  if (typeof value !== "string") return null;
  return WIDGET_PAGE_ALLOWLIST.includes(value) ? value : null;
}

/* ────────────────────── 清单里的 desktopWidget 归一化 ────────────────────── */

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asInt(value) {
  return Number.isInteger(value) ? value : null;
}

/**
 * 归一化一个 `desktopWidgets[i]`（来自落盘的 plugin.json）。
 *
 * 返回 `{ ok, errors, spec }`：`errors` 是可直接展示的中文（带字段路径），
 * `spec` 只在 `ok: true` 时才可被宿主使用。**任何一项不合法都拒绝**，
 * 不做「尽量猜」——一个坏 entry 就是一个加载不出来的透明窗。
 *
 * @param {unknown} raw
 * @param {number} [index] 用于错误路径
 */
function normalizeWidgetSpec(raw, index = 0) {
  const errors = [];
  const at = `desktopWidgets[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`${at} 必须是对象`], spec: null };
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!WIDGET_ID_RE.test(id)) {
    errors.push(`${at}.id 只能用小写字母、数字、连字符（≤32，以字母或数字开头）`);
  }

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id || "桌面小组件";
  if (name.length > WIDGET_NAME_MAX) errors.push(`${at}.name 最多 ${WIDGET_NAME_MAX} 字`);

  const entry = normalizeRelativeAssetPath(raw.entry);
  if (!entry || !/\.html?$/i.test(entry)) {
    errors.push(`${at}.entry 必须是包内相对路径且以 .html 结尾`);
  }

  const width = asInt(raw.width);
  const height = asInt(raw.height);
  if (width === null || width < MIN_WIDGET_SIZE || width > MAX_WIDGET_SIZE) {
    errors.push(`${at}.width 必须是 ${MIN_WIDGET_SIZE}–${MAX_WIDGET_SIZE} 的整数`);
  }
  if (height === null || height < MIN_WIDGET_SIZE || height > MAX_WIDGET_SIZE) {
    errors.push(`${at}.height 必须是 ${MIN_WIDGET_SIZE}–${MAX_WIDGET_SIZE} 的整数`);
  }

  const scales = normalizeScales(raw.scales);
  if (!scales) {
    errors.push(`${at}.scales 必须是 1–${MAX_SCALES} 个递增档位（${SCALE_MIN}–${SCALE_MAX}，≤2 位小数）`);
  }

  const scaleList = scales || [...DEFAULT_SCALES];
  let defaultScale = scaleList.includes(DEFAULT_SCALE) ? DEFAULT_SCALE : scaleList[0];
  if (raw.defaultScale !== undefined) {
    if (typeof raw.defaultScale !== "number" || !scaleList.includes(raw.defaultScale)) {
      errors.push(`${at}.defaultScale 必须是 scales 里的一个档位`);
    } else {
      defaultScale = raw.defaultScale;
    }
  }

  const clickThrough = raw.clickThrough === undefined ? "none" : raw.clickThrough;
  if (clickThrough !== "none" && clickThrough !== "auto") {
    errors.push(`${at}.clickThrough 只能是 "none" 或 "auto"`);
  }

  const positionRaw = raw.position && typeof raw.position === "object" ? raw.position : {};
  const anchor = positionRaw.anchor === undefined ? "bottom-right" : positionRaw.anchor;
  if (anchor !== "bottom-right") errors.push(`${at}.position.anchor 本轮只支持 "bottom-right"`);
  const margin = positionRaw.margin === undefined ? EDGE_MARGIN : positionRaw.margin;
  if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > MAX_MARGIN) {
    errors.push(`${at}.position.margin 必须是 0–${MAX_MARGIN} 的数字`);
  }
  const remember = asBoolean(positionRaw.remember, true);

  const icon = raw.icon === undefined ? null : normalizeRelativeAssetPath(raw.icon);
  if (raw.icon !== undefined && (!icon || !/\.png$/i.test(icon))) {
    errors.push(`${at}.icon 必须是包内相对路径且为 .png`);
  }

  const trayRaw = raw.tray && typeof raw.tray === "object" ? raw.tray : {};
  const trayIcon = trayRaw.icon === undefined ? null : normalizeRelativeAssetPath(trayRaw.icon);
  if (trayRaw.icon !== undefined && (!trayIcon || !/\.png$/i.test(trayIcon))) {
    errors.push(`${at}.tray.icon 必须是包内相对路径且为 .png`);
  }
  let trayItems = [...DEFAULT_TRAY_ITEMS];
  if (trayRaw.items !== undefined) {
    if (!Array.isArray(trayRaw.items) || trayRaw.items.length === 0 || trayRaw.items.length > TRAY_ITEMS.length) {
      errors.push(`${at}.tray.items 必须是非空数组`);
    } else {
      const unknown = trayRaw.items.filter((item) => !TRAY_ITEMS.includes(item));
      if (unknown.length > 0) errors.push(`${at}.tray.items 含未知项：${unknown.join(", ")}`);
      trayItems = trayRaw.items.filter((item) => TRAY_ITEMS.includes(item));
      if (trayItems.length === 0) trayItems = [...DEFAULT_TRAY_ITEMS];
    }
  }

  const settingsRaw = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const fields = [];
  if (settingsRaw.fields !== undefined) {
    if (!Array.isArray(settingsRaw.fields) || settingsRaw.fields.length > 30) {
      errors.push(`${at}.settings.fields 必须是数组（≤30 项）`);
    } else {
      const seen = new Set();
      settingsRaw.fields.forEach((field, i) => {
        const fat = `${at}.settings.fields[${i}]`;
        if (!field || typeof field !== "object") {
          errors.push(`${fat} 必须是对象`);
          return;
        }
        const key = typeof field.key === "string" ? field.key.trim() : "";
        if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(key)) {
          errors.push(`${fat}.key 必须由字母/数字/_ . - 组成（≤32）`);
        } else if (seen.has(key)) {
          errors.push(`${fat}.key 重复：${key}`);
        }
        seen.add(key);
        if (!SETTINGS_FIELD_TYPES.includes(field.type)) {
          errors.push(`${fat}.type 只能是 ${SETTINGS_FIELD_TYPES.join(" / ")}`);
        }
        let options = null;
        if (field.type === "select") {
          if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 20) {
            errors.push(`${fat}.options 必须是 1–20 项数组`);
          } else {
            options = field.options
              .filter((option) => option && typeof option.value === "string" && typeof option.label === "string")
              .map((option) => ({ value: String(option.value).slice(0, 64), label: String(option.label).slice(0, 32) }));
            if (options.length !== field.options.length) errors.push(`${fat}.options 每项必须有 value/label 文本`);
          }
        }
        fields.push({
          key,
          type: field.type,
          label: typeof field.label === "string" && field.label.trim() ? field.label.trim().slice(0, 32) : key,
          default: field.default,
          options,
        });
      });
    }
  }

  const spec = {
    id,
    name,
    entry,
    width: width === null ? MIN_WIDGET_SIZE : width,
    height: height === null ? MIN_WIDGET_SIZE : height,
    scales: scaleList,
    defaultScale,
    transparent: asBoolean(raw.transparent, false),
    alwaysOnTop: asBoolean(raw.alwaysOnTop, false),
    skipTaskbar: asBoolean(raw.skipTaskbar, true),
    resizable: asBoolean(raw.resizable, false),
    clickThrough,
    position: { anchor: "bottom-right", margin: typeof margin === "number" && Number.isFinite(margin) ? margin : EDGE_MARGIN, remember },
    icon,
    tray: { icon: trayIcon, items: trayItems },
    settings: {
      title: typeof settingsRaw.title === "string" && settingsRaw.title.trim() ? settingsRaw.title.trim().slice(0, 32) : name,
      fields,
    },
  };

  return { ok: errors.length === 0, errors, spec };
}

module.exports = {
  WIDGET_SCHEME,
  MAX_WIDGETS_PER_PLUGIN,
  WIDGET_ID_RE,
  PLUGIN_ID_RE,
  DEFAULT_SCALES,
  DEFAULT_SCALE,
  EDGE_MARGIN,
  MAX_MARGIN,
  MIN_WIDGET_SIZE,
  MAX_WIDGET_SIZE,
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  SNAP_PX,
  ICON_MAX_BYTES,
  TRAY_ITEMS,
  DEFAULT_TRAY_ITEMS,
  SETTINGS_FIELD_TYPES,
  WIDGET_PAGE_ALLOWLIST,
  normalizeRelativeAssetPath,
  normalizeScales,
  normalizeScale,
  nextScale,
  widgetWindowSize,
  defaultWidgetPosition,
  isOnVisibleDisplay,
  clampWidgetState,
  widgetWindowOptions,
  widgetUrl,
  isSameWidgetOrigin,
  draggedPosition,
  settleWidgetPosition,
  snapToEdge,
  clampToVisible,
  parseWidgetStateJson,
  normalizeWidgetPage,
  normalizeWidgetSpec,
};
