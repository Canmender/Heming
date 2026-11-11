"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ensureDataLayout, migrateUserData, resolveDataRoot, seedWikiRules } = require("./data-root");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `heming-${prefix}-`));
}

test("resolveDataRoot：打包版默认安装目录/data；开发态不改默认；环境变量优先", () => {
  assert.equal(resolveDataRoot({ isPackaged: true, execDir: "D:\\Apps\\和鸣", env: {} }), path.join("D:\\Apps\\和鸣", "data"));
  assert.equal(resolveDataRoot({ isPackaged: false, execDir: "D:\\repo", env: {} }), "");
  assert.equal(
    resolveDataRoot({ isPackaged: true, execDir: "D:\\Apps\\和鸣", env: { HEMING_DATA_ROOT: "E:\\heming-data" } }),
    path.resolve("E:\\heming-data"),
  );
});

test("ensureDataLayout：建 data/wiki 与 data/logs", () => {
  const root = tmpDir("layout");
  const layout = ensureDataLayout(root);
  assert.ok(fs.statSync(layout.wikiRoot).isDirectory());
  assert.ok(fs.statSync(layout.logsDir).isDirectory());
  assert.equal(layout.wikiRoot, path.join(root, "wiki"));
});

test("migrateUserData：只补目标不存在条目，不覆盖新根已有数据", () => {
  const oldDir = tmpDir("old");
  const newDir = tmpDir("new");
  fs.mkdirSync(path.join(oldDir, "Local Storage"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "Local Storage", "token.txt"), "old-login");
  fs.mkdirSync(path.join(oldDir, "IndexedDB"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "IndexedDB", "db.bin"), "old-db");
  fs.mkdirSync(path.join(oldDir, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "Cache", "junk.bin"), "cache");

  const copied = migrateUserData(oldDir, newDir);
  assert.deepEqual(copied.sort(), ["IndexedDB", "Local Storage"]);
  assert.equal(fs.readFileSync(path.join(newDir, "Local Storage", "token.txt"), "utf8"), "old-login");
  assert.equal(fs.existsSync(path.join(newDir, "Cache")), false, "缓存目录不应迁移");

  // 新根已有数据：不覆盖
  fs.writeFileSync(path.join(newDir, "IndexedDB", "db.bin"), "new-db");
  const again = migrateUserData(oldDir, newDir);
  assert.deepEqual(again, [], "目标已存在同名条目时不再复制");
  assert.equal(fs.readFileSync(path.join(newDir, "IndexedDB", "db.bin"), "utf8"), "new-db");
});

test("seedWikiRules：只补缺，不覆盖用户修改", () => {
  const root = tmpDir("wiki");
  const source = path.join(root, "source.md");
  fs.writeFileSync(source, "# 原始规则\n");
  const wikiRoot = path.join(root, "data", "wiki");
  const target = seedWikiRules(wikiRoot, source);
  assert.equal(fs.readFileSync(target, "utf8"), "# 原始规则\n");
  fs.writeFileSync(target, "# 用户改过的规则\n");
  seedWikiRules(wikiRoot, source);
  assert.equal(fs.readFileSync(target, "utf8"), "# 用户改过的规则\n");
});
