"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeWidgetSpec,
  normalizeScale,
  nextScale,
  widgetWindowSize,
  defaultWidgetPosition,
  clampWidgetState,
  widgetWindowOptions,
  widgetUrl,
  isSameWidgetOrigin,
  draggedPosition,
  settleWidgetPosition,
  parseWidgetStateJson,
  normalizeWidgetPage,
  normalizeRelativeAssetPath,
  isOnVisibleDisplay,
} = require("./plugin-window");

/** 与 d.46 桌宠同规格的 widget（迁移前后几何语义必须一致）。 */
const PET_SPEC = normalizeWidgetSpec({
  id: "pet",
  name: "桌宠",
  entry: "files/index.html",
  width: 300,
  height: 420,
  scales: [0.6, 0.8, 1, 1.25, 1.5],
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  clickThrough: "auto",
  position: { anchor: "bottom-right", margin: 24, remember: true },
}).spec;

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/* ────────────────────────── 清单归一化 ────────────────────────── */

test("normalizeWidgetSpec：合法清单原样归一，缺省值补全", () => {
  const spec = normalizeWidgetSpec({ id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 });
  assert.equal(spec.ok, true, spec.errors.join("；"));
  assert.deepEqual(spec.spec.scales, [1]);
  assert.equal(spec.spec.defaultScale, 1);
  assert.equal(spec.spec.transparent, false);
  assert.equal(spec.spec.clickThrough, "none");
  assert.deepEqual(spec.spec.position, { anchor: "bottom-right", margin: 24, remember: true });
  assert.deepEqual(spec.spec.tray.items, ["toggle", "clickThrough", "resetPosition", "settings"]);
});

test("normalizeWidgetSpec：id / entry / 尺寸 / 档位非法都要中文报错并给字段路径", () => {
  const bad = normalizeWidgetSpec({
    id: "Pet!",
    entry: "files/index.js",
    width: 10,
    height: 5000,
    scales: [1, 0.8],
  });
  assert.equal(bad.ok, false);
  const joined = bad.errors.join("\n");
  assert.match(joined, /desktopWidgets\[0\]\.id/);
  assert.match(joined, /desktopWidgets\[0\]\.entry/);
  assert.match(joined, /desktopWidgets\[0\]\.width/);
  assert.match(joined, /desktopWidgets\[0\]\.height/);
  assert.match(joined, /desktopWidgets\[0\]\.scales/);
});

test("normalizeWidgetSpec：entry 禁止绝对路径 / 协议 / 穿越（不给渲染层留读任意文件的口子）", () => {
  for (const entry of ["/etc/x.html", "widget://x/files/index.html", "files/../secret.html", "C:\\x\\index.html"]) {
    assert.equal(normalizeRelativeAssetPath(entry), null, entry);
  }
  assert.equal(normalizeRelativeAssetPath("files/index.html"), "files/index.html");
});

