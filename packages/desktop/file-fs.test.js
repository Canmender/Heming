/**
 * 文件编辑桥（file-fs.js）的安全测试。
 *
 * 这个桥把网页（不可信输入）传来的目标路径与内容写到本机磁盘，
 * 是整条 `file_patch` 链路的最后一道闸。所以每个越界用例都必须断言两件事：
 * **调用被拒绝**，且**磁盘上没有任何新文件 / 原内容一字未变**——
 * 只断言「返回了错误」的话，一个「先写后校验」的实现也能让测试通过。
 *
 * 运行：`node --test file-fs.test.js`
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  registerFileIpc,
  normalizeRoots,
  findRoot,
  readFile,
  writeBatch,
  MAX_FILE_BYTES,
} = require("./file-fs.js");

/** 一个临时工作区：一个可写根 + 一个只读根。 */
function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "heming-filefs-"));
  const writeRoot = path.join(base, "库");
  const readRoot = path.join(base, "参考");
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.mkdirSync(readRoot, { recursive: true });
  return {
    base,
    writeRoot,
    readRoot,
    roots: [
      { name: "库", path: writeRoot, mode: "write" },
      { name: "参考", path: readRoot, mode: "read" },
    ],
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** 目录里留下的临时文件（应当恒为空：tmp+rename 不该留垃圾）。 */
function tmpLeftovers(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.includes(".heming-tmp-"));
  } catch {
    return [];
  }
}

/** 递归找临时文件。 */
function tmpLeftoversDeep(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes(".heming-tmp-")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 假 ipcMain：收集 handler，便于直接按通道调用。 */
function fakeIpc() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    async invoke(channel, payload, event = { sender: "main" }) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`未注册的通道 ${channel}`);
      return fn(event, payload);
    },
  };
}

/** 注册桥（默认信任所有来源，便于测业务逻辑；来源校验单独测）。 */
function register(deps = {}) {
  const ipc = fakeIpc();
  registerFileIpc(ipc, {
    dialog: deps.dialog,
    getMainWindow: deps.getMainWindow ?? (() => null),
    isTrustedSender: deps.isTrustedSender ?? (() => true),
  });
  return ipc;
}

/** 在临时工作区里跑一个用例，结束自动清理。 */
function withWorkspace(fn) {
  const ws = makeWorkspace();
  return Promise.resolve(fn(ws)).finally(() => ws.cleanup());
}

/* ────────────────────────────── 正常路径 ────────────────────────────── */

test("写入根内文件：内容落盘正确，且不留临时文件", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "笔记.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "第一行\n第二行\n" }]);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(target, "utf8"), "第一行\n第二行\n");
    assert.deepEqual(tmpLeftovers(ws.writeRoot), []);
  }));

test("新增子目录里的文件（父目录已存在）：写入成功", () =>
  withWorkspace(async (ws) => {
    fs.mkdirSync(path.join(ws.writeRoot, "notes"));
    const target = path.join(ws.writeRoot, "notes", "a.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "甲\n" }]);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(target, "utf8"), "甲\n");
  }));

test("删除文件：成功后磁盘上确实没有了", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "旧.md");
    fs.writeFileSync(target, "旧内容\n");
    const result = await writeBatch(ws.roots, [{ kind: "delete", path: target }]);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(target), false);
  }));

test("改名语义：变更列表里删除在前也要先写新文件再删旧文件", () =>
  withWorkspace(async (ws) => {
    const src = path.join(ws.writeRoot, "a.md");
    const dest = path.join(ws.writeRoot, "b.md");
    fs.writeFileSync(src, "旧内容\n");
    const result = await writeBatch(ws.roots, [
      { kind: "delete", path: src },
      { kind: "write", path: dest, content: "新内容\n" },
    ]);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(dest, "utf8"), "新内容\n");
  }));

test("CRLF 原样保留（不做行尾转换）", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "crlf.md");
    await writeBatch(ws.roots, [{ kind: "write", path: target, content: "甲\r\n乙\r\n" }]);
    const read = await readFile(ws.roots, target);
    assert.equal(read.ok, true);
    assert.equal(read.content, "甲\r\n乙\r\n");
  }));

/* ────────────────────────────── 越界与拒绝 ────────────────────────────── */

test("根外路径写入被拒绝，且磁盘上没有新文件", () =>
  withWorkspace(async (ws) => {
    const outside = path.join(ws.base, "根外.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: outside, content: "越界\n" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /不在任何已配置的根内/);
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(tmpLeftoversDeep(ws.base), []);
  }));

test("`..` 逃出根的路径被拒绝，且磁盘上没有新文件", () =>
  withWorkspace(async (ws) => {
    const escape = path.join(ws.writeRoot, "..", "逃逸.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: escape, content: "越界\n" }]);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(ws.base, "逃逸.md")), false);
    assert.deepEqual(tmpLeftoversDeep(ws.base), []);
  }));

test("只读根写入被拒绝，且原文件内容未变", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.readRoot, "参考.md");
    fs.writeFileSync(target, "原始内容\n");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "被改内容\n" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /只读根/);
    assert.equal(fs.readFileSync(target, "utf8"), "原始内容\n");
  }));

