"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createModuleStore } = require("./module-store");
const { makeSignedModule } = require("./module-fixture.test-helper");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-modules-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("安装：写入版本目录并登记，current 给出 app/lib 目录", (t) => {
  const dir = tempDir(t);
  const store = createModuleStore({ dir });
  const { bytes, keysFile } = makeSignedModule();

  const installed = store.install(bytes, {
    keysFile,
    allowDevKeys: true,
    expectedId: "heming.infohub-engine",
  });
  assert.equal(installed.version, "1.0.0");
  assert.ok(fs.existsSync(path.join(installed.appDir, "infohub", "__init__.py")));
  assert.ok(fs.existsSync(installed.libDir));

  const registry = JSON.parse(fs.readFileSync(path.join(dir, "installed.json"), "utf8"));
  assert.equal(registry.modules.length, 1);
  assert.equal(registry.modules[0].id, "heming.infohub-engine");
  assert.equal(registry.modules[0].entry, "app");
  assert.equal(registry.modules[0].lib, "lib");
  assert.match(registry.modules[0].packageSha256, /^[0-9a-f]{64}$/);
});

test("升级：切换版本后旧版本目录被清理", (t) => {
  const dir = tempDir(t);
  const store = createModuleStore({ dir });
  const v1 = makeSignedModule({ manifest: { version: "1.0.0" } });
  const v2 = makeSignedModule({ manifest: { version: "1.0.1" } });

  store.install(v1.bytes, { keysFile: v1.keysFile, allowDevKeys: true });
  const installed = store.install(v2.bytes, { keysFile: v2.keysFile, allowDevKeys: true });

  assert.equal(installed.version, "1.0.1");
  const versions = fs.readdirSync(path.join(dir, "heming.infohub-engine"));
  assert.deepEqual(versions, ["1.0.1"]);
});

test("安装失败：不写注册表、不留半个版本目录", (t) => {
  const dir = tempDir(t);
  const store = createModuleStore({ dir });
  const { bytes, keysFile } = makeSignedModule();
  const broken = Buffer.from(bytes.subarray(0, bytes.length - 16));

  assert.throws(() => store.install(broken, { keysFile, allowDevKeys: true }));
  assert.equal(store.current("heming.infohub-engine"), null);
  assert.equal(fs.existsSync(path.join(dir, "heming.infohub-engine")), false);
  assert.equal(fs.existsSync(path.join(dir, "installed.json")), false);
});

test("引擎目录被手工删除：current 按未安装处理", (t) => {
  const dir = tempDir(t);
  const store = createModuleStore({ dir });
  const { bytes, keysFile } = makeSignedModule();
  const installed = store.install(bytes, { keysFile, allowDevKeys: true });
  fs.rmSync(installed.appDir, { recursive: true, force: true });
  assert.equal(store.current("heming.infohub-engine"), null);
});

test("卸载：删登记与目录", (t) => {
  const dir = tempDir(t);
  const store = createModuleStore({ dir });
  const { bytes, keysFile } = makeSignedModule();
  store.install(bytes, { keysFile, allowDevKeys: true });

  assert.equal(store.remove("heming.infohub-engine"), true);
  assert.equal(store.current("heming.infohub-engine"), null);
  assert.equal(store.remove("heming.infohub-engine"), false);
  assert.equal(fs.existsSync(path.join(dir, "heming.infohub-engine")), false);
});