test("normalizeWidgetSpec：tray.items 只认宿主支持的项，未知项报错", () => {
  const spec = normalizeWidgetSpec({
    id: "pet",
    entry: "files/index.html",
    width: 300,
    height: 420,
    tray: { items: ["toggle", "settings"] },
  });
  assert.deepEqual(spec.spec.tray.items, ["toggle", "settings"]);
  const bad = normalizeWidgetSpec({
    id: "pet",
    entry: "files/index.html",
    width: 300,
    height: 420,
    tray: { items: ["rm -rf"] },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("；"), /tray\.items 含未知项/);
});

test("normalizeWidgetSpec：设置字段类型/重复 key 受限（宿主只渲染它认识的表单）", () => {
  const bad = normalizeWidgetSpec({
    id: "pet",
    entry: "files/index.html",
    width: 300,
    height: 420,
    settings: {
      fields: [
        { key: "agentId", type: "agent", label: "绑定" },
        { key: "agentId", type: "text" },
        { key: "x", type: "script" },
      ],
    },
  });
  const joined = bad.errors.join("；");
  assert.match(joined, /key 重复/);
  assert.match(joined, /type 只能是/);
});

/* ────────────────────────── 缩放 ────────────────────────── */

test("缩放只落在清单档位上：非法值回落默认、任意值取最近档", () => {
  assert.equal(normalizeScale(PET_SPEC, 1.02), 1);
  assert.equal(normalizeScale(PET_SPEC, 0.61), 0.6);
  assert.equal(normalizeScale(PET_SPEC, 1.4), 1.5);
  assert.equal(normalizeScale(PET_SPEC, null), 1);
  assert.equal(normalizeScale(PET_SPEC, ""), 1);
  assert.equal(normalizeScale(PET_SPEC, Number.NaN), 1);
});

test("档位切换两端夹住，不循环", () => {
  assert.equal(nextScale(PET_SPEC, 1, 1), 1.25);
  assert.equal(nextScale(PET_SPEC, 1, -1), 0.8);
  assert.equal(nextScale(PET_SPEC, 1.5, 1), 1.5);
  assert.equal(nextScale(PET_SPEC, 0.6, -1), 0.6);
});

test("窗口尺寸由缩放推导且取整", () => {
  assert.deepEqual(widgetWindowSize(PET_SPEC, 1), { width: 300, height: 420 });
  assert.deepEqual(widgetWindowSize(PET_SPEC, 1.5), { width: 450, height: 630 });
});

/* ────────────────────────── 落位与钳制 ────────────────────────── */

test("默认落位贴工作区右下角，留清单边距", () => {
  const size = widgetWindowSize(PET_SPEC, 1);
  assert.deepEqual(defaultWidgetPosition(PET_SPEC, WORK_AREA, size), { x: 1596, y: 596 });
});

test("副屏工作区不在原点时也贴该屏右下角", () => {
  const area = { x: 1920, y: 0, width: 1280, height: 720 };
  const size = widgetWindowSize(PET_SPEC, 1);
  assert.deepEqual(defaultWidgetPosition(PET_SPEC, area, size), { x: 2876, y: 276 });
});

test("拿不到显示器信息时回落一个可用落位，不产生 NaN", () => {
  const pos = defaultWidgetPosition(PET_SPEC, null, null);
  assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
});

test("坏状态一律回落默认落位，不抛错；visible 只认严格 true", () => {
  const clamped = clampWidgetState(PET_SPEC, { scale: "x", bounds: "nope", visible: "yes" }, [WORK_AREA], WORK_AREA);
  assert.equal(clamped.scale, 1);
  assert.equal(clamped.visible, false);
  assert.deepEqual(clamped.bounds, { x: 1596, y: 596, width: 300, height: 420 });
});

test("落位在屏幕外时回落（显示器拔掉的场景）", () => {
  const raw = { scale: 1, bounds: { x: 5000, y: 5000, width: 300, height: 420 }, visible: true };
  const clamped = clampWidgetState(PET_SPEC, raw, [WORK_AREA], WORK_AREA);
  assert.equal(clamped.visible, true);
  assert.deepEqual(clamped.bounds, { x: 1596, y: 596, width: 300, height: 420 });
});

test("合法落位原样复用，尺寸按当前 scale 重算", () => {
  const raw = { scale: 0.6, bounds: { x: 100, y: 200, width: 999, height: 999 }, visible: true };
  const clamped = clampWidgetState(PET_SPEC, raw, [WORK_AREA], WORK_AREA);
  assert.equal(clamped.scale, 0.6);
  assert.deepEqual(clamped.bounds, { x: 100, y: 200, width: 180, height: 252 });
});

test("拿不到显示器列表时不拦落位；可见面积不足时判为不可见", () => {
  assert.equal(isOnVisibleDisplay({ x: -10000, y: -10000, width: 300, height: 420 }, []), true);
  assert.equal(isOnVisibleDisplay({ x: 1900, y: 1030, width: 300, height: 420 }, [WORK_AREA]), false);
});

/* ────────────────────────── 窗口参数与 URL ────────────────────────── */

test("widget 窗口参数：透明/无边框/置顶/不占任务栏 + sandbox + 最小 preload", () => {
  const options = widgetWindowOptions(PET_SPEC, { scale: 1, bounds: { x: 10, y: 20 } }, "/tmp/widget-preload.js");
  assert.equal(options.transparent, true);
  assert.equal(options.frame, false);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.hasShadow, false);
  assert.equal(options.backgroundColor, "#00000000");
  assert.deepEqual(options.webPreferences, {
    preload: "/tmp/widget-preload.js",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  });
  // 遮挡时靠宿主显式暂停渲染，而不是让 Chromium 节流（透明常驻窗首帧卡顿的既有结论）
  assert.equal(options.webPreferences.backgroundThrottling, false);
});

test("widget 窗口参数：非法坐标不产生 NaN，尺寸跟着档位走", () => {
  const options = widgetWindowOptions(PET_SPEC, { scale: 1.5, bounds: { x: Number.NaN, y: "x" } }, "/tmp/p.js");
  assert.equal(options.x, 0);
  assert.equal(options.y, 0);
  assert.equal(options.width, 450);
  assert.equal(options.height, 630);
});

