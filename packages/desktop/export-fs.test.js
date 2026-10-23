/**
 * 记忆导出文件桥的安全测试。
 *
 * 这个桥把网页（不可信输入）传来的文件名写到本机磁盘，路径穿越与后缀校验
 * 一旦破了就是任意文件写，所以必须有测试兜底；同时结构性断言「源码里没有网络模块」，
 * 对应「任何路径都不上云」的红线。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  registerExportIpc,
  exportsRoot,
  safeFileName,
  resolveTarget,
  writeExport,
  exportInfo,
  EXPORT_DIR_ENV,
} = require("./export-fs.js");

const src = fs.readFileSync(path.join(__dirname, "export-fs.js"), "utf8");

/** 每个用例独立的临时目录，避免互相看到对方写出的文件。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "heming-export-test-"));
}

test("exportsRoot：默认在 ~/Heming/exports，可用 HEMING_EXPORT_DIR 覆盖", () => {
  assert.equal(exportsRoot({}), path.join(os.homedir(), "Heming", "exports"));
  const custom = path.join(os.tmpdir(), "heming-exports-custom");
  assert.equal(exportsRoot({ [EXPORT_DIR_ENV]: custom }), path.resolve(custom));
});

test("文件名清洗：只保留安全字符", () => {
  assert.equal(safeFileName("记忆导出-2026-10-23.json"), "记忆导出-2026-10-23.json");
  assert.equal(safeFileName("a/b:c*d.json"), "b-c-d.json"); // 先取最后一段再清洗
  assert.equal(safeFileName("  报表  2026 .json"), "报表-2026-.json");
  assert.equal(safeFileName(".hidden.json"), "hidden.json"); // 以点开头的前缀被去掉
});

test("文件名清洗：空与纯符号返回 null", () => {
  assert.equal(safeFileName(""), null);
  assert.equal(safeFileName("   "), null);
  assert.equal(safeFileName("..."), null);
  assert.equal(safeFileName(".."), null);
});

test("`..` 直接拒绝（不静默清洗成最后一段）", () => {
  assert.equal(safeFileName("../x.json"), null);
  assert.equal(safeFileName("..\\x.json"), null);
  assert.equal(safeFileName("a/../x.json"), null);
  assert.equal(resolveTarget("../../evil.json", { [EXPORT_DIR_ENV]: tmpDir() }), null);
  const result = writeExport("../evil.json", "{}", { [EXPORT_DIR_ENV]: tmpDir() });
  assert.equal(result.ok, false);
});

test("Windows 保留名被拒绝（带后缀也不行）", () => {
  for (const name of ["CON.json", "con.json", "PRN.json", "aux.json", "NUL.json", "COM1.json", "LPT9.json"]) {
    assert.equal(safeFileName(name), null, `${name} 应被拒绝`);
  }
  // 只是以保留名开头不算保留名
  assert.equal(safeFileName("console.json"), "console.json");
});

test("resolveTarget：只接受 .json", () => {
  const env = { [EXPORT_DIR_ENV]: tmpDir() };
  assert.ok(resolveTarget("a.json", env));
  assert.ok(resolveTarget("A.JSON", env)); // 后缀大小写不敏感
  assert.equal(resolveTarget("a.html", env), null);
  assert.equal(resolveTarget("a.txt", env), null);
  assert.equal(resolveTarget("noext", env), null);
});

test("resolveTarget：落盘路径恒在导出根目录内", () => {
  const dir = tmpDir();
  const target = resolveTarget("记忆导出.json", { [EXPORT_DIR_ENV]: dir });
  assert.ok(target);
  assert.equal(target.name, "记忆导出.json");
  assert.equal(path.dirname(target.full), path.resolve(dir));
});

test("长文件名截断到 80 字符内且保住 .json 后缀", () => {
  const target = resolveTarget(`${"x".repeat(300)}.json`, { [EXPORT_DIR_ENV]: tmpDir() });
  assert.ok(target);
  assert.ok(target.name.length <= 80);
  assert.ok(target.name.endsWith(".json"), `后缀被截掉了：${target.name}`);
});

test("目录自动创建，内容按 UTF-8 落盘", () => {
  const base = tmpDir();
  const dir = path.join(base, "nested", "exports");
  const env = { [EXPORT_DIR_ENV]: dir };
  assert.equal(exportInfo(env).exists, false);
  const result = writeExport("记忆导出.json", '{"a":"中文"}', env);
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(path.resolve(dir), "记忆导出.json"));
  assert.equal(fs.readFileSync(result.path, "utf8"), '{"a":"中文"}');
  assert.equal(exportInfo(env).exists, true);
});

test("写失败返回 { ok:false, error } 而不抛（目录被同名文件挡住）", () => {
  const base = tmpDir();
  const blocker = path.join(base, "blocked");
  fs.writeFileSync(blocker, "占位");
  const env = { [EXPORT_DIR_ENV]: path.join(blocker, "sub") };
  assert.doesNotThrow(() => {
    const result = writeExport("a.json", "{}", env);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

test("registerExportIpc 注册 export:write / export:info，写失败经 IPC 也不抛", async () => {
  const dir = tmpDir();
  const previous = process.env[EXPORT_DIR_ENV];
  process.env[EXPORT_DIR_ENV] = dir;
  try {
    const handlers = new Map();
    registerExportIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
    assert.deepEqual([...handlers.keys()], ["export:write", "export:info"]);

    const written = await handlers.get("export:write")({}, "ipc.json", '{"ok":true}');
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(written.path, "utf8"), '{"ok":true}');

    const info = await handlers.get("export:info")({});
    assert.deepEqual(info, { dir: path.resolve(dir), exists: true });

    const rejected = await handlers.get("export:write")({}, "..\\evil.json", "{}");
    assert.equal(rejected.ok, false);
  } finally {
    if (previous === undefined) delete process.env[EXPORT_DIR_ENV];
    else process.env[EXPORT_DIR_ENV] = previous;
  }
});

test("源码里不出现任何网络模块（结构性保证：导出不上云）", () => {
  const required = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  const allowed = new Set(["node:fs", "node:os", "node:path"]);
  for (const mod of required) {
    assert.ok(allowed.has(mod), `export-fs.js 引入了非白名单模块：${mod}`);
  }
  for (const mod of ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "electron"]) {
    assert.ok(!src.includes(`require("${mod}")`), `export-fs.js 不应引入 ${mod}`);
  }
  assert.ok(!/\bfetch\s*\(/.test(src), "export-fs.js 不应发起 fetch");
});