test("父目录不存在时拒绝写入，且不替用户创建目录", () =>
  withWorkspace(async (ws) => {
    const missingDir = path.join(ws.writeRoot, "还没建的目录");
    const target = path.join(missingDir, "a.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "甲\n" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /父目录/);
    assert.equal(fs.existsSync(missingDir), false);
    assert.equal(fs.existsSync(target), false);
  }));

test("目标是目录时拒绝（不能把目录当文件覆盖）", () =>
  withWorkspace(async (ws) => {
    const dir = path.join(ws.writeRoot, "一个目录");
    fs.mkdirSync(dir);
    const result = await writeBatch(ws.roots, [{ kind: "write", path: dir, content: "甲\n" }]);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  }));

test("目标路径含 NUL 时拒绝", () =>
  withWorkspace(async (ws) => {
    const bad = `${ws.writeRoot}/a\u0000b.md`;
    const result = await writeBatch(ws.roots, [{ kind: "write", path: bad, content: "甲\n" }]);
    assert.equal(result.ok, false);
    const read = await readFile(ws.roots, bad);
    assert.equal(read.ok, false);
    assert.equal(read.code, "invalid-path");
  }));

test("Windows 保留名拒绝写入", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "con.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "甲\n" }]);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(target), false);
  }));

test("软链目标拒绝写入（不跟随链接，避免写到根外）", (t) =>
  withWorkspace(async (ws) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-out-"));
    try {
      const link = path.join(ws.writeRoot, "链接");
      // Windows 上文件软链要管理员/开发者模式；指向目录的 junction 不需要，
      // 且 lstat 同样报 isSymbolicLink——「目标是软链」这条判定照样能测到。
      try {
        fs.symlinkSync(outside, link, "dir");
      } catch {
        try {
          fs.symlinkSync(outside, link, "junction");
        } catch (e) {
          t.skip(`当前环境不能创建目录链接（${e.code}），跳过`);
          return;
        }
      }
      const result = await writeBatch(ws.roots, [{ kind: "write", path: link, content: "覆盖\n" }]);
      assert.equal(result.ok, false);
      assert.match(result.error, /符号链接/);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

test("软链祖先目录拒绝（根内子目录指向根外）", (t) =>
  withWorkspace(async (ws) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-out-"));
    try {
      const link = path.join(ws.writeRoot, "外链目录");
      try {
        fs.symlinkSync(outside, link, "dir");
      } catch {
        try {
          fs.symlinkSync(outside, link, "junction");
        } catch (e) {
          t.skip(`当前环境不能创建目录链接（${e.code}），跳过`);
          return;
        }
      }
      const target = path.join(link, "a.md");
      const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "越界\n" }]);
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(path.join(outside, "a.md")), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

test("硬链接目标拒绝（nlink>1 可能同时改到根外的另一份）", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "硬链接.md");
    fs.writeFileSync(target, "共享内容\n");
    const alias = path.join(ws.base, "别名.md");
    fs.linkSync(target, alias);
    try {
      const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "覆盖\n" }]);
      assert.equal(result.ok, false);
      assert.match(result.error, /硬链接/);
      assert.equal(fs.readFileSync(target, "utf8"), "共享内容\n");
    } finally {
      fs.rmSync(alias, { force: true });
    }
  }));

test("删除不存在的文件被拒绝", () =>
  withWorkspace(async (ws) => {
    const result = await writeBatch(ws.roots, [{ kind: "delete", path: path.join(ws.writeRoot, "没有.md") }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /不存在/);
  }));

test("内容超过单文件上限时拒绝，且不写盘", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "大.md");
    const result = await writeBatch(ws.roots, [
      { kind: "write", path: target, content: "x".repeat(MAX_FILE_BYTES + 1) },
    ]);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(target), false);
  }));

/* ────────────────────────────── 读盘 ────────────────────────────── */

test("读盘：二进制文件被拒绝（前 8KB 含 NUL）", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "二进制.bin");
    fs.writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const result = await readFile(ws.roots, target);
    assert.equal(result.ok, false);
    assert.equal(result.code, "binary");
  }));

test("读盘：非法 UTF-8 序列被拒绝", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "坏编码.txt");
    fs.writeFileSync(target, Buffer.from([0xc3, 0x28, 0x41])); // 非法 UTF-8，无 NUL
    const result = await readFile(ws.roots, target);
    assert.equal(result.ok, false);
    assert.equal(result.code, "binary");
  }));

test("读盘：超过单文件上限被拒绝", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "超限.md");
    fs.writeFileSync(target, "x".repeat(MAX_FILE_BYTES + 1));
    const result = await readFile(ws.roots, target);
    assert.equal(result.ok, false);
    assert.equal(result.code, "too-large");
  }));

test("读盘：根外路径被拒绝", () =>
  withWorkspace(async (ws) => {
    const result = await readFile(ws.roots, path.join(ws.base, "根外.md"));
    assert.equal(result.ok, false);
    assert.equal(result.code, "outside-roots");
  }));

