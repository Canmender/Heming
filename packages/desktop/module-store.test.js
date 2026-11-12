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

/** 造一份「改名前的桌面端」留下的安装：旧包 id 的目录 + installed.json 记录。 */
function writeLegacyInstall(dir, ids) {
  for (const id of ids) {
    const webDir = path.join(dir, id, "1.0.0", "files", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, "entry.js"), "export {};\n");
  }
  const modules = ids.map((id) => ({
    id,
    version: "1.0.0",
    name: id,
    entry: "app",
    lib: "lib",
    web: { entry: "files/web/entry.js", contributions: ["page"] },
    packageSha256: "0".repeat(64),
    installedAt: "2026-01-01T00:00:00.000Z",
  }));
  fs.writeFileSync(path.join(dir, "installed.json"), `${JSON.stringify({ modules }, null, 2)}\n`);
}

test("旧包 id 迁移：infohub/automations 的目录与登记改到 heming.* 前缀，staff/workflows 不动", (t) => {
  const dir = tempDir(t);
  writeLegacyInstall(dir, ["staff", "automations", "infohub", "workflows"]);
  const store = createModuleStore({ dir });

  assert.equal(store.find("infohub"), null);
  assert.equal(store.find("automations"), null);
  assert.equal(store.find("heming.infohub").version, "1.0.0");
  assert.equal(store.find("heming.automations").version, "1.0.0");
  assert.ok(fs.existsSync(path.join(dir, "heming.infohub", "1.0.0", "files", "web", "entry.js")));
  assert.ok(fs.existsSync(path.join(dir, "heming.automations", "1.0.0", "files", "web", "entry.js")));
  assert.equal(fs.existsSync(path.join(dir, "infohub")), false);
  assert.equal(fs.existsSync(path.join(dir, "automations")), false);
  // 迁移后的记录要能正常解析出当前安装（不是幽灵记录）
  assert.ok(store.current("heming.infohub"));
  assert.equal(store.current("heming.automations").version, "1.0.0");
  // staff / workflows 仍是旧模块 id（只保留数据兼容），不参与改名
  assert.equal(store.find("staff").version, "1.0.0");
  assert.equal(store.find("workflows").version, "1.0.0");
  assert.ok(fs.existsSync(path.join(dir, "staff", "1.0.0", "files", "web", "entry.js")));
});

test("旧包 id 迁移可重复执行（幂等）：第二次启动不再改写登记", (t) => {
  const dir = tempDir(t);
  writeLegacyInstall(dir, ["infohub"]);
  createModuleStore({ dir });
  const before = fs.readFileSync(path.join(dir, "installed.json"), "utf8");

  const store = createModuleStore({ dir });
  assert.equal(fs.readFileSync(path.join(dir, "installed.json"), "utf8"), before);
  assert.deepEqual(
    store.registry().map((item) => item.id),
    ["heming.infohub"],
  );
});

test("旧包 id 迁移：新 id 已有安装时不产生重复记录，旧目录作废", (t) => {
  const dir = tempDir(t);
  writeLegacyInstall(dir, ["infohub"]);
  // 用户已经在新 id 下重装过一份（新版 1.1.0）
  const newWebDir = path.join(dir, "heming.infohub", "1.1.0", "files", "web");
  fs.mkdirSync(newWebDir, { recursive: true });
  fs.writeFileSync(path.join(newWebDir, "entry.js"), "export {};\n");
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "installed.json"), "utf8"));
  raw.modules.push({
    id: "heming.infohub",
    version: "1.1.0",
    name: "信息中枢",
    web: { entry: "files/web/entry.js", contributions: ["page"] },
    packageSha256: "1".repeat(64),
    installedAt: "2026-02-01T00:00:00.000Z",
  });
  fs.writeFileSync(path.join(dir, "installed.json"), JSON.stringify(raw));

  const store = createModuleStore({ dir });
  assert.equal(store.registry().filter((item) => item.id === "heming.infohub").length, 1);
  assert.equal(store.find("heming.infohub").version, "1.1.0");
  assert.equal(fs.existsSync(path.join(dir, "infohub")), false);
});

test("旧包 id 迁移：旧目录已被手工删除时只改登记，不崩", (t) => {
  const dir = tempDir(t);
  writeLegacyInstall(dir, ["automations"]);
  fs.rmSync(path.join(dir, "automations"), { recursive: true, force: true });

  const store = createModuleStore({ dir });
  assert.equal(store.find("heming.automations").version, "1.0.0");
  // 目录缺失按未安装处理，与旧 id 口径一致
  assert.equal(store.current("heming.automations"), null);
});
