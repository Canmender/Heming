"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PET_WINDOW_FLAG,
  PET_SCALES,
  DEFAULT_SCALE,
  BASE_WIDTH,
  BASE_HEIGHT,
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
  settlePetPosition,
  parsePetStateJson,
  normalizePetPage,
  PET_PAGE_ALLOWLIST,
  PET_SNAP_PX,
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
} = require("./pet-window");

/* ────────────────────────────── 入口判定 ────────────────────────────── */

test("嵌入式源：app://heming 下的桌宠 URL 放行", () => {
  assert.equal(isPetWindowUrl("app://heming/index.html?hemingWindow=pet", "app://heming"), true);
  assert.equal(isPetWindowUrl("app://heming/?hemingWindow=pet", "app://heming"), true);
  assert.equal(isPetWindowUrl("app://heming?hemingWindow=pet", "app://heming"), true);
});

test("外部站点即使带标记也不放行", () => {
  assert.equal(isPetWindowUrl(`https://evil.example/?${PET_WINDOW_FLAG}`, "app://heming"), false);
  assert.equal(
    isPetWindowUrl(`http://another.host/?${PET_WINDOW_FLAG}`, "http://47.92.39.184"),
    false,
  );
});

test("没有标记 / 标记是 call 都不算桌宠窗", () => {
  assert.equal(isPetWindowUrl("app://heming/index.html", "app://heming"), false);
  assert.equal(isPetWindowUrl("app://heming/?hemingWindow=call&conv=c1&peers=u2", "app://heming"), false);
});

test("非法输入不抛错、一律拒绝", () => {
  assert.equal(isPetWindowUrl("", "app://heming"), false);
  assert.equal(isPetWindowUrl(null, "app://heming"), false);
  assert.equal(isPetWindowUrl(`?${PET_WINDOW_FLAG}`, ""), false);
  assert.equal(isSameAppOrigin(null, "app://heming"), false);
  assert.equal(isSameAppOrigin("app://heming/", null), false);
});

/* ────────────────────────────── 缩放档位 ────────────────────────────── */

test("缩放只落在固定档位上：非法值回落默认、任意值取最近档", () => {
  assert.equal(normalizeScale(1.0), 1.0);
  assert.equal(normalizeScale(1.02), 1.0);
  assert.equal(normalizeScale(1.3), 1.25);
  assert.equal(normalizeScale(0.5), 0.6);
  assert.equal(normalizeScale(9), 1.5);
  assert.equal(normalizeScale("0.8"), 0.8);
  // 非数字 / NaN / null / undefined 全部回落默认
  for (const bad of [NaN, Infinity, null, undefined, "abc", {}, []]) {
    assert.equal(normalizeScale(bad), DEFAULT_SCALE, String(bad));
  }
});

test("档位切换两端夹住，不循环", () => {
  assert.equal(nextScale(1.0, 1), 1.25);
  assert.equal(nextScale(1.0, -1), 0.8);
  assert.equal(nextScale(1.5, 1), 1.5); // 封顶
  assert.equal(nextScale(0.6, -1), 0.6); // 触底
  assert.equal(nextScale(1.0, 0), 1.0); // 无方向不变
  // 非法输入先归一化到默认档（1.0），再按方向切一档
  assert.equal(nextScale("abc", 1), PET_SCALES[3]);
  assert.equal(nextScale("abc", -1), PET_SCALES[1]);
});

test("窗口尺寸由缩放推导且取整", () => {
  assert.deepEqual(petWindowSize(1.0), { width: BASE_WIDTH, height: BASE_HEIGHT });
  assert.deepEqual(petWindowSize(0.6), { width: Math.round(BASE_WIDTH * 0.6), height: Math.round(BASE_HEIGHT * 0.6) });
  for (const s of PET_SCALES) {
    const size = petWindowSize(s);
    assert.equal(Number.isInteger(size.width), true);
    assert.equal(Number.isInteger(size.height), true);
  }
});

/* ────────────────────────────── 落位 ────────────────────────────── */

test("默认落位贴工作区右下角，留边距", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = petWindowSize(1.0);
  const p = defaultPetPosition(area, size);
  assert.equal(p.x, 1920 - size.width - 24);
  assert.equal(p.y, 1040 - size.height - 24);
});

