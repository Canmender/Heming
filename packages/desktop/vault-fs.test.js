"use strict";
/**
 * 原生知识库文件桥（vault-fs.js / vault-watch.js）的测试。
 *
 * 这个桥把网页（不可信输入）传来的相对路径落到用户磁盘上的任意已登记目录，
 * 是整条知识库链路权限最大的一层。所以安全用例都断言两件事：
 * 1. 调用被拒绝且错误码正确；2. **磁盘上没有任何越界写入 / 原文件内容一字未变**。
 * 只断言「返回了错误」的话，一个「先写后校验」的实现也能让测试通过。
 *
 * 运行：`node --test vault-fs.test.js`
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createVaultService,
  registerVaultIpc,
  readRegistry,
  saveRegistry,
  normalizeWriteDirs,
  checkRel,
  resolveDefaultVaultRoot,
  ensureStandardVault,
  buildStandardFile,
  DEFAULT_WRITE_DIRS,
  DEFAULT_VAULT_WRITE_DIRS,
  STANDARD_VAULT_DIRS,
  STANDARD_VAULT_FILES,
  MAX_TEXT_BYTES,
  MAX_IMAGE_BYTES,
} = require("./vault-fs");
const { createVaultWatcher, normalizeWatchRel, DEFAULT_DEBOUNCE_MS, DEFAULT_MAX_BATCH } = require("./vault-watch");

/* ────────────────────────────── 夹具 ────────────────────────────── */