test("读盘：只读根可读", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.readRoot, "参考.md");
    fs.writeFileSync(target, "可读内容\n");
    const result = await readFile(ws.roots, target);
    assert.equal(result.ok, true);
    assert.equal(result.content, "可读内容\n");
  }));

/* ────────────────────────────── 原子性与并发 ────────────────────────────── */

test("rename 失败时：原文件不变，临时文件被清理", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "a.md");
    fs.writeFileSync(target, "原内容\n");
    const originalRename = fsp.rename;
    fsp.rename = async () => {
      throw new Error("模拟 rename 失败");
    };
    try {
      const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "新内容\n" }]);
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(target, "utf8"), "原内容\n");
      assert.deepEqual(tmpLeftoversDeep(ws.base), []);
    } finally {
      fsp.rename = originalRename;
    }
  }));

test("并发两次写同一文件：串行执行，最终内容是完整的一份", () =>
  withWorkspace(async (ws) => {
    const ipc = register();
    const target = path.join(ws.writeRoot, "并发.md");
    fs.writeFileSync(target, "初始\n");
    const payload = (content) => ({ roots: ws.roots, ops: [{ kind: "write", path: target, content }] });
    const [first, second] = await Promise.all([
      ipc.invoke("file:write", payload("第一份\n")),
      ipc.invoke("file:write", payload("第二份\n")),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    // 排队执行 ⇒ 后一个覆盖前一个，内容不会交错
    assert.equal(fs.readFileSync(target, "utf8"), "第二份\n");
    assert.deepEqual(tmpLeftovers(ws.writeRoot), []);
  }));

/* ────────────────────────────── IPC 边界 ────────────────────────────── */

test("非主窗口来源的调用一律拒绝（含读、写、选目录）", () =>
  withWorkspace(async (ws) => {
    const ipc = register({ isTrustedSender: () => false });
    const write = await ipc.invoke("file:write", {
      roots: ws.roots,
      ops: [{ kind: "write", path: path.join(ws.writeRoot, "a.md"), content: "甲\n" }],
    });
    assert.equal(write.ok, false);
    assert.equal(write.code, "untrusted-sender");
    const read = await ipc.invoke("file:read", { roots: ws.roots, path: path.join(ws.writeRoot, "a.md") });
    assert.equal(read.ok, false);
    assert.equal(read.code, "untrusted-sender");
    const picked = await ipc.invoke("file:pick-root", {});
    assert.equal(picked, null);
    assert.equal(fs.existsSync(path.join(ws.writeRoot, "a.md")), false);
  }));

test("未配置任何根时读写都拒绝", () =>
  withWorkspace(async (ws) => {
    const ipc = register();
    const read = await ipc.invoke("file:read", { roots: [], path: path.join(ws.writeRoot, "a.md") });
    assert.equal(read.ok, false);
    assert.equal(read.code, "no-roots");
    const write = await ipc.invoke("file:write", {
      roots: [],
      ops: [{ kind: "write", path: path.join(ws.writeRoot, "a.md"), content: "甲\n" }],
    });
    assert.equal(write.ok, false);
  }));

test("选目录：取消返回 null，选中返回路径", () =>
  withWorkspace(async (ws) => {
    const canceled = register({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
    assert.equal(await canceled.invoke("file:pick-root", {}), null);

    const picked = register({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [ws.writeRoot] }) },
    });
    assert.equal(await picked.invoke("file:pick-root", {}), ws.writeRoot);
  }));

test("选目录：dialog 抛错时返回 null（不让渲染层拿到 rejection）", () =>
  withWorkspace(async () => {
    const ipc = register({
      dialog: {
        showOpenDialog: async () => {
          throw new Error("dialog 炸了");
        },
      },
    });
    assert.equal(await ipc.invoke("file:pick-root", {}), null);
  }));

/* ────────────────────────────── 根清单规整 ────────────────────────────── */

test("normalizeRoots：丢弃坏条目、去重、拒绝盘符根", () => {
  const roots = normalizeRoots([
    { name: "库", path: "D:/库", mode: "write" },
    { name: "库重复", path: "D:/库", mode: "read" },
    { name: "", path: "D:/x", mode: "write" },
    { name: "坏模式", path: "D:/y", mode: "full" },
    { name: "相对", path: "相对/路径", mode: "write" },
    { name: "盘符根", path: "D:/", mode: "write" },
    { name: "NUL", path: "D:/a\u0000b", mode: "write" },
    null,
    "字符串",
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, "库");
  assert.equal(roots[0].mode, "write");
});

test("findRoot：最长前缀优先（更具体的子目录规则覆盖外层根）", () => {
  const roots = normalizeRoots([
    { name: "外层", path: "D:/库", mode: "write" },
    { name: "内层", path: "D:/库/私人", mode: "read" },
  ]);
  assert.equal(findRoot(roots, "D:/库/a.md").name, "外层");
  assert.equal(findRoot(roots, "D:/库/私人/b.md").name, "内层");
  assert.equal(findRoot(roots, "D:/别处/c.md"), null);
});
