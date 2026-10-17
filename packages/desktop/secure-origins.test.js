"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { APP_DEFAULT_URL, originOf, secureOrigins } = require("./secure-origins");

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
