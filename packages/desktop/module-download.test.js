"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { downloadModule, moduleUrl } = require("./module-download");

function tempFile(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-module-dl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "module.tgz");
  fs.writeFileSync(file, bytes);
  return file;
}

function responseOf(chunks, { status = 200, headers = {} } = {}) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
        cancel: async () => {},
      }),
    },
  };
}

test("地址拼接：base 末尾斜杠不影响", () => {
  assert.equal(moduleUrl("http://x/updates/modules/", "a.b", "1.0.0"), "http://x/updates/modules/a.b/1.0.0/module.tgz");
  assert.equal(moduleUrl("http://x/updates/modules", "a.b", "1.0.0"), "http://x/updates/modules/a.b/1.0.0/module.tgz");
});

test("本地文件：绝对路径与 file:// 都能读，并回报进度", async (t) => {
  const file = tempFile(t, Buffer.from("payload"));
  const events = [];
  const fromPath = await downloadModule({ url: file, onProgress: (e) => events.push(e) });
  const fromUrl = await downloadModule({ url: pathToFileURL(file).href });
  assert.equal(fromPath.toString(), "payload");
  assert.equal(fromUrl.toString(), "payload");
  assert.deepEqual(events, [{ received: 7, total: 7 }]);
});

test("本地文件不存在：可读错误", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-module-dl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => downloadModule({ url: path.join(dir, "missing.tgz") }),
    /读取本地模块包失败/,
  );
});

test("HTTP：流式读取并按累计字节回报进度", async () => {
  const events = [];
  const bytes = await downloadModule({
    url: "http://example.test/module.tgz",
    fetchImpl: async () =>
      responseOf([Buffer.from("abc"), Buffer.from("de")], {
        headers: { "content-length": "5" },
      }),
    onProgress: (event) => events.push(event),
  });
  assert.equal(bytes.toString(), "abcde");
  assert.deepEqual(events, [
    { received: 3, total: 5 },
    { received: 5, total: 5 },
  ]);
});

test("HTTP：非 2xx 直接失败，不返回半个包", async () => {
  await assert.rejects(
    () => downloadModule({ url: "http://example.test/module.tgz", fetchImpl: async () => responseOf([], { status: 404 }) }),
    /HTTP 404/,
  );
});

test("HTTP：超过上限（声明或实际）都拒绝", async () => {
  await assert.rejects(
    () =>
      downloadModule({
        url: "http://example.test/module.tgz",
        maxBytes: 2,
        fetchImpl: async () => responseOf([Buffer.from("abc")]),
      }),
    /模块包过大/,
  );
});

test("不支持的地址：明确拒绝", async () => {
  await assert.rejects(() => downloadModule({ url: "ftp://x/y.tgz" }), /不支持的模块包地址/);
});
