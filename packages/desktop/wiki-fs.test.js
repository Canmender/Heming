"use strict";
/**
 * 个人知识库文件桥（wiki-fs.js）的定向用例。
 *
 * ③-4 安全复审补的边界：路径夹取、白名单、内容长度/字符上限、log 行字段规范化。
 * 这些校验是「渲染层（网页内容）→ 主进程写盘」的最后一道，必须在主进程侧有测试。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerWikiIpc, resolveInside, isAllowedRel, wikiRoot } = require("./wiki-fs");

/** 每个用例一个临时 wiki 根（通过 HEMING_WIKI_DIR 指过去）。 */
async function withWiki(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-wiki-"));
  const prev = process.env.HEMING_WIKI_DIR;
  process.env.HEMING_WIKI_DIR = dir;
  try {
    const handlers = new Map();
    registerWikiIpc({
      handle: (ch, fn) => handlers.set(ch, fn),
      on: () => {},
    });
    return await fn({ dir, call: (ch, ...args) => handlers.get(ch)({}, ...args) });
  } finally {
    if (prev === undefined) delete process.env.HEMING_WIKI_DIR;
    else process.env.HEMING_WIKI_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ─────────────────────── 路径夹取与白名单 ─────────────────────── */

test("resolveInside：真越界写法返回 null（.. 逃逸 / 盘符绝对路径 / NUL / 超长 / 空）", () => {
  for (const bad of [
    "../escape.md",
    "raw/../../escape.md",
    "C:/Windows/x.md",
    "raw/a\0b.md",
    "x".repeat(400),
    "",
    null,
    undefined,
  ]) {
    assert.equal(resolveInside(bad), null, String(bad));
  }
  // 前导斜杠/反斜杠会被归一成相对路径（收进根内，不越界）——这是与抽取前逐字一致的口径：
  // wiki 桥只接受相对路径，但就算传了绝对风格写法，也不会被当成根外路径。
  const root = path.resolve(wikiRoot());
  for (const contained of ["/etc/passwd", "\\windows\\system32\\x.md", "wiki/concepts/../../escape.md"]) {
    const abs = resolveInside(contained);
    assert.ok(abs, String(contained));
    assert.ok(abs.startsWith(root + path.sep), `${contained} 必须被收进根内：${abs}`);
  }
  assert.ok(resolveInside("wiki/concepts/a.md"));
  assert.ok(resolveInside("raw/source.md"));
  assert.ok(resolveInside("index.md"));
});

test("isAllowedRel：只放行三件套 + raw/<x>.md + wiki/<类别>/<x>.md", () => {
  for (const ok of ["index.md", "log.md", "schema.md", "raw/source.md", "wiki/concepts/a.md"]) {
    assert.equal(isAllowedRel(ok), true, ok);
  }
  for (const bad of [
    "other.md",
    "wiki/unknown/a.md",
    "wiki/concepts/nested/a.md",
    "raw/sub/a.md",
    "raw/a.txt",
    "wiki/concepts/a.txt",
    "../raw/a.md",
    "",
    null,
  ]) {
    assert.equal(isAllowedRel(bad), false, String(bad));
  }
});

test("wikiRoot 跟随 HEMING_WIKI_DIR（测试隔离用，渲染层传不进来）", async () => {
  await withWiki(({ dir }) => {
    assert.equal(wikiRoot(), path.resolve(dir));
  });
});

/* ─────────────────────────── 读写边界 ─────────────────────────── */

test("write/read 往返：合法相对路径可写可读；不存在返回 null", async () => {
  await withWiki(async ({ call }) => {
    const res = await call("wiki:write", "wiki/concepts/a.md", "# 标题\n正文");
    assert.equal(res.path, "wiki/concepts/a.md");
    assert.ok(res.bytes > 0);
    assert.equal(await call("wiki:read", "wiki/concepts/a.md"), "# 标题\n正文");
    assert.equal(await call("wiki:read", "raw/none.md"), null);
  });
});

test("write：非法路径/内容含 NUL/超过单文件上限 一律拒绝", async () => {
  await withWiki(async ({ call }) => {
    await assert.rejects(() => call("wiki:write", "../escape.md", "x"), /forbidden path/);
    await assert.rejects(() => call("wiki:write", "wiki/concepts/a.txt", "x"), /forbidden path/);
    await assert.rejects(() => call("wiki:write", "raw/a.md", "a\0b"), /NUL/);
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await assert.rejects(() => call("wiki:write", "wiki/concepts/big.md", huge), /too large/);
  });
});

test("remove：只删 .md 且受白名单约束（不做递归删除）", async () => {
  await withWiki(async ({ call, dir }) => {
    await call("wiki:write", "raw/source.md", "x");
    assert.equal(await call("wiki:remove", "raw/source.md"), true);
    assert.equal(fs.existsSync(path.join(dir, "raw", "source.md")), false);
    await assert.rejects(() => call("wiki:remove", "../x.md"), /forbidden path/);
    await assert.rejects(() => call("wiki:remove", "raw"), /forbidden path/);
  });
});

test("list：只列 .md，且不含备份/隐藏目录", async () => {
  await withWiki(async ({ call, dir }) => {
    await call("wiki:write", "wiki/concepts/a.md", "x");
    await call("wiki:write", "raw/source.md", "y");
    fs.mkdirSync(path.join(dir, "wiki", "concepts", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(dir, "wiki", "concepts", ".hidden", "x.md"), "z");
    fs.writeFileSync(path.join(dir, "notes.txt"), "no");
    const list = await call("wiki:list");
    assert.deepEqual(list, ["raw/source.md", "wiki/concepts/a.md"]);
  });
});

/* ────────────────────────── log 行规范化 ────────────────────────── */

test("log：kind 非法归一为 note，title 压成一行并截断，extra 超长被截", async () => {
  await withWiki(async ({ call, dir }) => {
    await call("wiki:log", "bad kind!\n## 伪造", "标题\n注入", "e".repeat(5000));
    const raw = fs.readFileSync(path.join(dir, "log.md"), "utf8");
    assert.match(raw, /^## \[\d{4}-\d{2}-\d{2}\] note \| 标题 注入$/m);
    assert.equal(raw.includes("bad kind"), false);
    // extra 只保留 4000 字符
    const body = raw.split("\n").filter(Boolean).pop();
    assert.equal(body.length, 4000);
  });
});