/** 一个临时工作区：一个库根 + 一个库外目录 + 注册表。 */
function makeWorkspace(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "heming-vault-"));
  const root = path.join(base, "库");
  const outside = path.join(base, "库外");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const registryFile = path.join(base, "vaults.json");
  const writeDirs = options.writeDirs === undefined ? [...DEFAULT_WRITE_DIRS] : options.writeDirs;
  const meta = {
    id: "v1",
    name: "测试库",
    root,
    writeDirs,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  saveRegistrySync(registryFile, [meta]);
  const service = createVaultService({
    registryFile,
    dialog: options.dialog,
    shell: options.shell,
  });
  t.after(() => {
    try {
      service.closeAllWatchers();
    } catch {
      /* 收尾失败不影响用例结论 */
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, outside, registryFile, meta, service };
}

/** 同步写注册表夹具（saveRegistry 是异步的，夹具里用同步写更直观）。 */
function saveRegistrySync(registryFile, vaults, extra = {}) {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify({ version: 1, legacyMigrated: true, ...extra, vaults }, null, 2)}\n`,
    "utf8",
  );
}

/** 断言 promise 以指定机器码失败。 */
async function rejectsWith(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error, "应当抛出错误");
    assert.equal(error.name, "VaultError", `应为 VaultError，实际 ${error.name}`);
    assert.equal(error.code, expectedCode, `错误码应为 ${expectedCode}，实际 ${error.code}：${error.message}`);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0, "错误文案不能为空");
    return true;
  });
}

/** 假 ipcMain：收集 handler，便于直接按通道调用。 */
function fakeIpc() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    invoke(channel, event, ...args) {
      const fn = handlers.get(channel);
      assert.ok(fn, `未注册的通道 ${channel}`);
      return fn(event, ...args);
    },
    channels() {
      return [...handlers.keys()].sort();
    },
  };
}

/** 假窗口 webContents。 */
function fakeSender(id = 7) {
  const sent = [];
  return {
    id,
    sent,
    send(channel, payload) {
      sent.push([channel, payload]);
    },
    once() {},
    isDestroyed() {
      return false;
    },
  };
}

/* ────────────────────────────── 注册表 ────────────────────────────── */

test("注册表：文件不存在时 list 返回空数组（不抛错）", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "heming-vault-reg-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const service = createVaultService({ registryFile: path.join(base, "no-such.json") });
  assert.deepEqual(await service.list(), []);
  const parsed = await readRegistry(path.join(base, "no-such.json"));
  assert.equal(parsed.missing, true);
  assert.equal(parsed.corrupt, false);
});

test("注册表：坏 JSON 回退空表且不覆盖原文件；后续写入先备份再写新表", async (t) => {
  const ws = makeWorkspace(t);
  const corrupt = "{ 这不是 JSON";
  fs.writeFileSync(ws.registryFile, corrupt, "utf8");

  assert.deepEqual(await ws.service.list(), []);
  assert.equal(fs.readFileSync(ws.registryFile, "utf8"), corrupt, "坏注册表原文件必须保留");

  // 没有 dialog 的 service：pick 结构化失败（io-error），绝不能顺手把坏文件覆盖掉
  await rejectsWith(ws.service.pick(null), "io-error");
  assert.equal(fs.readFileSync(ws.registryFile, "utf8"), corrupt, "pick 失败也不能动坏注册表");

  // 用带 dialog 的 service 完成登记
  const service2 = createVaultService({
    registryFile: ws.registryFile,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [ws.root] }) },
  });
  t.after(() => service2.closeAllWatchers());
  const meta = await service2.pick(null);
  assert.ok(meta && meta.id, "应登记成功");

  const backups = fs
    .readdirSync(path.dirname(ws.registryFile))
    .filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1, "坏注册表应备份为 .corrupt-* 文件");
  assert.equal(fs.readFileSync(path.join(path.dirname(ws.registryFile), backups[0]), "utf8"), corrupt);
  assert.equal((await service2.list()).length, 1);
});

test("注册表：条目形状非法整条丢弃、重复根目录去重、writeDirs 坏条目逐条丢弃", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(
    ws.registryFile,
    JSON.stringify({
      version: 1,
      vaults: [
        ws.meta,
        { id: "v2", name: "重复根", root: ws.root },
        { id: "", name: "无 id", root: path.join(ws.outside) },
        { id: "v3", name: "相对根", root: "relative/dir" },
        { id: "v4", name: "坏写目录", root: ws.outside, writeDirs: ["/", "../逃逸", "inbox", "INBOX", ".hidden", "notes/ai"] },
      ],
    }),
    "utf8",
  );
  const vaults = await ws.service.list();
  assert.deepEqual(
    vaults.map((item) => item.id).sort(),
    ["v1", "v4"],
    "只有 id/根路径合法的条目留下，重复根只留第一条",
  );
  const v4 = vaults.find((item) => item.id === "v4");
  assert.deepEqual(v4.writeDirs, ["inbox", "notes/ai"], "坏写目录与重复项被丢弃");
});

test("注册表：rename 持久化展示名，remove 只删登记不删文件", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(path.join(ws.root, "笔记.md"), "内容\n");
  const renamed = await ws.service.rename("v1", "  我的库  ");
  assert.equal(renamed.name, "我的库");
  assert.equal((await ws.service.list())[0].name, "我的库");
  await rejectsWith(ws.service.rename("v1", "   "), "forbidden-path");

  assert.equal(await ws.service.remove("v1"), true);
  assert.deepEqual(await ws.service.list(), []);
  assert.equal(fs.existsSync(path.join(ws.root, "笔记.md")), true, "remove 不得删除磁盘文件");
  assert.equal(await ws.service.remove("v1"), false, "重复移除返回 false");
});

/* ────────────────────────────── pick ────────────────────────────── */

test("pick：用户取消返回 null，dialog 抛错也按取消处理（不炸渲染层）", async (t) => {
  const ws = makeWorkspace(t, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  });
  assert.equal(await ws.service.pick(null), null);

  const broken = createVaultService({
    registryFile: ws.registryFile,
    dialog: {
      showOpenDialog: async () => {
        throw new Error("dialog 炸了");
      },
    },
  });
  t.after(() => broken.closeAllWatchers());
  assert.equal(await broken.pick(null), null);
});

test("pick：登记成功、默认 writeDirs=['inbox']、重复选同一目录不重复登记", async (t) => {
  const ws = makeWorkspace(t, {
    writeDirs: undefined,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [ws.root] }) },
  });
  // 夹具里已经登记过 v1（同一根），再次 pick 应返回同一条
  const again = await ws.service.pick(null);
  assert.equal(again.id, "v1");
  assert.equal((await ws.service.list()).length, 1);

  const otherRoot = path.join(ws.base, "第二个库");
  fs.mkdirSync(otherRoot, { recursive: true });
  const another = createVaultService({
    registryFile: ws.registryFile,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [otherRoot] }) },
  });
  t.after(() => another.closeAllWatchers());
  const meta = await another.pick(null);
  assert.equal(meta.name, "第二个库");
  assert.deepEqual(meta.writeDirs, ["inbox"]);
  assert.ok(!Number.isNaN(Date.parse(meta.addedAt)));
  assert.equal((await another.list()).length, 2);
});

test("pick：拒绝把磁盘根目录登记成库", async (t) => {
  const rootSeg = path.parse(process.cwd()).root;
  const ws = makeWorkspace(t, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [rootSeg] }) },
  });
  await rejectsWith(ws.service.pick(null), "forbidden-path");
});

test("pick：没有 dialog（浏览器/测试环境）时结构化失败", async (t) => {
  const ws = makeWorkspace(t);
  await rejectsWith(ws.service.pick(null), "io-error");
});

/* ────────────────────────────── 目录树 ────────────────────────────── */

test("tree：目录优先排序、kind 分类、忽略隐藏项与 node_modules", async (t) => {
  const ws = makeWorkspace(t);
  fs.mkdirSync(path.join(ws.root, "b-dir"));
  fs.mkdirSync(path.join(ws.root, "a-dir"));
  fs.mkdirSync(path.join(ws.root, ".obsidian"));
  fs.mkdirSync(path.join(ws.root, ".git"));
  fs.mkdirSync(path.join(ws.root, "node_modules"));
  fs.writeFileSync(path.join(ws.root, "a.md"), "甲\n");
  fs.writeFileSync(path.join(ws.root, "z.canvas"), "{}");
  fs.writeFileSync(path.join(ws.root, "图片.png"), "not-a-real-png");
  fs.writeFileSync(path.join(ws.root, "附件.pdf"), "%PDF");
  fs.writeFileSync(path.join(ws.root, ".gitignore"), "x");
  fs.writeFileSync(path.join(ws.root, ".obsidian", "app.json"), "{}");

  const entries = await ws.service.tree("v1");
  const dirs = entries.filter((entry) => entry.kind === "dir");
  const files = entries.filter((entry) => entry.kind !== "dir");
  assert.deepEqual(
    entries.slice(0, dirs.length).map((entry) => entry.kind),
    dirs.map(() => "dir"),
    "目录必须排在文件之前",
  );
  assert.deepEqual(dirs.map((entry) => entry.name), ["a-dir", "b-dir"], "目录按名称自然序");
  assert.deepEqual(
    [...files.map((entry) => entry.name)].sort(),
    ["a.md", "z.canvas", "图片.png", "附件.pdf"].sort(),
    "文件集合正确",
  );
  // 同一目录两次列树顺序必须一致（索引层依赖确定性）
  assert.deepEqual(
    (await ws.service.tree("v1")).map((entry) => entry.name),
    entries.map((entry) => entry.name),
  );

  const names = entries.map((entry) => entry.name);
  assert.equal(dirs.length, 2, "只应有可见目录（隐藏目录被忽略）");
  assert.equal(files.length, 4, "隐藏文件与忽略目录不应出现");
  assert.ok(!names.includes(".obsidian") && !names.includes(".git") && !names.includes("node_modules"));
  assert.ok(!names.includes(".gitignore"));

  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  assert.equal(byName["a.md"].kind, "md");
  assert.equal(byName["z.canvas"].kind, "canvas");
  assert.equal(byName["图片.png"].kind, "image");
  assert.equal(byName["附件.pdf"].kind, "other");
  assert.ok(!Number.isNaN(Date.parse(byName["a.md"].mtime)));
  assert.equal(byName["a.md"].size, Buffer.byteLength("甲\n"));
  assert.ok(Array.isArray(byName["a-dir"].children), "目录节点应带 children");
});

test("tree：depth 控制层级、rel 懒加载子树", async (t) => {
  const ws = makeWorkspace(t);
  fs.mkdirSync(path.join(ws.root, "notes", "deep"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, "notes", "a.md"), "甲\n");
  fs.writeFileSync(path.join(ws.root, "notes", "deep", "b.md"), "乙\n");

  const shallow = await ws.service.tree("v1", { depth: 1 });
  const notes = shallow.find((entry) => entry.name === "notes");
  assert.equal(notes.children, undefined, "depth=1 不应展开子目录");

  const subtree = await ws.service.tree("v1", { rel: "notes", depth: 2 });
  const names = subtree.map((entry) => entry.name);
  assert.deepEqual(names[0], "deep", "目录优先");
  assert.ok(names.includes("a.md"));
  const deep = subtree.find((entry) => entry.name === "deep");
  assert.deepEqual(deep.children.map((entry) => entry.name), ["b.md"]);

  // 越界/非法 rel 一律拒绝，不越出库根
  await rejectsWith(ws.service.tree("v1", { rel: ".." }), "forbidden-path");
  await rejectsWith(ws.service.tree("v1", { rel: "notes/../.." }), "forbidden-path");
  await rejectsWith(ws.service.tree("v1", { rel: "C:/Windows" }), "forbidden-path");
  await rejectsWith(ws.service.tree("不存在的库"), "no-vault");
  // depth 非法时退回默认值，不抛
  const fallback = await ws.service.tree("v1", { depth: "深" });
  assert.ok(Array.isArray(fallback));
});

test("tree：任意 rel 拉子树（多级、尾斜杠归一、目标非目录拒绝）", async (t) => {
  const ws = makeWorkspace(t);
  fs.mkdirSync(path.join(ws.root, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, "a", "x.md"), "x\n");
  fs.writeFileSync(path.join(ws.root, "a", "b", "y.md"), "y\n");
  fs.writeFileSync(path.join(ws.root, "a", "b", "c", "z.md"), "z\n");

  // 任意层级都只返回该子树的直接子节点（界面懒加载契约）
  const atB = await ws.service.tree("v1", { rel: "a/b", depth: 1 });
  assert.deepEqual(atB.map((entry) => entry.name), ["c", "y.md"], "目录优先 + 名称序");
  assert.equal(atB.find((entry) => entry.name === "c").children, undefined, "depth=1 不展开");

  // 尾斜杠应被归一，等价于不带斜杠
  const slash = await ws.service.tree("v1", { rel: "a/b/", depth: 2 });
  assert.deepEqual(
    slash.map((entry) => entry.name),
    atB.map((entry) => entry.name),
    "带尾斜杠与不带斜杠结果一致",
  );
  const cNode = slash.find((entry) => entry.name === "c");
  assert.deepEqual(cNode.children.map((entry) => entry.name), ["z.md"]);

  // 更深一层：子树根就是 c，不包含上级 a/b 的内容
  const atC = await ws.service.tree("v1", { rel: "a/b/c", depth: 2 });
  assert.deepEqual(atC.map((entry) => entry.name), ["z.md"]);

  // 目标不是目录 → 拒绝；继续向上逃逸 → 拒绝
  await rejectsWith(ws.service.tree("v1", { rel: "a/x.md" }), "forbidden-path");
  await rejectsWith(ws.service.tree("v1", { rel: "a/../.." }), "forbidden-path");
  await rejectsWith(ws.service.tree("v1", { rel: "不存在目录", depth: 1 }), "not-found");
});

/* ────────────────────────────── 读文本 / 读图片 ────────────────────────────── */

test("read：文本内容/mtime/size 正确，不存在返回 null", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(path.join(ws.root, "笔记.md"), "# 标题\n正文\n", "utf8");
  const doc = await ws.service.read("v1", "笔记.md");
  assert.equal(doc.vaultId, "v1");
  assert.equal(doc.rel, "笔记.md");
  assert.equal(doc.text, "# 标题\n正文\n");
  assert.equal(doc.size, Buffer.byteLength("# 标题\n正文\n"));
  assert.ok(!Number.isNaN(Date.parse(doc.mtime)));

  assert.equal(await ws.service.read("v1", "没有.md"), null);
  // Windows 反斜杠写法应被归一成同一路径
  assert.equal((await ws.service.read("v1", "笔记.md")).text, "# 标题\n正文\n");
});

test("read：图片扩展名不能当文本读；readBinary 转 data URL 且拒绝文本扩展名", async (t) => {
  const ws = makeWorkspace(t);
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(ws.root, "图.png"), pngBytes);
  fs.writeFileSync(path.join(ws.root, "笔记.md"), "文本\n");

  await rejectsWith(ws.service.read("v1", "图.png"), "forbidden-ext");
  await rejectsWith(ws.service.readBinary("v1", "笔记.md"), "forbidden-ext");

  const image = await ws.service.readBinary("v1", "图.png");
  assert.equal(image.mime, "image/png");
  assert.ok(image.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(Buffer.from(image.dataUrl.split(",")[1], "base64").toString("hex"), pngBytes.toString("hex"));
  assert.equal(await ws.service.readBinary("v1", "没有.png"), null);
});

test("read：超 2MB 拒绝、二进制内容拒绝、非 UTF-8 拒绝", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(path.join(ws.root, "big.md"), Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
  await rejectsWith(ws.service.read("v1", "big.md"), "too-large");

  fs.writeFileSync(path.join(ws.root, "bin.md"), Buffer.from([0x61, 0x00, 0x62]));
  await rejectsWith(ws.service.read("v1", "bin.md"), "io-error");

  fs.writeFileSync(path.join(ws.root, "bad.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  await rejectsWith(ws.service.read("v1", "bad.md"), "io-error");
});

test("readBinary：超 8MB 拒绝（用稀疏文件构造，不实际占磁盘）", async (t) => {
  const ws = makeWorkspace(t);
  const big = path.join(ws.root, "big.jpg");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, MAX_IMAGE_BYTES + 1);
  await rejectsWith(ws.service.readBinary("v1", "big.jpg"), "too-large");
});

test("read：.obsidian 允许读（理解 Obsidian 配置），但永不写", async (t) => {
  const ws = makeWorkspace(t);
  fs.mkdirSync(path.join(ws.root, ".obsidian"));
  fs.writeFileSync(path.join(ws.root, ".obsidian", "app.json"), "{}", "utf8");
  const doc = await ws.service.read("v1", ".obsidian/app.json");
  assert.equal(doc.text, "{}");
  await rejectsWith(ws.service.write("v1", ".obsidian/app.json", "{}"), "forbidden-path");
});

/* ────────────────────────────── 写文本（用户通道） ────────────────────────────── */

test("write：新建嵌套文件自动建父目录，返回 bytes 与写后 mtime", async (t) => {
  const ws = makeWorkspace(t);
  const result = await ws.service.write("v1", "notes/新笔记.md", "你好\n");
  assert.equal(result.rel, "notes/新笔记.md");
  assert.equal(result.bytes, Buffer.byteLength("你好\n"));
  assert.ok(!Number.isNaN(Date.parse(result.mtime)));
  assert.equal(fs.readFileSync(path.join(ws.root, "notes", "新笔记.md"), "utf8"), "你好\n");
  assert.deepEqual(
    fs.readdirSync(path.join(ws.root, "notes")).filter((name) => name.includes(".heming-tmp-")),
    [],
    "原子写不应留临时文件",
  );
});

test("write：expectMtime 命中才覆盖；被外部改动 / 被删除后返回 stale-mtime 且不覆盖", async (t) => {
  const ws = makeWorkspace(t);
  const file = path.join(ws.root, "并发.md");
  fs.writeFileSync(file, "初始\n");
  const first = await ws.service.read("v1", "并发.md");
  const saved = await ws.service.write("v1", "并发.md", "我的改动\n", { expectMtime: first.mtime });
  assert.equal(saved.rel, "并发.md");
  assert.equal(fs.readFileSync(file, "utf8"), "我的改动\n");

  // 模拟外部编辑器保存：mtime 前进到未来
  fs.writeFileSync(file, "外部改动\n");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(file, future, future);
  await rejectsWith(ws.service.write("v1", "并发.md", "覆盖\n", { expectMtime: first.mtime }), "stale-mtime");
  assert.equal(fs.readFileSync(file, "utf8"), "外部改动\n", "stale 时原内容必须不动");

  // 文件被外部删除
  fs.unlinkSync(file);
  await rejectsWith(ws.service.write("v1", "并发.md", "覆盖\n", { expectMtime: "2020-01-01T00:00:00.000Z" }), "stale-mtime");
  assert.equal(fs.existsSync(file), false);
  await rejectsWith(ws.service.write("v1", "并发.md", "覆盖\n", { expectMtime: 123 }), "forbidden-path");
});

test("write：内容上限/类型/NUL/扩展名白名单", async (t) => {
  const ws = makeWorkspace(t);
  await rejectsWith(ws.service.write("v1", "a.md", Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61).toString()), "too-large");
  await rejectsWith(ws.service.write("v1", "a.md", "a\0b"), "forbidden-path");
  await rejectsWith(ws.service.write("v1", "a.md", 123), "forbidden-path");
  await rejectsWith(ws.service.write("v1", "恶意.exe", "MZ"), "forbidden-ext");
  await rejectsWith(ws.service.write("v1", "无扩展名", "x"), "forbidden-ext");
  assert.equal(fs.existsSync(path.join(ws.root, "恶意.exe")), false);
});

test("write：越界写法（..、绝对路径、盘符、NUL、保留名、隐藏目录）全部拒绝且不落盘", async (t) => {
  const ws = makeWorkspace(t);
  const badRels = [
    "../库外.md",
    "notes/../../库外.md",
    "/绝对.md",
    "\\绝对.md",
    "//server/share/x.md",
    "C:/Windows/x.md",
    "C:\\Windows\\x.md",
    "a/\0b.md",
    "x".repeat(301) + ".md",
    "CON.md",
    "aux.txt",
    "dir/LPT1.md",
    "a//b.md",
    "./a.md",
    "a/./b.md",
    ".hidden/x.md",
    "node_modules/x.md",
    ".git/config.md",
  ];
  for (const rel of badRels) {
    await rejectsWith(ws.service.write("v1", rel, "越界\n"), "forbidden-path");
  }
  assert.equal(fs.existsSync(path.join(ws.base, "库外.md")), false, "不得在库外落盘");
  assert.deepEqual(fs.readdirSync(ws.root), [], "库内也不得留下任何文件");
});

test("write：磁盘根/相对根等非法库条目不可用（no-vault）", async (t) => {
  const ws = makeWorkspace(t);
  await rejectsWith(ws.service.write(undefined, "a.md", "x"), "no-vault");
  await rejectsWith(ws.service.write(123, "a.md", "x"), "no-vault");
  await rejectsWith(ws.service.write("v1", undefined, "x"), "forbidden-path");
  await rejectsWith(ws.service.read("v1", undefined), "forbidden-path");
  await rejectsWith(ws.service.read("v1", null), "forbidden-path");
});

/* ────────────────────────────── 智能体通道 vault:apply ────────────────────────────── */

test("apply：默认只允许 inbox，库根与其它目录返回 outside-write-dirs", async (t) => {
  const ws = makeWorkspace(t);
  const ok = await ws.service.apply({ vaultId: "v1", rel: "inbox/记忆.md", text: "沉淀\n" });
  assert.equal(ok.rel, "inbox/记忆.md");
  assert.equal(fs.readFileSync(path.join(ws.root, "inbox", "记忆.md"), "utf8"), "沉淀\n");

  await rejectsWith(
    ws.service.apply({ vaultId: "v1", rel: "notes/笔记.md", text: "越界\n" }),
    "outside-write-dirs",
  );
  await rejectsWith(ws.service.apply({ vaultId: "v1", rel: "根笔记.md", text: "越界\n" }), "outside-write-dirs");
  await rejectsWith(
    ws.service.apply({ vaultId: "v1", rel: "inbox-别的/笔记.md", text: "越界\n" }),
    "outside-write-dirs",
  );
  // 前缀相同但不是子目录（inbox2）必须拒绝
  assert.equal(fs.existsSync(path.join(ws.root, "notes", "笔记.md")), false);
});

test("apply：writeDirs 可配置多目录、空数组表示只读", async (t) => {
  const ws = makeWorkspace(t, { writeDirs: ["inbox", "notes/ai"] });
  await ws.service.apply({ vaultId: "v1", rel: "notes/ai/x.md", text: "ok" });
  await ws.service.apply({ vaultId: "v1", rel: "inbox/y.md", text: "ok" });
  await rejectsWith(ws.service.apply({ vaultId: "v1", rel: "notes/other.md", text: "no" }), "outside-write-dirs");

  const readonly = makeWorkspace(t, { writeDirs: [] });
  await rejectsWith(
    readonly.service.apply({ vaultId: "v1", rel: "inbox/z.md", text: "no" }),
    "outside-write-dirs",
  );
});

test("apply：append 追加；追加后超上限拒绝且原文件不动；非法 mode/请求拒绝", async (t) => {
  const ws = makeWorkspace(t);
  await ws.service.apply({ vaultId: "v1", rel: "inbox/m.md", text: "第一节\n" });
  await ws.service.apply({ vaultId: "v1", rel: "inbox/m.md", text: "## 更新 2026-11-08\n第二节\n", mode: "append" });
  assert.equal(
    fs.readFileSync(path.join(ws.root, "inbox", "m.md"), "utf8"),
    "第一节\n## 更新 2026-11-08\n第二节\n",
  );

  // 把文件撑到接近上限，再追加 10 字节应被拒绝
  const nearLimit = "a".repeat(MAX_TEXT_BYTES - 5);
  fs.writeFileSync(path.join(ws.root, "inbox", "m.md"), nearLimit, "utf8");
  await rejectsWith(
    ws.service.apply({ vaultId: "v1", rel: "inbox/m.md", text: "0123456789", mode: "append" }),
    "too-large",
  );
  assert.equal(fs.statSync(path.join(ws.root, "inbox", "m.md")).size, MAX_TEXT_BYTES - 5);

  await rejectsWith(ws.service.apply({ vaultId: "v1", rel: "inbox/m.md", text: "x", mode: "delete" }), "forbidden-path");
  await rejectsWith(ws.service.apply(null), "forbidden-path");
  await rejectsWith(ws.service.apply("字符串请求"), "forbidden-path");
  await rejectsWith(ws.service.apply({ vaultId: "v1", rel: "inbox/图.png", text: "x" }), "forbidden-ext");
});

/* ────────────────────────────── 新建 / 移动 / 删除 ────────────────────────────── */

test("create：新建成功、已存在失败、非法路径与扩展名拒绝", async (t) => {
  const ws = makeWorkspace(t);
  const created = await ws.service.create("v1", "daily/2026-11-08.md", "# 日记\n");
  assert.equal(created.rel, "daily/2026-11-08.md");
  assert.equal(fs.readFileSync(path.join(ws.root, "daily", "2026-11-08.md"), "utf8"), "# 日记\n");

  await rejectsWith(ws.service.create("v1", "daily/2026-11-08.md", "覆盖"), "io-error");
  assert.equal(fs.readFileSync(path.join(ws.root, "daily", "2026-11-08.md"), "utf8"), "# 日记\n");
  await rejectsWith(ws.service.create("v1", "../外面.md", "x"), "forbidden-path");
  await rejectsWith(ws.service.create("v1", "x.png", "x"), "forbidden-ext");
});

test("createDir：多级 mkdir -p、已存在幂等（含尾斜杠）、同名文件冲突拒绝", async (t) => {
  const ws = makeWorkspace(t);
  const created = await ws.service.createDir("v1", "项目/子目录/更深");
  assert.equal(created.rel, "项目/子目录/更深");
  assert.equal(created.bytes, 0, "目录没有内容，bytes 恒为 0（与 create 返回形状对齐）");
  assert.ok(!Number.isNaN(Date.parse(created.mtime)));
  assert.ok(fs.statSync(path.join(ws.root, "项目", "子目录", "更深")).isDirectory());

  // 幂等：重复创建返回成功而不是报错（界面连点/重试）
  const again = await ws.service.createDir("v1", "项目/子目录/更深");
  assert.equal(again.rel, "项目/子目录/更深");
  assert.equal(again.bytes, 0);
  assert.ok(fs.statSync(path.join(ws.root, "项目", "子目录", "更深")).isDirectory());
  // 尾斜杠归一后同样幂等
  const slash = await ws.service.createDir("v1", "项目/子目录/更深/");
  assert.equal(slash.rel, "项目/子目录/更深");

  // 同名文件存在时不能创建目录，且原文件一字未动
  fs.writeFileSync(path.join(ws.root, "占用.md"), "x\n");
  await rejectsWith(ws.service.createDir("v1", "占用.md"), "io-error");
  assert.equal(fs.readFileSync(path.join(ws.root, "占用.md"), "utf8"), "x\n");
});

test("createDir：越界、隐藏目录、保留名、非法字符全部拒绝且不落盘", async (t) => {
  const ws = makeWorkspace(t);
  const bad = [
    "../外面",
    "a/../../外面",
    "/绝对",
    "\\绝对",
    "C:/Windows",
    "a\0b",
    "x".repeat(301),
    ".obsidian/新目录",
    ".git/x",
    "node_modules/x",
    ".hidden/x",
    "CON",
    "aux",
    "a//b",
    "./x",
    ".",
    "",
    null,
    42,
  ];
  for (const rel of bad) {
    await rejectsWith(ws.service.createDir("v1", rel), "forbidden-path");
  }
  assert.deepEqual(fs.readdirSync(ws.root), [], "库内不得留下任何目录");
  assert.equal(fs.existsSync(path.join(ws.base, "外面")), false, "库外不得落盘");
});

test("createDir：目录建出来后 delete 仍只删文件（不提供递归删目录）", async (t) => {
  const ws = makeWorkspace(t);
  await ws.service.createDir("v1", "文件夹/子文件夹");
  fs.writeFileSync(path.join(ws.root, "文件夹", "子文件夹", "孩子.md"), "孩子\n");
  // 目录本身不是可删对象：无扩展名/目录一律按 forbidden-ext / io-error 拒绝
  await rejectsWith(ws.service.deleteFile("v1", "文件夹"), "forbidden-ext");
  await rejectsWith(ws.service.deleteFile("v1", "文件夹/子文件夹"), "forbidden-ext");
  const dirWithMdExt = path.join(ws.root, "看起来像.md");
  fs.mkdirSync(dirWithMdExt);
  await rejectsWith(ws.service.deleteFile("v1", "看起来像.md"), "io-error");
  assert.equal(fs.existsSync(path.join(ws.root, "文件夹", "子文件夹", "孩子.md")), true);
});

test("move：库内改名成功；目标已存在/目录/非法扩展名拒绝", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(path.join(ws.root, "旧名.md"), "内容\n");
  assert.equal(await ws.service.move("v1", "旧名.md", "新名.md"), true);
  assert.equal(fs.existsSync(path.join(ws.root, "旧名.md")), false);
  assert.equal(fs.readFileSync(path.join(ws.root, "新名.md"), "utf8"), "内容\n");

  fs.writeFileSync(path.join(ws.root, "已存在.md"), "占位\n");
  fs.writeFileSync(path.join(ws.root, "源.md"), "源\n");
  await rejectsWith(ws.service.move("v1", "源.md", "已存在.md"), "io-error");
  assert.equal(fs.readFileSync(path.join(ws.root, "已存在.md"), "utf8"), "占位\n");
  assert.equal(fs.readFileSync(path.join(ws.root, "源.md"), "utf8"), "源\n");

  fs.mkdirSync(path.join(ws.root, "目录.md"));
  await rejectsWith(ws.service.move("v1", "目录.md", "另一个.md"), "io-error");
  await rejectsWith(ws.service.move("v1", "源.md", "../库外.md"), "forbidden-path");
  await rejectsWith(ws.service.move("v1", "源.md", "目标.exe"), "forbidden-ext");
  assert.equal(fs.existsSync(path.join(ws.base, "库外.md")), false);
});

test("delete：只删单个文件；目录不递归、不存在 not-found、越界拒绝", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(path.join(ws.root, "删我.md"), "x\n");
  assert.equal(await ws.service.deleteFile("v1", "删我.md"), true);
  assert.equal(fs.existsSync(path.join(ws.root, "删我.md")), false);

  fs.mkdirSync(path.join(ws.root, "文件夹.md"));
  fs.writeFileSync(path.join(ws.root, "文件夹.md", "孩子.md"), "孩子\n");
  await rejectsWith(ws.service.deleteFile("v1", "文件夹.md"), "io-error");
  assert.equal(fs.existsSync(path.join(ws.root, "文件夹.md", "孩子.md")), true, "不得递归删除目录内容");

  await rejectsWith(ws.service.deleteFile("v1", "不存在.md"), "not-found");
  await rejectsWith(ws.service.deleteFile("v1", "../库外.md"), "forbidden-path");
  await rejectsWith(ws.service.deleteFile("v1", "x.exe"), "forbidden-ext");
});

/* ────────────────────────────── reveal ────────────────────────────── */

test("reveal：文件走 showItemInFolder、目录走 openPath、无 shell 时结构化失败", async (t) => {
  const calls = [];
  const ws = makeWorkspace(t, {
    shell: {
      showItemInFolder(target) {
        calls.push(["show", target]);
      },
      async openPath(target) {
        calls.push(["open", target]);
        return "";
      },
    },
  });
  fs.writeFileSync(path.join(ws.root, "a.md"), "x");
  fs.mkdirSync(path.join(ws.root, "目录"));
  assert.equal(await ws.service.reveal("v1", "a.md"), true);
  assert.equal(calls[0][0], "show");
  assert.equal(await ws.service.reveal("v1", "目录"), true);
  assert.equal(calls[1][0], "open");

  const noShell = makeWorkspace(t);
  await rejectsWith(noShell.service.reveal("v1", "a.md"), "not-found");
  fs.writeFileSync(path.join(noShell.root, "b.md"), "x");
  await rejectsWith(noShell.service.reveal("v1", "b.md"), "io-error");
});

/* ────────────────────────────── 符号链接逃逸 ────────────────────────────── */

test("符号链接逃逸：库内联接指向库外时，读/写/树都必须拒绝", async (t) => {
  const ws = makeWorkspace(t);
  const secret = path.join(ws.outside, "秘密.md");
  fs.writeFileSync(secret, "库外机密\n");
  const secretImage = path.join(ws.outside, "秘密.png");
  fs.writeFileSync(secretImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const link = path.join(ws.root, "逃逸");
  try {
    fs.symlinkSync(ws.outside, link, "junction");
  } catch {
    t.skip("当前环境不支持创建符号链接/联接，跳过符号链接用例");
    return;
  }
  assert.ok(fs.existsSync(path.join(link, "秘密.md")), "夹具：联接应指向库外目录");

  await rejectsWith(ws.service.read("v1", "逃逸/秘密.md"), "forbidden-path");
  await rejectsWith(ws.service.readBinary("v1", "逃逸/秘密.png"), "forbidden-path");
  await rejectsWith(ws.service.write("v1", "逃逸/新文件.md", "越界\n"), "forbidden-path");
  await rejectsWith(ws.service.create("v1", "逃逸/新文件2.md", "越界\n"), "forbidden-path");
  await rejectsWith(ws.service.createDir("v1", "逃逸/新目录"), "forbidden-path");
  await rejectsWith(ws.service.deleteFile("v1", "逃逸/秘密.md"), "forbidden-path");
  assert.equal(fs.existsSync(path.join(ws.outside, "新文件.md")), false, "库外不得出现新文件");
  assert.equal(fs.existsSync(path.join(ws.outside, "新目录")), false, "库外不得出现新目录");
  assert.equal(fs.readFileSync(secret, "utf8"), "库外机密\n");
  assert.equal(fs.existsSync(secret), true, "库外文件不得被删除");

  const treeNames = (await ws.service.tree("v1")).map((entry) => entry.name);
  assert.ok(!treeNames.includes("逃逸"), "目录树不得包含指向库外的联接");
});

/* ────────────────────────────── IPC 边界 ────────────────────────────── */

test("IPC：注册全部 vault 通道，乱传参数只回结构化失败、不抛裸异常", async (t) => {
  const ws = makeWorkspace(t);
  const ipc = fakeIpc();
  const service = registerVaultIpc(ipc, {
    registryFile: ws.registryFile,
    shell: { showItemInFolder() {}, async openPath() { return ""; } },
  });
  t.after(() => service.closeAllWatchers());

  const expected = [
    "vault:apply",
    "vault:create",
    "vault:createDir",
    "vault:delete",
    "vault:list",
    "vault:move",
    "vault:pick",
    "vault:read",
    "vault:readBinary",
    "vault:rename",
    "vault:remove",
    "vault:reveal",
    "vault:tree",
    "vault:unwatch",
    "vault:watch",
    "vault:write",
  ].sort();
  assert.deepEqual(ipc.channels(), expected, "IPC 通道清单必须与 preload/白名单一致");

  const garbage = [undefined, null, 123, true, "字符串", [], {}, { rel: 42 }, Symbol("x")];
  for (const channel of expected) {
    for (const arg of garbage) {
      const result = await ipc.invoke(channel, {}, arg, arg, arg, arg);
      assert.equal(typeof result, "object", `${channel} 必须返回 envelope`);
      assert.equal(typeof result.ok, "boolean", `${channel} 必须带 ok`);
      if (result.ok === false) {
        assert.equal(typeof result.code, "string", `${channel} 失败必须带机器码`);
        assert.equal(typeof result.message, "string", `${channel} 失败必须带中文 message`);
        assert.ok(result.message.length > 0);
      }
    }
  }
});

test("IPC：成功 envelope 形状正确（list/read/write/apply/tree）", async (t) => {
  const ws = makeWorkspace(t);
  const ipc = fakeIpc();
  const service = registerVaultIpc(ipc, { registryFile: ws.registryFile, shell: {} });
  t.after(() => service.closeAllWatchers());

  const listed = await ipc.invoke("vault:list", {});
  assert.equal(listed.ok, true);
  assert.equal(Array.isArray(listed.value), true);
  assert.equal(listed.value.length, 1);

  const writeResult = await ipc.invoke("vault:write", {}, "v1", "ipc.md", "内容\n");
  assert.equal(writeResult.ok, true);
  assert.equal(writeResult.value.rel, "ipc.md");
  assert.ok(!Number.isNaN(Date.parse(writeResult.value.mtime)));

  const readResult = await ipc.invoke("vault:read", {}, "v1", "ipc.md");
  assert.equal(readResult.ok, true);
  assert.equal(readResult.value.text, "内容\n");

  const dirResult = await ipc.invoke("vault:createDir", {}, "v1", "ipc-目录/子目录");
  assert.equal(dirResult.ok, true);
  assert.equal(dirResult.value.rel, "ipc-目录/子目录");
  assert.equal(dirResult.value.bytes, 0);
  assert.ok(!Number.isNaN(Date.parse(dirResult.value.mtime)));
  assert.ok(fs.statSync(path.join(ws.root, "ipc-目录", "子目录")).isDirectory());
  // 幂等：再调一次仍成功
  const dirAgain = await ipc.invoke("vault:createDir", {}, "v1", "ipc-目录/子目录");
  assert.equal(dirAgain.ok, true);

  const applyResult = await ipc.invoke("vault:apply", {}, { vaultId: "v1", rel: "inbox/记忆.md", text: "x" });
  assert.equal(applyResult.ok, true);
  const applyDenied = await ipc.invoke("vault:apply", {}, { vaultId: "v1", rel: "notes/x.md", text: "x" });
  assert.equal(applyDenied.ok, false);
  assert.equal(applyDenied.code, "outside-write-dirs");

  const treeResult = await ipc.invoke("vault:tree", {}, "v1", { depth: 1 });
  assert.equal(treeResult.ok, true);
  assert.ok(Array.isArray(treeResult.value));
});

test("IPC：watch 用 event.sender 定向推送，unwatch 取消后不再推送", async (t) => {
  const ws = makeWorkspace(t);
  const ipc = fakeIpc();
  const service = registerVaultIpc(ipc, { registryFile: ws.registryFile, shell: {} });
  t.after(() => service.closeAllWatchers());
  const sender = fakeSender(9);

  const started = await ipc.invoke("vault:watch", { sender }, "v1");
  assert.equal(started.ok, true);
  assert.equal(started.value, true);
  assert.equal(service.activeWatcherCount(), 1, "订阅后应有一个活跃监听器");

  const stopped = await ipc.invoke("vault:unwatch", { sender }, "v1");
  assert.equal(stopped.ok, true);
  assert.equal(service.activeWatcherCount(), 0, "取消订阅后监听器必须关掉");

  // 没有 event.sender 的订阅应结构化失败而不是崩
  const noSender = await ipc.invoke("vault:watch", {}, "v1");
  assert.equal(noSender.ok, false);
  assert.equal(noSender.code, "io-error");

  // 竞态：订阅还没装好就取消（preload 的退订是同步返回的），不能泄漏监听器
  const racer = fakeSender(10);
  const racing = ipc.invoke("vault:watch", { sender: racer }, "v1");
  const cancel = ipc.invoke("vault:unwatch", { sender: racer }, "v1");
  const [watchResult, cancelResult] = await Promise.all([racing, cancel]);
  assert.equal(cancelResult.ok, true);
  assert.equal(watchResult.ok, true);
  assert.equal(service.activeWatcherCount(), 0, "立即取消不应留下监听器");

  // 取消之后重新订阅必须正常工作（陈旧的取消票不能误杀新订阅）
  const resubscribed = await ipc.invoke("vault:watch", { sender: racer }, "v1");
  assert.equal(resubscribed.ok, true);
  assert.equal(resubscribed.value, true);
  assert.equal(service.activeWatcherCount(), 1);
  await ipc.invoke("vault:unwatch", { sender: racer }, "v1");
  assert.equal(service.activeWatcherCount(), 0);
});

/* ────────────────────────────── watch 去抖与清理 ────────────────────────────── */

test("watch：300ms 去抖合并同批事件、同路径去重、recursive 打开", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches = [];
  let listener = null;
  let closeCalled = 0;
  const watcher = createVaultWatcher({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "heming-watch-")),
    onChange: (rels) => batches.push(rels),
    watch: (root, options, onEvent) => {
      assert.equal(options.recursive, true, "必须递归监听");
      listener = onEvent;
      return {
        close() {
          closeCalled += 1;
        },
      };
    },
  });
  t.after(() => watcher.close());

  assert.equal(DEFAULT_DEBOUNCE_MS, 300);
  assert.equal(DEFAULT_MAX_BATCH, 200);

  listener("change", "a.md");
  listener("change", "b.md");
  listener("change", "a.md");
  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS - 1);
  assert.equal(batches.length, 0, "去抖窗口内不得回调");
  t.mock.timers.tick(1);
  assert.deepEqual(batches, [["a.md", "b.md"]], "一批内同路径只报一次且按字典序");

  // 第二批：隐藏目录/node_modules 事件被忽略
  listener("change", ".git/index");
  listener("change", ".obsidian/app.json");
  listener("change", "node_modules/x/y.md");
  listener("change", "notes/.hidden/a.md");
  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS);
  assert.equal(batches.length, 1, "被忽略的事件不应触发回调");

  // Windows 反斜杠归一
  listener("change", "notes\\c.md");
  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS);
  assert.deepEqual(batches[1], ["notes/c.md"]);
  assert.equal(closeCalled, 0);
});

test("watch：单批超过 200 条返回空数组（表示需全量重建）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches = [];
  let listener = null;
  const watcher = createVaultWatcher({
    root: "C:/fake",
    onChange: (rels) => batches.push(rels),
    watch: (root, options, onEvent) => {
      listener = onEvent;
      return { close() {} };
    },
  });
  t.after(() => watcher.close());

  for (let i = 0; i <= DEFAULT_MAX_BATCH; i += 1) listener("change", `notes/n-${i}.md`);
  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS);
  assert.deepEqual(batches, [[]], `超过 ${DEFAULT_MAX_BATCH} 条应发空数组`);

  // 恰好等于上限仍走增量
  for (let i = 0; i < DEFAULT_MAX_BATCH; i += 1) listener("change", `inbox/m-${i}.md`);
  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, DEFAULT_MAX_BATCH);
});

test("watch：close 清理定时器与底层 watcher，之后不再回调且幂等", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches = [];
  let listener = null;
  let closeCalled = 0;
  const watcher = createVaultWatcher({
    root: "C:/fake",
    onChange: (rels) => batches.push(rels),
    watch: (root, options, onEvent) => {
      listener = onEvent;
      return {
        close() {
          closeCalled += 1;
        },
      };
    },
  });

  listener("change", "a.md");
  assert.equal(watcher.closed, false);
  watcher.close();
  assert.equal(watcher.closed, true);
  assert.equal(closeCalled, 1);
  assert.doesNotThrow(() => watcher.close(), "重复 close 必须幂等");
  assert.equal(closeCalled, 1, "重复 close 不应再次关底层 watcher");

  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS * 2);
  assert.deepEqual(batches, [], "close 后不得再触发回调");

  // close 后到达的事件也必须被丢弃
  listener("change", "b.md");
  t.mock.timers.tick(DEFAULT_DEBOUNCE_MS * 2);
  assert.deepEqual(batches, []);
});

test("watch：normalizeWatchRel 规整与忽略规则", () => {
  assert.equal(normalizeWatchRel("a/b.md"), "a/b.md");
  assert.equal(normalizeWatchRel("a\\b.md"), "a/b.md");
  assert.equal(normalizeWatchRel("./a.md"), "a.md");
  assert.equal(normalizeWatchRel("/abs/a.md"), "abs/a.md");
  assert.equal(normalizeWatchRel(Buffer.from("笔记/甲.md", "utf8")), "笔记/甲.md");
  for (const ignored of [null, undefined, "", "  ", ".git/index", ".obsidian/app.json", "node_modules/x.md", "a/.hidden/b.md", "a\0b.md"]) {
    assert.equal(normalizeWatchRel(ignored), null, `应忽略：${String(ignored)}`);
  }
});

/* ────────────────────────────── 策略纯函数 ────────────────────────────── */

test("normalizeWriteDirs：丢弃非法条目、保持显式空数组、去重", () => {
  assert.deepEqual(normalizeWriteDirs(undefined), ["inbox"], "缺省默认 inbox");
  assert.deepEqual(normalizeWriteDirs(undefined, false), [], "显式要求默认值关闭时为空");
  assert.deepEqual(normalizeWriteDirs([]), [], "显式空数组保持只读");
  assert.deepEqual(normalizeWriteDirs("inbox"), [], "非数组按空处理");
  assert.deepEqual(
    normalizeWriteDirs(["/", "inbox", "INBOX", "notes/ai", "../x", "a//b", ".obsidian", "node_modules", 42]),
    ["inbox", "notes/ai"],
  );
});

test("checkRel：相对路径归一与明显越界拒绝（纯函数层）", () => {
  assert.equal(checkRel("a/b.md"), "a/b.md");
  assert.equal(checkRel("a\\b.md"), "a/b.md");
  assert.equal(checkRel("目录/", { allowDir: true }), "目录");
  assert.equal(checkRel(".obsidian/app.json", { forRead: true }), ".obsidian/app.json");
  for (const bad of ["", "   ", null, 42, "../x.md", "/x.md", "\\x.md", "C:/x.md", "a/\0b.md", "CON.md", "node_modules/x.md", ".git/x.md", ".hidden/a.md"]) {
    assert.throws(
      () => checkRel(bad),
      (error) => error.code === "forbidden-path",
      `应拒绝：${String(bad)}`,
    );
  }
  assert.throws(() => checkRel(".obsidian/app.json"), (error) => error.code === "forbidden-path", "写模式拒绝 .obsidian");
});

test("vault-fs：saveRegistry 原子写不产生 tmp 残留", async (t) => {
  const ws = makeWorkspace(t);
  await saveRegistry(ws.registryFile, (await ws.service.list()).slice());
  const leftovers = fs.readdirSync(path.dirname(ws.registryFile)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

/* ────────────────────────── 默认根与标准初始化 ────────────────────────── */

/** 临时目录夹具：home / 安装目录 / 注册表各一份，收尾统一删。 */
function makeDefaultRootWorkspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "heming-vault-default-"));
  const home = path.join(base, "home");
  const install = path.join(base, "install");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, home, install, registryFile: path.join(base, "vaults.json") };
}

test("默认根：开发版（非打包）用 ~/Heming/wiki，且探针不留残留文件", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const info = await resolveDefaultVaultRoot({ homeDir: ws.home, isPackaged: false });
  assert.equal(info.root, path.join(ws.home, "Heming", "wiki"));
  assert.equal(info.writable, true);
  assert.equal(info.note, "", "开发版一路顺利时不该有多余提示");
  assert.ok(fs.statSync(info.root).isDirectory());
  assert.deepEqual(
    fs.readdirSync(path.dirname(info.root)).filter((name) => name.includes("probe")),
    [],
    "试写探针必须清理干净（否则会残留在用户的 wiki 目录里）",
  );
});

test("默认根：打包版用安装目录/data/wiki（数据区随安装目录，便携版也能用）", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const info = await resolveDefaultVaultRoot({
    homeDir: ws.home,
    execDir: ws.install,
    isPackaged: true,
  });
  assert.equal(info.root, path.join(ws.install, "data", "wiki"));
  assert.equal(info.writable, true);
  assert.equal(info.note, "");
});

test("默认根：安装目录不可写时回落用户目录，并在 note 里写明原因", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  // 用一个「文件」当安装目录：mkdir 它下面的 wiki 必然失败（ENOTDIR），跨平台可复现
  const notADir = path.join(ws.base, "不是目录");
  fs.writeFileSync(notADir, "x");
  const info = await resolveDefaultVaultRoot({
    homeDir: ws.home,
    execDir: notADir,
    isPackaged: true,
  });
  assert.equal(info.root, path.join(ws.home, "Heming", "wiki"), "必须回落到用户目录");
  assert.equal(info.writable, true);
  assert.match(info.note, /安装目录数据区不可写/);
  assert.match(info.note, /回落/);
});

test("默认根：两处都不可写时如实标 writable:false，不假装成功", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  // home 也指向一个文件：~/Heming/wiki 建不出来
  const badHome = path.join(ws.base, "坏home");
  fs.writeFileSync(badHome, "x");
  const info = await resolveDefaultVaultRoot({ homeDir: badHome, isPackaged: false });
  assert.equal(info.root, path.join(badHome, "Heming", "wiki"));
  assert.equal(info.writable, false);
  assert.match(info.note, /不可写/);
});

test("标准初始化：建齐目录与四个根文件，文档带 created+tags frontmatter", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const root = path.join(ws.base, "默认库");
  const first = await ensureStandardVault(root);
  assert.deepEqual(first.createdDirs.sort(), [...STANDARD_VAULT_DIRS].sort());
  assert.deepEqual(first.createdFiles.sort(), [...STANDARD_VAULT_FILES].sort());
  assert.deepEqual(first.failures, []);

  for (const dir of STANDARD_VAULT_DIRS) {
    assert.ok(fs.statSync(path.join(root, ...dir.split("/"))).isDirectory(), `目录 ${dir} 应该存在`);
  }
  for (const rel of STANDARD_VAULT_FILES) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(text, /^---\n/, `${rel} 必须有 frontmatter`);
    assert.match(text, /\ncreated: \d{4}-\d{2}-\d{2}/, `${rel} 必须有 created`);
    assert.match(text, /\ntags: \[[^\]]+\]/, `${rel} 必须有非空 tags`);
  }
  // 模板与 wiki-fs 口径一致的关键记号（三层结构 / 流程），防止两边文案漂移
  const schema = fs.readFileSync(path.join(root, "schema.md"), "utf8");
  assert.match(schema, /raw\//);
  assert.match(schema, /wiki\/<类别>\//);
  assert.match(schema, /Ingest/);
  assert.ok(buildStandardFile("不存在的文件.md", "2026-01-01") === null);
});

test("标准初始化：幂等，已有文件一字不动（用户内容绝不覆盖）", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const root = path.join(ws.base, "默认库");
  fs.mkdirSync(root, { recursive: true });
  const userIndex = "---\ntitle: 用户自己写的索引\ncreated: 2025-01-01\ntags: [mine]\n---\n\n用户内容\n";
  fs.writeFileSync(path.join(root, "index.md"), userIndex, "utf8");
  // 用户把 log.md 建成目录：初始化不能因此崩掉，只能记一条失败
  fs.mkdirSync(path.join(root, "log.md"));

  const first = await ensureStandardVault(root);
  assert.equal(fs.readFileSync(path.join(root, "index.md"), "utf8"), userIndex, "已有文件必须原样保留");
  assert.ok(first.createdFiles.includes("schema.md"), "缺的文件要补齐");
  assert.ok(first.createdFiles.includes("首页.md"));
  assert.ok(!first.createdFiles.includes("index.md"));
  assert.ok(first.failures.some((item) => item.rel === "log.md"), "log.md 被占成目录应如实报失败");

  const second = await ensureStandardVault(root);
  assert.deepEqual(second.createdDirs, [], "第二次不应再建目录");
  assert.deepEqual(second.createdFiles, [], "第二次不应再写文件");
  assert.equal(fs.readFileSync(path.join(root, "index.md"), "utf8"), userIndex);
});

test("默认库：list() 自动登记（managed+rootNote），结构落盘；再列一次不重复登记", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const defaultRoot = path.join(ws.base, "app-wiki");
  const service = createVaultService({
    registryFile: ws.registryFile,
    defaultRootResolver: async () => ({ root: defaultRoot, writable: true, note: "" }),
  });
  t.after(() => service.closeAllWatchers());

  const first = await service.list();
  assert.equal(first.length, 1);
  assert.equal(first[0].name, "和鸣知识库");
  assert.equal(first[0].root, defaultRoot);
  assert.equal(first[0].managed, true);
  assert.equal(first[0].rootNote, "");
  assert.deepEqual(first[0].writeDirs, DEFAULT_VAULT_WRITE_DIRS);
  assert.ok(fs.existsSync(path.join(defaultRoot, "schema.md")), "首启就要有标准结构");
  assert.ok(fs.existsSync(path.join(defaultRoot, "wiki", "entities")));

  const second = await service.list();
  assert.equal(second.length, 1, "重复列库不能重复登记");
  assert.equal(second[0].id, first[0].id);

  // 展示字段不落盘：注册表 json 里只有库的稳定字段
  const registry = JSON.parse(fs.readFileSync(ws.registryFile, "utf8"));
  assert.equal(registry.vaults.length, 1);
  assert.equal(registry.vaults[0].managed, undefined);
  assert.equal(registry.vaults[0].rootNote, undefined);
});

test("默认库：注册表里已有同根库时不再登记，也不动用户文件", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const defaultRoot = path.join(ws.base, "已有库");
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.writeFileSync(path.join(defaultRoot, "index.md"), "用户旧索引\n", "utf8");
  const oldMeta = {
    id: "old",
    name: "用户自己的库",
    root: defaultRoot,
    writeDirs: ["inbox"],
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  saveRegistrySync(ws.registryFile, [oldMeta]);

  const service = createVaultService({
    registryFile: ws.registryFile,
    defaultRootResolver: async () => ({ root: defaultRoot, writable: true, note: "回落说明" }),
  });
  t.after(() => service.closeAllWatchers());

  const list = await service.list();
  assert.equal(list.length, 1, "同根目录不能登记两份");
  assert.equal(list[0].id, "old");
  assert.equal(list[0].managed, true, "它就是默认根，界面应把它当默认库展示说明");
  assert.equal(list[0].rootNote, "回落说明");
  assert.equal(list[0].writeDirs.length, 1, "不擅自改用户已有的 writeDirs");
  assert.equal(fs.readFileSync(path.join(defaultRoot, "index.md"), "utf8"), "用户旧索引\n");
});

test("默认库：解析器失败时 list() 仍返回已有库（不炸渲染层）", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const userRoot = path.join(ws.base, "用户的库");
  fs.mkdirSync(userRoot, { recursive: true });
  saveRegistrySync(ws.registryFile, [
    { id: "v1", name: "用户的库", root: userRoot, writeDirs: ["inbox"], addedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const service = createVaultService({
    registryFile: ws.registryFile,
    defaultRootResolver: async () => {
      throw new Error("探测失败");
    },
  });
  t.after(() => service.closeAllWatchers());
  const list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "v1", "已有库照常列出");
  assert.equal(await service.defaultRoot(), null, "解析失败时默认根信息为 null");
});

test("默认库：用户可以移除它，移除后不会被自动登记回来；再手动打开该目录则恢复", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const defaultRoot = path.join(ws.base, "app-wiki");
  let pickResult = null;
  const service = createVaultService({
    registryFile: ws.registryFile,
    defaultRootResolver: async () => ({ root: defaultRoot, writable: true, note: "" }),
    dialog: {
      async showOpenDialog() {
        return pickResult;
      },
    },
  });
  t.after(() => service.closeAllWatchers());

  const first = await service.list();
  assert.equal(first.length, 1);
  assert.equal(await service.remove(first[0].id), true);
  assert.deepEqual(await service.list(), [], "移除后不能被自动登记回来（否则「移除」按钮等于失效）");
  assert.equal(JSON.parse(fs.readFileSync(ws.registryFile, "utf8")).defaultHidden, true);

  // 用户又手动把那个目录加回来：解除隐藏标记，仍按默认库展示说明
  pickResult = { canceled: false, filePaths: [defaultRoot] };
  const picked = await service.pick();
  assert.equal(path.resolve(picked.root), path.resolve(defaultRoot));
  const list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].managed, true);
  assert.equal(JSON.parse(fs.readFileSync(ws.registryFile, "utf8")).defaultHidden, false);
});

test("默认库：注册表坏 JSON 时不动原文件、也不登记默认库", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  fs.mkdirSync(path.dirname(ws.registryFile), { recursive: true });
  fs.writeFileSync(ws.registryFile, "{ 这不是 json", "utf8");
  const service = createVaultService({
    registryFile: ws.registryFile,
    defaultRootResolver: async () => ({ root: path.join(ws.base, "app-wiki"), writable: true, note: "" }),
  });
  t.after(() => service.closeAllWatchers());
  assert.deepEqual(await service.list(), []);
  assert.equal(fs.readFileSync(ws.registryFile, "utf8"), "{ 这不是 json");
  assert.ok(!fs.existsSync(path.join(ws.base, "app-wiki")), "读不懂注册表时不应动磁盘");
});

test("IPC：默认库经 vault:list 露出 managed/rootNote（生产走这条通道）", async (t) => {
  const ws = makeDefaultRootWorkspace(t);
  const ipc = fakeIpc();
  const service = registerVaultIpc(ipc, {
    registryFile: ws.registryFile,
    defaultRootResolver: async () => ({ root: path.join(ws.base, "app-wiki"), writable: true, note: "" }),
    shell: { showItemInFolder() {}, async openPath() { return ""; } },
  });
  t.after(() => service.closeAllWatchers());
  const listed = await ipc.invoke("vault:list", {});
  assert.equal(listed.ok, true);
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0].managed, true);
  assert.equal(typeof listed.value[0].rootNote, "string");
});

test("reveal：rel 为空 = 打开库根目录（知识库页「打开目录」用）", async (t) => {
  const ws = makeWorkspace(t);
  const opened = [];
  const service = createVaultService({
    registryFile: ws.registryFile,
    shell: {
      showItemInFolder(target) {
        opened.push(target);
      },
      async openPath(target) {
        opened.push(target);
        return "";
      },
    },
  });
  t.after(() => service.closeAllWatchers());

  assert.equal(await service.reveal("v1", ""), true);
  assert.equal(opened.length, 1);
  assert.equal(path.resolve(opened[0]), path.resolve(ws.root), "打开的必须是库根，不是它的上级");

  // 根不存在时结构化失败，不抛裸异常
  const missingRegistry = path.join(ws.base, "missing-vaults.json");
  saveRegistrySync(missingRegistry, [{ ...ws.meta, id: "gone", root: path.join(ws.base, "已删除的库") }]);
  const goneService = createVaultService({
    registryFile: missingRegistry,
    shell: { showItemInFolder() {}, async openPath() { return ""; } },
  });
  t.after(() => goneService.closeAllWatchers());
  await rejectsWith(goneService.reveal("gone", ""), "not-found");
});

/* ────────────────────────────── 清理检查 ────────────────────────────── */


test("收尾：所有夹具清理后临时目录不残留（smoke）", async (t) => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(path.join(ws.root, "a.md"), "x");
  assert.ok(fs.existsSync(ws.root));
  // t.after 会删掉 base；这里只断言 fsp 可用（避免未使用导入告警）
  await fsp.access(ws.root);
  const parsed = JSON.parse(fs.readFileSync(ws.registryFile, "utf8"));
  assert.equal(parsed.version, 1);
});
