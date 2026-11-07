"use strict";
/**
 * 工作流 HTTP 桥的单测（node --test）。
 *
 * 只测纯逻辑与注入点：不真的发网络请求。重点钉三件用户能感知的事——
 * 地址/方法校验不放过危险协议、超时与响应上限按约定生效、错误信息可读且不夹带请求内容。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertUrl,
  normalizeHeaders,
  buildRequestOptions,
  headersToObject,
  createHttpBridge,
  registerWorkflowHttpIpc,
} = require("./http-bridge.js");

function fakeResponse({ status = 200, text = "", headers = new Map() } = {}) {
  return {
    status,
    headers,
    text: async () => text,
  };
}

function headerMap(entries) {
  const map = new Map(Object.entries(entries));
  map.forEach = (cb) => {
    for (const [name, value] of Object.entries(entries)) cb(value, name);
  };
  return map;
}

test("assertUrl：只放行 http/https，拒绝本地协议与内嵌口令", () => {
  assert.equal(assertUrl("https://example.com/a?b=1").hostname, "example.com");
  assert.equal(assertUrl("http://127.0.0.1:3000/x").port, "3000");
  for (const bad of ["file:///etc/passwd", "data:text/plain,hi", "blob:https://a/b", "javascript:alert(1)", "unix:///tmp/sock"]) {
    assert.throws(() => assertUrl(bad), /http\/https|合法的 URL/);
  }
  assert.throws(() => assertUrl("https://user:pass@example.com"), /用户名或密码/);
  assert.throws(() => assertUrl(""), /地址为空/);
  assert.throws(() => assertUrl("not a url"), /合法的 URL/);
});

test("normalizeHeaders：只收字符串键值，超量/非字符串直接报错", () => {
  assert.deepEqual(normalizeHeaders(undefined), {});
  assert.deepEqual(normalizeHeaders({ Accept: "application/json" }), { Accept: "application/json" });
  assert.throws(() => normalizeHeaders({ X: 1 }), /必须是字符串/);
  assert.throws(() => normalizeHeaders("nope"), /必须是对象/);
  const many = {};
  for (let i = 0; i < 60; i += 1) many[`h${i}`] = "v";
  assert.throws(() => normalizeHeaders(many), /最多 50 项/);
});

test("buildRequestOptions：方法白名单、超时夹紧、GET 不带体", () => {
  const options = buildRequestOptions({
    method: "post",
    url: "https://example.com/api",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
    timeoutMs: 10,
  });
  assert.equal(options.method, "POST");
  assert.equal(options.timeoutMs, 1000, "低于下限要夹到 1 秒");
  assert.equal(options.body, '{"a":1}');
  assert.equal(options.responseType, "text");

  assert.equal(buildRequestOptions({ url: "https://a.com/x", timeoutMs: 999999 }).timeoutMs, 120000);
  assert.throws(() => buildRequestOptions({ method: "TRACE", url: "https://a.com" }), /不支持的请求方法/);
  assert.throws(() => buildRequestOptions({ url: "https://a.com", method: "GET", body: "x" }), /不能带请求体/);
  assert.throws(() => buildRequestOptions({ url: "https://a.com", body: { a: 1 } }), /请求体必须是字符串/);
});

test("headersToObject：同名多值取第一个", () => {
  const headers = {
    forEach(cb) {
      cb("x", "a");
      cb("y", "b");
      cb("z", "a");
    },
  };
  assert.deepEqual(headersToObject(headers), { a: "x", b: "y" });
  assert.deepEqual(headersToObject(null), {});
});

test("createHttpBridge：成功响应归一（状态码/头/文本/大小）", async () => {
  const calls = [];
  const bridge = createHttpBridge({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fakeResponse({
        status: 201,
        text: '{"ok":true}',
        headers: headerMap({ "content-type": "application/json" }),
      });
    },
  });
  const result = await bridge.request({ method: "POST", url: "https://example.com/x", body: "{}" });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 201);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(result.encoding, "utf8");
  assert.equal(result.truncated, false);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(calls[0].url, "https://example.com/x");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "follow");
});

test("createHttpBridge：响应超过上限时截断并标记", async () => {
  const bridge = createHttpBridge({
    fetchImpl: async () => fakeResponse({ text: "0123456789abcdef" }),
    maxBytes: 10,
  });
  const result = await bridge.request({ url: "https://example.com/big" });
  assert.equal(result.ok, true);
  assert.equal(result.body, "0123456789");
  assert.equal(result.truncated, true);
  assert.equal(result.size, 10);
});

test("createHttpBridge：非 2xx 也照常返回状态码与文本（由节点决定怎么处理）", async () => {
  const bridge = createHttpBridge({ fetchImpl: async () => fakeResponse({ status: 500, text: "boom" }) });
  const result = await bridge.request({ url: "https://example.com/err" });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 500);
  assert.equal(result.body, "boom");
});

test("createHttpBridge：超时/网络错误归一成可读中文且不夹带请求内容", async () => {
  const aborting = createHttpBridge({
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  const timeout = await aborting.request({ url: "https://example.com/slow" });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /请求超时/);

  const failing = createHttpBridge({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND example.invalid");
    },
  });
  const failed = await failing.request({ url: "https://example.invalid/" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /请求失败/);
  assert.doesNotMatch(failed.error, /authorization/i);
});

test("registerWorkflowHttpIpc：IPC 处理器把非法地址收成 {ok:false}，不发请求", async () => {
  const handlers = new Map();
  const secureIpc = { handle: (channel, listener) => handlers.set(channel, listener) };
  registerWorkflowHttpIpc(secureIpc, {
    fetchImpl: async () => fakeResponse({ text: "should not be called" }),
  });
  const handler = handlers.get("workflow:http");
  assert.equal(typeof handler, "function");

  const blocked = await handler({}, { url: "file:///c:/windows/win.ini" });
  assert.equal(blocked.ok, false);

  const ok = await handler({}, { url: "https://example.com/x" });
  assert.equal(ok.ok, true);
  assert.equal(ok.body, "should not be called");
});