test("副屏工作区不在原点时也贴该屏右下角", () => {
  const area = { x: 1920, y: -200, width: 1280, height: 1024 };
  const size = petWindowSize(1.0);
  const p = defaultPetPosition(area, size);
  assert.equal(p.x, 1920 + 1280 - size.width - 24);
  assert.equal(p.y, -200 + 1024 - size.height - 24);
});

test("拿不到显示器信息时回落一个可用落位，不产生 NaN", () => {
  const p = defaultPetPosition(null, null);
  assert.equal(Number.isFinite(p.x), true);
  assert.equal(Number.isFinite(p.y), true);
});

/* ────────────────────────────── 状态归一化 ────────────────────────────── */

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };

test("坏数据一律回落默认落位，不抛错", () => {
  for (const raw of [null, undefined, 42, "x", [], { bounds: "nope" }, { bounds: { x: NaN, y: 0 } }]) {
    const state = clampPetState(raw, [PRIMARY], PRIMARY);
    assert.equal(Number.isInteger(state.bounds.x), true, JSON.stringify(raw));
    assert.equal(Number.isInteger(state.bounds.y), true, JSON.stringify(raw));
    assert.equal(state.scale, DEFAULT_SCALE);
    assert.equal(state.visible, false);
  }
});

test("落位在屏幕外时回落（显示器拔掉的场景）", () => {
  const state = clampPetState(
    { bounds: { x: 5000, y: 5000, width: 300, height: 420 }, scale: 1 },
    [PRIMARY],
    PRIMARY,
  );
  assert.ok(state.bounds.x < PRIMARY.width, "应回到主屏范围内");
  assert.ok(state.bounds.y < PRIMARY.height);
});

test("合法落位原样复用，尺寸按当前 scale 重算", () => {
  const state = clampPetState(
    { bounds: { x: 100, y: 200, width: 300, height: 420 }, scale: 1.25, visible: true },
    [PRIMARY],
    PRIMARY,
  );
  assert.deepEqual(state.bounds, {
    x: 100,
    y: 200,
    width: petWindowSize(1.25).width,
    height: petWindowSize(1.25).height,
  });
  assert.equal(state.scale, 1.25);
  assert.equal(state.visible, true);
});

test("visible 只认严格的 true（坏值不当成显示过）", () => {
  for (const v of ["true", 1, {}, null, undefined]) {
    assert.equal(clampPetState({ visible: v }, [PRIMARY], PRIMARY).visible, false, String(v));
  }
});

test("拿不到显示器列表时不拦落位（只做结构校验）", () => {
  const state = clampPetState({ bounds: { x: 10, y: 20, width: 300, height: 420 } }, [], PRIMARY);
  assert.equal(state.bounds.x, 10);
  assert.equal(state.bounds.y, 20);
});

test("可见面积不足时判为不可见", () => {
  // 只有 30px 宽落在屏内，低于 60px 门槛
  assert.equal(
    isOnVisibleDisplay({ x: 1890, y: 100, width: 300, height: 420 }, [PRIMARY]),
    false,
  );
  assert.equal(isOnVisibleDisplay({ x: 1600, y: 100, width: 300, height: 420 }, [PRIMARY]), true);
});

/* ────────────────────────────── 模型路径 ────────────────────────────── */

test("默认模型路径可被正常改写", () => {
  assert.equal(sanitizeModelPath(undefined), DEFAULT_MODEL_PATH);
  assert.equal(sanitizeModelPath(""), DEFAULT_MODEL_PATH);
  assert.equal(sanitizeModelPath("pet/Hiyori/Hiyori.model3.json"), "pet/Hiyori/Hiyori.model3.json");
  // 反斜杠统一成正斜杠
  assert.equal(sanitizeModelPath("pet\\Hiyori\\Hiyori.model3.json"), "pet/Hiyori/Hiyori.model3.json");
  // Cubism 2.1 的 .model.json 也认
  assert.equal(sanitizeModelPath("pet/Shizuku/shizuku.model.json"), "pet/Shizuku/shizuku.model.json");
  // 中文目录名放行
  assert.equal(sanitizeModelPath("pet/我的角色/a.model3.json"), "pet/我的角色/a.model3.json");
});

