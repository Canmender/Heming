"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { packTarGz, unpackTarGz, LIMITS } = require("./plugin-tar");
const { readModulePackage } = require("./module-package");
const { makeSignedModule } = require("./module-fixture.test-helper");

function repack(bytes, mutate) {
  const entries = unpackTarGz(bytes, LIMITS);
  const next = mutate(entries.map((entry) => ({ ...entry })));
  return packTarGz(next);
}

function manifestOf(bytes) {
  const entry = unpackTarGz(bytes, LIMITS).find((item) => item.path === "module.json");
  return JSON.parse(entry.data.toString("utf8"));
}

test("模块包：签名与 files 摘要都对得上 → 接受并返回文件表", () => {
  const { bytes, keysFile } = makeSignedModule();
  const pkg = readModulePackage(bytes, { keysFile, allowDevKeys: true });
  assert.equal(pkg.manifest.id, "heming.infohub-engine");
  assert.equal(pkg.manifest.version, "1.0.0");
  assert.equal(pkg.entries.length, 2);
  assert.ok(pkg.entries.every((entry) => entry.path.startsWith("files/")));
  assert.equal(pkg.keyId, "dev-test-fixture");
});

test("模块包：files 被替换 → 摘要不一致，拒绝安装", () => {
  const { bytes, keysFile } = makeSignedModule();
  const tampered = repack(bytes, (entries) =>
    entries.map((entry) =>
      entry.path === "files/app/infohub/__init__.py"
        ? { ...entry, data: Buffer.from("__version__ = '9.9.9'\n") }
        : entry,
    ),
  );
  assert.throws(
    () => readModulePackage(tampered, { keysFile, allowDevKeys: true }),
    /packageSha256 与模块包内容不一致/,
  );
});

test("模块包：没有签名 → 拒绝", () => {
  const { bytes, keysFile } = makeSignedModule();
  const unsigned = repack(bytes, (entries) =>
    entries.map((entry) => {
      if (entry.path !== "module.json") return entry;
      const manifest = JSON.parse(entry.data.toString("utf8"));
      delete manifest.signature;
      return { ...entry, data: Buffer.from(JSON.stringify(manifest), "utf8") };
    }),
  );
  assert.throws(
    () => readModulePackage(unsigned, { keysFile, allowDevKeys: true }),
    /未通过首方签名.*未签名/,
  );
});

test("模块包：id 与期望不符 → 拒绝", () => {
  const { bytes, keysFile } = makeSignedModule();
  assert.throws(
    () => readModulePackage(bytes, { keysFile, allowDevKeys: true, expectedId: "heming.other" }),
    /id 不匹配/,
  );
});

test("模块包：distribution 不是 module → 拒绝", () => {
  const { bytes, keysFile } = makeSignedModule();
  const wrong = repack(bytes, (entries) =>
    entries.map((entry) => {
      if (entry.path !== "module.json") return entry;
      const manifest = JSON.parse(entry.data.toString("utf8"));
      manifest.distribution = "bundle";
      return { ...entry, data: Buffer.from(JSON.stringify(manifest), "utf8") };
    }),
  );
  assert.throws(
    () => readModulePackage(wrong, { keysFile, allowDevKeys: true }),
    /distribution 必须是/,
  );
});

test("模块包：meta.entry/lib 只能是 files/ 下的单层目录名", () => {
  const { bytes, keysFile } = makeSignedModule();
  for (const key of ["entry", "lib"]) {
    const escaped = repack(bytes, (entries) =>
      entries.map((entry) => {
        if (entry.path !== "module.json") return entry;
        const manifest = JSON.parse(entry.data.toString("utf8"));
        manifest.meta = { ...manifest.meta, [key]: "../../.." };
        return { ...entry, data: Buffer.from(JSON.stringify(manifest), "utf8") };
      }),
    );
    assert.throws(
      () => readModulePackage(escaped, { keysFile, allowDevKeys: true }),
      new RegExp(`meta\\.${key} 必须是`),
    );
  }
});

test("模块包：根目录出现多余文件 → 拒绝", () => {
  const { bytes, keysFile } = makeSignedModule();
  const entries = unpackTarGz(bytes, LIMITS);
  const extra = packTarGz([...entries, { path: "notes.txt", data: Buffer.from("x") }]);
  assert.throws(
    () => readModulePackage(extra, { keysFile, allowDevKeys: true }),
    /非法路径/,
  );
});

test("模块包：非 tar.gz 字节 → 可读错误", () => {
  assert.throws(() => readModulePackage(Buffer.from("not a tgz")), /不是合法的 tar\.gz/);
});

test("模块包：清单字段齐全（id/version/meta）", () => {
  const { bytes } = makeSignedModule();
  const manifest = manifestOf(bytes);
  assert.equal(manifest.meta.kind, "module");
  assert.equal(manifest.meta.entry, "app");
  assert.equal(manifest.meta.lib, "lib");
});