test("widget 地址是独立 origin：widget://<id>/<entry>", () => {
  assert.equal(widgetUrl("heming.pet", "files/index.html"), "widget://heming.pet/files/index.html");
  assert.equal(widgetUrl("../evil", "files/index.html"), null);
  assert.equal(widgetUrl("heming.pet", "files/../../x.html"), null);
});

test("同 origin 判定：只认本插件自己的页面（导航闸用，fail-closed）", () => {
  assert.equal(isSameWidgetOrigin("widget://heming.pet/files/index.html", "heming.pet"), true);
  assert.equal(isSameWidgetOrigin("widget://heming.pet/files/index.html?v=1#x", "heming.pet"), true);
  assert.equal(isSameWidgetOrigin("widget://other/files/index.html", "heming.pet"), false);
  assert.equal(isSameWidgetOrigin("app://heming/index.html", "heming.pet"), false);
  assert.equal(isSameWidgetOrigin("https://evil.example/x", "heming.pet"), false);
  assert.equal(isSameWidgetOrigin(null, "heming.pet"), false);
});

/* ────────────────────────── 拖拽 ────────────────────────── */

test("拖拽位移按屏幕光标差计算；坏输入返回 null；结果取整", () => {
  const origin = { cursorX: 100, cursorY: 100, windowX: 500, windowY: 400, lastX: 100, lastY: 100 };
  assert.deepEqual(draggedPosition(origin, { x: 130.4, y: 90.6 }), { x: 530, y: 391 });
  assert.equal(draggedPosition(null, { x: 1, y: 1 }), null);
  assert.equal(draggedPosition(origin, { x: Number.NaN, y: 1 }), null);
});

test("收尾吸附：四条边在阈值内都贴到工作区边缘；超过阈值不动", () => {
  const size = { width: 300, height: 420 };
  assert.deepEqual(settleWidgetPosition(PET_SPEC, { x: 5, y: 500 }, size, [WORK_AREA]), { x: 0, y: 500 });
  assert.deepEqual(settleWidgetPosition(PET_SPEC, { x: 1920 - 305, y: 500 }, size, [WORK_AREA]), { x: 1620, y: 500 });
  assert.deepEqual(settleWidgetPosition(PET_SPEC, { x: 800, y: -4 }, size, [WORK_AREA]), { x: 800, y: 0 });
  assert.deepEqual(settleWidgetPosition(PET_SPEC, { x: 800, y: 1040 - 424 }, size, [WORK_AREA]), { x: 800, y: 620 });
  assert.deepEqual(settleWidgetPosition(PET_SPEC, { x: 800, y: 500 }, size, [WORK_AREA]), { x: 800, y: 500 });
});

test("收尾钳制：拖出屏幕后仍至少留一块可见区域（能拖回来）", () => {
  const size = { width: 300, height: 420 };
  const pos = settleWidgetPosition(PET_SPEC, { x: -400, y: -400 }, size, [WORK_AREA]);
  assert.ok(pos.x >= 60 - size.width);
  assert.ok(pos.y >= 80 - size.height);
});

test("收尾吸附：多显示器吸到当前所在那块的边缘，而不是主屏", () => {
  const second = { x: 1920, y: 0, width: 1280, height: 720 };
  const pos = settleWidgetPosition(PET_SPEC, { x: 1930, y: 300 }, { width: 300, height: 420 }, [WORK_AREA, second]);
  assert.equal(pos.x, 1920);
});

test("收尾：坏输入返回 null；没有显示器信息时只取整", () => {
  assert.equal(settleWidgetPosition(PET_SPEC, null, { width: 1, height: 1 }, []), null);
  assert.deepEqual(settleWidgetPosition(PET_SPEC, { x: 1.4, y: 2.6 }, { width: 300, height: 420 }, []), { x: 1, y: 3 });
});

/* ────────────────────────── 状态文件与跳页 ────────────────────────── */

test("状态文件：普通 JSON / 带 BOM 都能解析；损坏返回 null", () => {
  assert.deepEqual(parseWidgetStateJson('{"visible":true}'), { visible: true });
  assert.deepEqual(parseWidgetStateJson('\uFEFF{"visible":true}'), { visible: true });
  assert.equal(parseWidgetStateJson("{oops"), null);
  assert.equal(parseWidgetStateJson(null), null);
});

test("normalizeWidgetPage：字符串与 {page} 两种形状都认；白名单外一律 null", () => {
  assert.equal(normalizeWidgetPage("settings"), "settings");
  assert.equal(normalizeWidgetPage({ page: "infohub" }), "infohub");
  assert.equal(normalizeWidgetPage("https://evil.example"), null);
  assert.equal(normalizeWidgetPage(undefined), null);
});