test("路径穿越与协议前缀一律回落默认（不给渲染层留读任意文件的口子）", () => {
  const bad = [
    "../secret/a.model3.json",
    "pet/../../etc/a.model3.json",
    "/etc/passwd.model3.json", // 绝对路径：去前导斜杠后仍合法段，但不该在 pet 之外
    "C:/Windows/a.model3.json",
    "file:///c/a.model3.json",
    "http://evil/a.model3.json",
    "pet//a.model3.json",
    "pet/a.model3.json\u0000.png",
    "pet/a.txt",
    "pet/a.json",
    'pet/"a".model3.json',
  ];
  for (const p of bad) {
    const out = sanitizeModelPath(p);
    assert.equal(out, DEFAULT_MODEL_PATH, `应回落默认：${p} → ${out}`);
  }
});

test("超长路径回落默认", () => {
  const long = "pet/" + "a".repeat(300) + ".model3.json";
  assert.equal(sanitizeModelPath(long), DEFAULT_MODEL_PATH);
});

/* ────────────────────────────── 窗口参数 ────────────────────────────── */

test("桌宠窗口：透明、无边框、置顶、不占任务栏、不可缩放", () => {
  const opts = petWindowOptions({ bounds: { x: 10, y: 20 }, scale: 1.0, preloadPath: "/preload.js" });
  assert.equal(opts.transparent, true);
  assert.equal(opts.frame, false);
  assert.equal(opts.alwaysOnTop, true);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.resizable, false);
  assert.equal(opts.hasShadow, false);
  assert.equal(opts.backgroundColor, "#00000000");
  assert.equal(opts.show, false);
  assert.equal(opts.x, 10);
  assert.equal(opts.y, 20);
  assert.equal(opts.width, BASE_WIDTH);
  assert.equal(opts.height, BASE_HEIGHT);
});

test("桌宠窗口：关闭后台节流（否则被遮挡后角色卡在上一帧）", () => {
  const opts = petWindowOptions({ preloadPath: "/preload.js" });
  assert.equal(opts.webPreferences.backgroundThrottling, false);
  assert.equal(opts.webPreferences.sandbox, true);
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.nodeIntegration, false);
  assert.equal(opts.webPreferences.preload, "/preload.js");
});

test("桌宠窗口：非法坐标不产生 NaN，缩放跟着档位走", () => {
  const opts = petWindowOptions({ bounds: { x: NaN, y: undefined }, scale: 1.5 });
  assert.equal(Number.isFinite(opts.x), true);
  assert.equal(Number.isFinite(opts.y), true);
  assert.equal(opts.width, petWindowSize(1.5).width);
});

test("每次调用返回新对象（避免调用方改动污染下次）", () => {
  const a = petWindowOptions({});
  const b = petWindowOptions({});
  assert.notEqual(a, b);
  assert.notEqual(a.webPreferences, b.webPreferences);
});

/* ────────────────────────────── 拖拽 ────────────────────────────── */

test("拖拽位移按屏幕光标差计算，起点窗口原点为基准", () => {
  const origin = { cursorX: 1000, cursorY: 500, windowX: 1600, windowY: 600 };
  // 光标向右下各移 60/40 → 窗口同样平移
  assert.deepEqual(draggedPosition(origin, { x: 1060, y: 540 }), { x: 1660, y: 640 });
  // 光标回到起点 → 窗口回到起点
  assert.deepEqual(draggedPosition(origin, { x: 1000, y: 500 }), { x: 1600, y: 600 });
  // 负方向
  assert.deepEqual(draggedPosition(origin, { x: 900, y: 400 }), { x: 1500, y: 500 });
});

test("拖拽计算对坏输入返回 null（不产生 NaN 坐标）", () => {
  const ok = { cursorX: 0, cursorY: 0, windowX: 10, windowY: 10 };
  assert.equal(draggedPosition(null, { x: 1, y: 1 }), null);
  assert.equal(draggedPosition(ok, null), null);
  assert.equal(draggedPosition(ok, { x: NaN, y: 1 }), null);
  assert.equal(draggedPosition({ cursorX: NaN, cursorY: 0, windowX: 0, windowY: 0 }, { x: 1, y: 1 }), null);
});

