"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createModuleInstaller, DEFAULT_FEED } = require("./module-installer");

function fakeStore() {
  const records = new Map();
  return {
    install(bytes, options) {
      const record = { id: options.expectedId, version: "1.0.0", bytes: bytes.length };
      records.set(record.id, record);
      return record;
    },
    registry: () => [...records.values()],
    remove: (id) => records.delete(id),
    records,
  };
}

test("module-installer：下载官方源路径并交给 module-store 安装", async () => {
  const store = fakeStore();
  const calls = [];
  const installer = createModuleInstaller({
    store,
    feed: "http://example.test/modules/",
    download: async ({ url, onProgress }) => {
      calls.push(url);
      onProgress?.({ received: 1, total: 2 });
      return Buffer.from("module-bytes");
    },
  });
  const record = await installer.install("staff", "1.0.0");
  assert.equal(calls[0], "http://example.test/modules/staff/1.0.0/module.tgz");
  assert.equal(record.id, "staff");
  assert.equal(record.bytes, Buffer.byteLength("module-bytes"));
  assert.equal(installer.list().length, 1);
  assert.equal(installer.remove("staff"), true);
  assert.equal(installer.list().length, 0);
});

test("module-installer：非法 id/version 直接拒绝，不发起下载", async () => {
  let downloads = 0;
  const installer = createModuleInstaller({
    store: fakeStore(),
    download: async () => {
      downloads += 1;
      return Buffer.from("x");
    },
  });
  await assert.rejects(() => installer.install("../evil", "1.0.0"), /id 不合法/);
  await assert.rejects(() => installer.install("staff", "../1"), /版本不合法/);
  assert.equal(downloads, 0);
  assert.match(DEFAULT_FEED, /47\.92\.39\.184/);
});

test("module-installer：同一 id@version 并发安装只下载一次", async () => {
  const store = fakeStore();
  let downloads = 0;
  const installer = createModuleInstaller({
    store,
    download: async () => {
      downloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Buffer.from("x");
    },
  });
  const [a, b] = await Promise.all([
    installer.install("staff", "1.0.0"),
    installer.install("staff", "1.0.0"),
  ]);
  assert.equal(downloads, 1);
  assert.equal(a, b);
});
