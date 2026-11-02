"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APP_DEFAULT_URL,
  originOf,
  secureOrigins,
  IPC_UNTRUSTED,
  makeSenderCheck,
  denyValueFor,
  guardIpc,
} = require("./secure-origins");

test("originOf 取协议+主机+端口，忽略路径/查询", () => {
  assert.equal(originOf("http://47.92.39.184"), "http://47.92.39.184");
  assert.equal(originOf("https://47.92.39.184/foo?x=1"), "https://47.92.39.184");
  assert.equal(originOf("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(originOf("https://example.com:8443"), "https://example.com:8443");
});

test("originOf 非法输入返回 null", () => {
  assert.equal(originOf("not a url"), null);
  assert.equal(originOf(""), null);
  assert.equal(originOf(null), null);
  assert.equal(originOf(undefined), null);
});

test("secureOrigins 默认含生产 origin", () => {
  const out = secureOrigins({});
  assert.ok(out.includes("http://47.92.39.184"));
});

test("secureOrigins 合并 HEMING_WEB_URL 与默认（去重）", () => {
  // WEB_URL 显式给同一 host 的 https 形态 → 与默认 http 不同 origin，二者都保留
  const out = secureOrigins({ HEMING_WEB_URL: "https://47.92.39.184/app" });
  const parts = out.split(",");
  assert.ok(parts.includes("https://47.92.39.184"));
  assert.ok(parts.includes("http://47.92.39.184"));
  assert.equal(parts.length, new Set(parts).size); // 无重复
});

test("secureOrigins 合并本地开发 origin（HEMING_DEV_URL）", () => {
  const out = secureOrigins({ HEMING_DEV_URL: "http://localhost:5173" });
  assert.ok(out.includes("http://localhost:5173"));
  assert.ok(out.includes("http://47.92.39.184"));
});

test("secureOrigins 同 origin 去重（WEB_URL 与默认同源同协议）", () => {
  const out = secureOrigins({ HEMING_WEB_URL: "http://47.92.39.184/other" });
  const parts = out.split(",");
  assert.equal(parts.filter((p) => p === "http://47.92.39.184").length, 1);
});

test("secureOrigins 非法输入被忽略，不抛", () => {
  const out = secureOrigins({ HEMING_WEB_URL: "::::", HEMING_DEV_URL: "nope" });
  assert.equal(out, "http://47.92.39.184");
});

test("APP_DEFAULT_URL 是 http 生产地址", () => {
  assert.equal(APP_DEFAULT_URL, "http://47.92.39.184");
});

/* ───────────────────── IPC 调用来源守卫（③-4 安全复审） ───────────────────── */

/** 假主窗口：webContents 是一个可辨识对象。 */
function fakeMainWindow() {
  return {
    webContents: { id: "main-wc" },
    isDestroyed: () => false,
  };
}

/** 假 ipcMain：记录注册的 handler，便于直接调用。 */
function fakeIpc() {
  const handles = new Map();
  const ons = new Map();
  return {
    handles,
    ons,
    handle: (ch, fn) => handles.set(ch, fn),
    on: (ch, fn) => ons.set(ch, fn),
  };
}

test("makeSenderCheck：只认主窗口 webContents；没窗口/销毁/过期 sender 一律 false", () => {
  const win = fakeMainWindow();
  const check = makeSenderCheck(() => win);
  assert.equal(check({ sender: win.webContents }), true);
  assert.equal(check({ sender: { id: "pet-wc" } }), false);
  assert.equal(check({}), false);
  assert.equal(check(null), false);

  // 主窗口销毁后：即使 sender 指针相同也不可信
  win.isDestroyed = () => true;
  assert.equal(check({ sender: win.webContents }), false);

  // 忘了接线（没有 getMainWindow）：fail-closed
  assert.equal(makeSenderCheck(undefined)({ sender: win.webContents }), false);
  // getMainWindow 抛错：当作不可信，不把异常抛给 IPC 调用方
  assert.equal(makeSenderCheck(() => { throw new Error("gone"); })({ sender: win.webContents }), false);
});

test("denyValueFor：同步桥返回 null（preload 按不可用处理），其它通道返回结构化错误", () => {
  assert.equal(denyValueFor("secret:decryptAsync"), null);
  assert.equal(denyValueFor("update:state"), null);
  assert.equal(denyValueFor("runtime:probe"), null);
  for (const ch of ["wiki:write", "file:write", "export:write", "chart:export", "notify:message", "mcp:stdio:request"]) {
    assert.deepEqual(denyValueFor(ch), IPC_UNTRUSTED, ch);
  }
  assert.deepEqual(denyValueFor(undefined), IPC_UNTRUSTED);
});

test("guardIpc：受管通道在非主窗口调用时 handler 不执行、返回拒绝值", () => {
  const ipc = fakeIpc();
  const win = fakeMainWindow();
  let called = 0;
  const guarded = guardIpc(ipc, {
    isTrusted: makeSenderCheck(() => win),
    channels: ["wiki:write", "secret:availableAsync"],
  });

  let got;
  guarded.handle("wiki:write", () => {
    called += 1;
    return { ok: true };
  });
  guarded.handle("secret:availableAsync", () => {
    called += 1;
    return true;
  });

  // 桌宠窗口（同源但不属于主窗口）调用：拒绝
  got = ipc.handles.get("wiki:write")({ sender: { id: "pet-wc" } }, "wiki/x.md", "x");
  assert.deepEqual(got, IPC_UNTRUSTED);
  assert.equal(ipc.handles.get("secret:availableAsync")({ sender: { id: "pet-wc" } }), null);
  assert.equal(called, 0, "不可信调用绝不能执行 handler 本体");

  // 主窗口调用：放行并透传参数
  got = ipc.handles.get("wiki:write")({ sender: win.webContents }, "wiki/x.md", "hello");
  assert.deepEqual(got, { ok: true });
  assert.equal(ipc.handles.get("secret:availableAsync")({ sender: win.webContents }), true);
  assert.equal(called, 2);
});

test("guardIpc：通道清单之外的通道原样透传（app:version 任何窗口都要能问）", () => {
  const ipc = fakeIpc();
  let called = 0;
  const guarded = guardIpc(ipc, { isTrusted: () => false, channels: ["wiki:write"] });
  guarded.handle("app:version", () => {
    called += 1;
    return "1.2.3";
  });
  assert.equal(ipc.handles.get("app:version")({ sender: { id: "pet-wc" } }), "1.2.3");
  assert.equal(called, 1);
});

test("guardIpc：同步 on 通道不可信时写 event.returnValue=拒绝值且不执行 handler", () => {
  const ipc = fakeIpc();
  const win = fakeMainWindow();
  let called = 0;
  const guarded = guardIpc(ipc, {
    isTrusted: makeSenderCheck(() => win),
    channels: ["secret:capabilities"],
  });
  guarded.on("secret:capabilities", () => {
    called += 1;
  });

  const deniedEvent = {};
  ipc.ons.get("secret:capabilities")(deniedEvent, undefined);
  assert.equal(deniedEvent.returnValue, null);
  assert.equal(called, 0);

  const okEvent = {};
  ipc.ons.get("secret:capabilities")({ ...okEvent, sender: win.webContents });
  assert.equal(called, 1);
});