test("拖拽结果取整（避免亚像素抖动）", () => {
  const origin = { cursorX: 0.4, cursorY: 0.4, windowX: 10.2, windowY: 20.7 };
  const p = draggedPosition(origin, { x: 10.9, y: 30.6 });
  assert.equal(Number.isInteger(p.x), true);
  assert.equal(Number.isInteger(p.y), true);
});

/* ───────────────────── 拖拽收尾：边缘吸附 + 可见性钳制 ───────────────────── */

const SIZE = { width: 300, height: 420 };
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test("收尾吸附：四条边在阈值内都贴到工作区边缘", () => {
  assert.deepEqual(settlePetPosition({ x: 5, y: 5 }, SIZE, [AREA]), { x: 0, y: 0 });
  assert.deepEqual(
    settlePetPosition({ x: AREA.width - SIZE.width - 5, y: AREA.height - SIZE.height - 5 }, SIZE, [AREA]),
    { x: AREA.width - SIZE.width, y: AREA.height - SIZE.height },
  );
  // 只吸一条边：x 离左边 3、y 离上下都远 → 只动 x
  assert.deepEqual(settlePetPosition({ x: 3, y: 400 }, SIZE, [AREA]), { x: 0, y: 400 });
});

test("收尾吸附：超过阈值不动（避免「明明没到边却被吸过去」）", () => {
  const gap = PET_SNAP_PX + 1;
  assert.deepEqual(settlePetPosition({ x: gap, y: 300 }, SIZE, [AREA]), { x: gap, y: 300 });
  assert.deepEqual(settlePetPosition({ x: 700, y: 300 }, SIZE, [AREA]), { x: 700, y: 300 });
});

test("收尾钳制：拖出屏幕后仍至少留一块可见区域（能拖回来）", () => {
  // 左 / 上：右/下边至少留 MIN_VISIBLE_*
  assert.deepEqual(settlePetPosition({ x: -2000, y: 500 }, SIZE, [AREA]), {
    x: AREA.x + MIN_VISIBLE_WIDTH - SIZE.width,
    y: 500,
  });
  assert.deepEqual(settlePetPosition({ x: 500, y: -2000 }, SIZE, [AREA]), {
    x: 500,
    y: AREA.y + MIN_VISIBLE_HEIGHT - SIZE.height,
  });
  // 右 / 下：左/上边至少留 MIN_VISIBLE_*
  assert.deepEqual(settlePetPosition({ x: 5000, y: 500 }, SIZE, [AREA]), {
    x: AREA.width - MIN_VISIBLE_WIDTH,
    y: 500,
  });
  assert.deepEqual(settlePetPosition({ x: 500, y: 5000 }, SIZE, [AREA]), {
    x: 500,
    y: AREA.height - MIN_VISIBLE_HEIGHT,
  });
});

test("收尾钳制：拖到两块屏之间的空隙里，按最近的工作区兜住", () => {
  const left = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 3000, y: 0, width: 1920, height: 1040 };
  const settled = settlePetPosition({ x: 2400, y: 300 }, SIZE, [left, right]);
  // 2400 离右屏更近 → 钳到右屏左侧「露 60px」
  assert.deepEqual(settled, { x: right.x + MIN_VISIBLE_WIDTH - SIZE.width, y: 300 });
});

test("收尾吸附：多显示器吸到当前所在那块的边缘，而不是主屏", () => {
  const left = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 1920, y: 0, width: 1920, height: 1040 };
  // 落在副屏内、离它左边界 5px → 吸到副屏左边界
  assert.deepEqual(settlePetPosition({ x: right.x + 5, y: 300 }, SIZE, [left, right]), {
    x: right.x,
    y: 300,
  });
  // 落在副屏右边界内 5px → 吸到副屏右边界
  assert.deepEqual(
    settlePetPosition({ x: right.x + right.width - SIZE.width - 5, y: 300 }, SIZE, [left, right]),
    { x: right.x + right.width - SIZE.width, y: 300 },
  );
});

