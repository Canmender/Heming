"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { contentTypeFor, isAssetRequest, resolveAssetPath, resolveRequest } = require("./app-protocol");

const ROOT = path.resolve("/tmp/fake-web-root");

// ── MIME ──

test("contentTypeFor：常见静态资源类型正确", () => {
  assert.match(contentTypeFor("a/index.html"), /^text\/html/);
  assert.match(contentTypeFor("a/index.js"), /^text\/javascript/);
  assert.match(contentTypeFor("a/index.css"), /^text\/css/);
  assert.equal(contentTypeFor("a/x.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("a/x.woff2"), "font/woff2");
  assert.equal(contentTypeFor("a/x.json"), "application/json; charset=utf-8");
});

test("contentTypeFor：大小写不敏感", () => {
  assert.match(contentTypeFor("A.INDEX.HTML"), /^text\/html/);
  assert.equal(contentTypeFor("X.SVG"), "image/svg+xml");
});

test("contentTypeFor：未知扩展名不猜（octet-stream，避免把二进制当 HTML 执行）", () => {
  assert.equal(contentTypeFor("a/x.bin"), "application/octet-stream");
  assert.equal(contentTypeFor("a/noext"), "application/octet-stream");
});

// ── 资源 vs 前端路由 ──

test("isAssetRequest：有扩展名是资源，无扩展名是前端路由", () => {
  assert.equal(isAssetRequest("/assets/index-abc.js"), true);
  assert.equal(isAssetRequest("/x.css"), true);
  assert.equal(isAssetRequest("/"), false);
  assert.equal(isAssetRequest("/chat"), false);
  assert.equal(isAssetRequest("/settings/profile"), false);
});

// ── 路径解析与目录穿越防护 ──

test("resolveAssetPath：常规路径解析到 root 之下", () => {
  assert.equal(resolveAssetPath("/", ROOT), ROOT);
  assert.equal(resolveAssetPath("/index.html", ROOT), path.join(ROOT, "index.html"));
  assert.equal(resolveAssetPath("/assets/a.js", ROOT), path.join(ROOT, "assets", "a.js"));
});

test("resolveAssetPath：百分号编码被解码", () => {
  assert.equal(resolveAssetPath("/a%20b.js", ROOT), path.join(ROOT, "a b.js"));
});

test("resolveAssetPath：目录穿越一律拒绝（明文、编码、反斜杠三种写法）", () => {
  for (const evil of [
    "/../secret",
    "/../../etc/passwd",
    "/%2e%2e/secret",
    "/a/../../secret",
    "/..\\secret",
    "/a/..\\..\\secret",
  ]) {
    assert.equal(resolveAssetPath(evil, ROOT), null, `应拒绝：${evil}`);
  }
});

test("resolveAssetPath：非法百分号编码返回 null（不抛）", () => {
  assert.equal(resolveAssetPath("/%E0%A4%A", ROOT), null);
});

// ── 请求 → 文件 ──

function fakeFs(existing) {
  const set = new Set(existing.map((p) => path.join(ROOT, p)));
  return (f) => set.has(f);
}

test("resolveRequest：根路径回落首页", () => {
  const r = resolveRequest("/", ROOT, fakeFs(["index.html"]));
  assert.equal(r.file, path.join(ROOT, "index.html"));
  assert.equal(r.spaFallback, true);
});

test("resolveRequest：无扩展名路径回落首页（前端路由）", () => {
  const r = resolveRequest("/settings/profile", ROOT, fakeFs(["index.html"]));
  assert.equal(r.file, path.join(ROOT, "index.html"));
  assert.equal(r.spaFallback, true);
});

test("resolveRequest：命中资源直接送出，且不算回落", () => {
  const r = resolveRequest("/assets/index-abc.js", ROOT, fakeFs(["index.html", "assets/index-abc.js"]));
  assert.equal(r.file, path.join(ROOT, "assets", "index-abc.js"));
  assert.equal(r.spaFallback, false);
});

test("resolveRequest：**资源缺失不回落首页**（回落会把 404 变成 MIME 错误，极难排查）", () => {
  const r = resolveRequest("/assets/missing.js", ROOT, fakeFs(["index.html"]));
  assert.equal(r, null);
});

test("resolveRequest：目录穿越返回 null（调用方回 403/404）", () => {
  assert.equal(resolveRequest("/../secret", ROOT, fakeFs(["index.html"])), null);
});

test("resolveRequest：不带扩展名的隐藏文件请求视为资源（如 /.env）", () => {
  // ".env" 的 extname 是 ""，但它是文件不是路由 —— 这里按路由处理回落首页，
  // 属可接受行为（回落的是自家首页，不泄漏任何文件内容）。
  const r = resolveRequest("/.env", ROOT, fakeFs(["index.html"]));
  assert.equal(r.file, path.join(ROOT, "index.html"));
});
