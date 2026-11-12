"use strict";
/**
 * statTree 的回归测试。
 *
 * 这里只用真实临时目录，不 mock fs：两个失败过的点（串行 stat 太慢、
 * maxFiles 截断语义）都只有真实文件系统能暴露出来。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { statTree, STAT_CONCURRENCY } = require("./dir-stats");
const { CODES } = require("./errors");

/** 建一棵 {相对路径: 内容} 描述的临时树。 */
async function makeTree(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "heming-dirstats-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  return root;
}

test("统计嵌套目录里的文件数与总字节数", async () => {
  const root = await makeTree({
    "a.txt": "12345",
    "sub/b.txt": "1234",
    "sub/deep/c.txt": "123",
  });
  const stats = await statTree(root);
  assert.equal(stats.files, 3);
  assert.equal(stats.bytes, 12);
  assert.equal(stats.complete, true);
  await fsp.rm(root, { recursive: true, force: true });
});

test("根目录还不存在时返回零，而不是抛错", async () => {
  const root = path.join(os.tmpdir(), "heming-dirstats-missing", String(Date.now()));
  const stats = await statTree(root);
  assert.deepEqual(stats, { files: 0, bytes: 0, complete: true });
});

test("超过 maxFiles 时截断并标记 complete=false", async () => {
  const root = await makeTree({
    "1.txt": "1",
    "2.txt": "1",
    "3.txt": "1",
    "4.txt": "1",
  });
  const stats = await statTree(root, { maxFiles: 2 });
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, 2);
  assert.equal(stats.complete, false);
  await fsp.rm(root, { recursive: true, force: true });
});

test("已取消的信号会立即抛 CANCELLED，而不是扫完整棵树", async () => {
  const root = await makeTree({ "1.txt": "1", "2.txt": "1" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => statTree(root, { signal: controller.signal }), (error) => {
    assert.equal(error.code, CODES.CANCELLED);
    return true;
  });
  await fsp.rm(root, { recursive: true, force: true });
});

test("并发上限常量是个小整数（别把线程池排满成队列）", () => {
  assert.ok(Number.isInteger(STAT_CONCURRENCY));
  assert.ok(STAT_CONCURRENCY >= 4);
  assert.ok(STAT_CONCURRENCY <= 16);
});