test("收尾：没有显示器信息时只取整，不裁剪（不产生 NaN）", () => {
  assert.deepEqual(settlePetPosition({ x: 1.4, y: 2.6 }, SIZE, []), { x: 1, y: 3 });
  assert.deepEqual(settlePetPosition({ x: -5.6, y: 500.2 }, SIZE, null), { x: -6, y: 500 });
});

test("收尾：坏输入返回 null；尺寸缺失回落基准尺寸", () => {
  assert.equal(settlePetPosition(null, SIZE, [AREA]), null);
  assert.equal(settlePetPosition({ x: NaN, y: 0 }, SIZE, [AREA]), null);
  // 尺寸非法 → 按 300×420 算钳制（x 仍是贴左边）
  assert.deepEqual(settlePetPosition({ x: -2000, y: 5 }, null, [AREA]), { x: -240, y: 0 });
});

/* ────────────────────────────── 桌宠地址 ────────────────────────────── */

test("桌宠地址指向独立入口 pet.html，并带窗口标记", () => {
  assert.equal(petUrl("app://heming/index.html"), "app://heming/pet.html?hemingWindow=pet");
  assert.equal(petUrl("app://heming/index.html?x=1"), "app://heming/pet.html?x=1&hemingWindow=pet");
});

test("各种基址形态都能换出 pet.html", () => {
  assert.equal(petUrl("app://heming"), "app://heming/pet.html?hemingWindow=pet");
  assert.equal(petUrl("app://heming/"), "app://heming/pet.html?hemingWindow=pet");
  assert.equal(petUrl("http://localhost:5173"), "http://localhost:5173/pet.html?hemingWindow=pet");
  assert.equal(petUrl("http://localhost:5173/"), "http://localhost:5173/pet.html?hemingWindow=pet");
  assert.equal(
    petUrl("http://47.92.39.184/sub/"),
    "http://47.92.39.184/sub/pet.html?hemingWindow=pet",
  );
});

test("hash 被丢弃（拼在 hash 后面就不进 query 了）", () => {
  assert.equal(petUrl("app://heming/index.html#/chat"), "app://heming/pet.html?hemingWindow=pet");
});

test("空/非法基址回落到内置默认，不产生相对地址", () => {
  for (const bad of ["", null, undefined, 42]) {
    const url = petUrl(bad);
    assert.ok(url.startsWith("app://heming/pet.html"), String(bad));
  }
});

test("拼出来的地址能被 isPetWindowUrl 认出来（两个函数不能分叉）", () => {
  for (const base of ["app://heming/index.html", "app://heming/", "http://host/sub/"]) {
    const url = petUrl(base);
    const origin = base.replace(/\/[^/]*\.html?$/i, "/");
    assert.equal(isPetWindowUrl(url, origin), true, url);
  }
});

/* ────────────────────────────── 状态文件解析 ────────────────────────────── */

test("普通 JSON 正常解析", () => {
  assert.deepEqual(parsePetStateJson('{"scale":1.25,"visible":true}'), { scale: 1.25, visible: true });
});

test("带 UTF-8 BOM 也能解析（被编辑器另存过的状态文件）", () => {
  const withBom = "\uFEFF" + '{"scale":1,"visible":true}';
  assert.deepEqual(parsePetStateJson(withBom), { scale: 1, visible: true });
});

test("损坏 / 非字符串一律返回 null（交给 clampPetState 回落）", () => {
  for (const bad of ["", "{", "not json", "null", null, undefined, 42, {}]) {
    assert.equal(parsePetStateJson(bad), null, String(bad));
  }
});

/* ────────────────────── 点气泡直达页面：page 白名单归一 ────────────────────── */

test("normalizePetPage：字符串与 {page} 两种形状都认", () => {
  for (const page of PET_PAGE_ALLOWLIST) {
    assert.equal(normalizePetPage(page), page);
    assert.equal(normalizePetPage({ page }), page);
  }
});

test("normalizePetPage：不在白名单 / 旧无参调用 → null（调用方回落「打开设置」）", () => {
  for (const bad of [undefined, null, "", "chat", "evil://x", 42, [], {}, { page: "chat" }, { page: 7 }]) {
    assert.equal(normalizePetPage(bad), null, JSON.stringify(bad));
  }
});
