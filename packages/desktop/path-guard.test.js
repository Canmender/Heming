/**
 * 共享路径判定的测试。
 *
 * 这一层是「越界」的最后一道：`wiki-fs.js`（知识库）与 `file-fs.js`（文件编辑）
 * 现在共用 `resolveInsideRoot`，所以必须钉住两件事：
 * 1. 抽取后行为与抽取前（`wiki-fs.js:42-51`）逐字一致；
 * 2. 绝对路径的判定（`checkAbsoluteInside`）能挡住根外、软链祖先等越界形态。
 *
 * 运行：`node --test path-guard.test.js`
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const guard = require("./path-guard.js");
const { resolveInsideRoot, isInsideRoot, checkAbsoluteInside, isReservedName, assertNoSymlinkAncestor } =
  guard;

/** 临时根目录（每个用例一个，用完删）。 */
function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-guard-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveInsideRoot：根内相对路径解析成绝对路径", () => {
  withTempRoot((root) => {
    assert.equal(resolveInsideRoot(root, "notes/a.md"), path.join(root, "notes", "a.md"));
    assert.equal(resolveInsideRoot(root, "notes\\a.md"), path.join(root, "notes", "a.md"));
  });
});

test("resolveInsideRoot：`..` 跑出根目录返回 null", () => {
  withTempRoot((root) => {
    assert.equal(resolveInsideRoot(root, "../evil.md"), null);
    assert.equal(resolveInsideRoot(root, "notes/../../evil.md"), null);
    assert.equal(resolveInsideRoot(root, "..\\evil.md"), null);
  });
});

test("resolveInsideRoot：NUL、空、超长返回 null", () => {
  withTempRoot((root) => {
    assert.equal(resolveInsideRoot(root, "a\u0000b.md"), null);
    assert.equal(resolveInsideRoot(root, ""), null);
    assert.equal(resolveInsideRoot(root, "a".repeat(400)), null);
    assert.equal(resolveInsideRoot(root, "."), null);
    assert.equal(resolveInsideRoot(root, "./"), null);
  });
});

test("resolveInsideRoot：前导斜杠被剥掉（保留 wiki 既有语义，不是漏洞而是口径）", () => {
  withTempRoot((root) => {
    // wiki 侧本来就只接受相对路径，剥前导斜杠是为了挡 Windows 风格绝对路径；
    // 这里钉住这个既有行为，避免有人「顺手改成返回 null」而导致知识库写入静默失败。
    assert.equal(resolveInsideRoot(root, "/notes/a.md"), path.join(root, "notes", "a.md"));
  });
});

test("两处判定对同一组路径结论一致（wiki-fs 与 path-guard 共用同一实现）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-wiki-"));
  const prev = process.env.HEMING_WIKI_DIR;
  process.env.HEMING_WIKI_DIR = dir;
  try {
    // wiki-fs 在模块加载后按环境变量取根，故重置缓存再 require
    delete require.cache[require.resolve("./wiki-fs.js")];
    const wiki = require("./wiki-fs.js");
    const samples = [
      "index.md",
      "wiki/concepts/llm.md",
      "raw/来源.md",
      "../逃逸.md",
      "wiki/../index.md",
      "a\u0000b.md",
      "",
      "notes/../../out.md",
    ];
    for (const rel of samples) {
      assert.equal(
        wiki.resolveInside(rel),
        resolveInsideRoot(wiki.wikiRoot(), rel),
        `两处判定对 ${JSON.stringify(rel)} 的结论必须一致`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.HEMING_WIKI_DIR;
    else process.env.HEMING_WIKI_DIR = prev;
    delete require.cache[require.resolve("./wiki-fs.js")];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isInsideRoot：同前缀不同目录不算在根内", () => {
  withTempRoot((root) => {
    assert.equal(isInsideRoot(root, path.join(root, "a.md")), true);
    assert.equal(isInsideRoot(root, path.join(root, "..", "别处", "a.md")), false);
    assert.equal(isInsideRoot(root, `${root}2/a.md`), false);
    assert.equal(isInsideRoot(root, root), false);
  });
});

test("checkAbsoluteInside：绝对路径、NUL、相对路径、超长都按原因拒绝", () => {
  withTempRoot((root) => {
    assert.equal(checkAbsoluteInside(path.join(root, "a.md"), root).ok, true);
    assert.equal(checkAbsoluteInside(path.join(root, "..", "a.md"), root).ok, false);
    assert.equal(checkAbsoluteInside("a.md", root).ok, false);
    assert.equal(checkAbsoluteInside("", root).ok, false);
    assert.equal(checkAbsoluteInside(`${root}/a\u0000b.md`, root).ok, false);
    assert.equal(checkAbsoluteInside(path.join(root, "a".repeat(320)), root).ok, false);
  });
});

test("assertNoSymlinkAncestor：未创建的目标放行，普通路径放行", () => {
  withTempRoot((root) => {
    assert.equal(assertNoSymlinkAncestor(root, path.join(root, "new", "a.md")).ok, true);
    fs.mkdirSync(path.join(root, "notes"));
    fs.writeFileSync(path.join(root, "notes", "a.md"), "内容");
    assert.equal(assertNoSymlinkAncestor(root, path.join(root, "notes", "a.md")).ok, true);
  });
});

test("assertNoSymlinkAncestor：祖先目录是软链时拒绝（否则根被一个链接绕出去）", (t) => {
  withTempRoot((root) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-outside-"));
    try {
      const linked = path.join(root, "linked");
      // Windows 上普通目录软链要管理员/开发者模式；junction 不需要，且 lstat 同样报 isSymbolicLink。
      try {
        fs.symlinkSync(outside, linked, "dir");
      } catch {
        try {
          fs.symlinkSync(outside, linked, "junction");
        } catch (e) {
          t.skip(`当前环境不能创建目录链接（${e.code}），跳过`);
          return;
        }
      }
      const result = assertNoSymlinkAncestor(root, path.join(linked, "a.md"));
      assert.equal(result.ok, false);
      assert.match(result.error, /符号链接/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("assertNoSymlinkAncestor：根的上级路径不在检查范围（只管根以内）", () => {
  withTempRoot((root) => {
    // 根自身可以是任意路径（含上级有软链），检查从根开始
    assert.equal(assertNoSymlinkAncestor(root, path.join(root, "a.md")).ok, true);
  });
});

test("isReservedName：Windows 保留名", () => {
  assert.equal(isReservedName("con.md"), true);
  assert.equal(isReservedName("NUL"), true);
  assert.equal(isReservedName("com1.txt"), true);
  assert.equal(isReservedName("console.md"), false);
  assert.equal(isReservedName("笔记.md"), false);
});
