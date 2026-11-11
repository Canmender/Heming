"use strict";
/**
 * 选装引擎（信息中枢）的安装编排：模块源 → 下载 → 验签 → 落盘 → 给出 app/lib 目录。
 * 不启动进程（桥负责），但「装好之后下一次 start 能看到」是这条链的关键。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createInfohubEngine, ENGINE_ID, ENGINE_VERSION } = require("./infohub-engine");
const { makeSignedModule } = require("./module-fixture.test-helper");

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFeed(feedDir, fixture, version = ENGINE_VERSION) {
  const target = join(feedDir, ENGINE_ID, version);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "module.tgz"), fixture.bytes);
}

test("ensure：从模块源下载、验签、装好并给出 app/lib", async () => {
  const feed = tempDir("heming-feed-");
  const dir = tempDir("heming-modules-");
  const fixture = makeSignedModule({ manifest: { id: ENGINE_ID } });
  writeFeed(feed, fixture);
  try {
    const stages = [];
    const engine = createInfohubEngine({
      dir,
      base: feed,
      keysFile: fixture.keysFile,
      allowDevKeys: true,
      broadcast: (event) => stages.push(event.stage),
    });

    assert.equal(engine.info().installed, false);
    const result = await engine.ensure();

    assert.equal(result.installed, true);
    assert.equal(result.updated, true);
    assert.equal(result.version, ENGINE_VERSION);
    const dirs = engine.dirs();
    assert.ok(dirs.packageDir.endsWith(join("files", "app")), `appDir=${dirs.packageDir}`);
    assert.ok(dirs.libraryDir.endsWith(join("files", "lib")), `libDir=${dirs.libraryDir}`);
    assert.deepEqual(stages, ["download", "download", "install", "done"]);

    // 已是最新：第二次不再广播下载
    const again = await engine.ensure();
    assert.equal(again.updated, false);
    assert.equal(stages.length, 4);
  } finally {
    rmSync(feed, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture.keysFile, { force: true });
  }
});

test("ensure：模块源里没有包 → 可读错误，且不留下半个版本", async () => {
  const feed = tempDir("heming-feed-");
  const dir = tempDir("heming-modules-");
  try {
    const engine = createInfohubEngine({ dir, base: feed });
    await assert.rejects(() => engine.ensure(), /读取本地模块包失败|模块包下载失败/);
    assert.equal(engine.info().installed, false);
    assert.equal(engine.dirs().packageDir, "");
  } finally {
    rmSync(feed, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发 ensure：共用一次下载安装", async () => {
  const feed = tempDir("heming-feed-");
  const dir = tempDir("heming-modules-");
  const fixture = makeSignedModule({ manifest: { id: ENGINE_ID } });
  writeFeed(feed, fixture);
  try {
    const engine = createInfohubEngine({ dir, base: feed, keysFile: fixture.keysFile, allowDevKeys: true });
    const [a, b] = await Promise.all([engine.ensure(), engine.ensure()]);
    assert.equal(a.installed, true);
    assert.equal(b.installed, true);
    assert.equal(readFileSync(join(dir, ENGINE_ID, ENGINE_VERSION, "files", "app", "infohub", "__init__.py"), "utf8").includes("0.0.0"), true);
  } finally {
    rmSync(feed, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture.keysFile, { force: true });
  }
});
