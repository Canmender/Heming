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
  readImage,
  sniffImageMime,
  writeBatch,
  undoWrite,
  previewBackup,
  listBackups,
  createBackup,
  readBackupIndex,
  MAX_BACKUPS_PER_PATH,
  globToRegExp,
  globFiles,
  grepFiles,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_GLOB_RESULTS,
  MAX_GREP_MATCHES,
  MAX_GREP_LINE_CHARS,
  MAX_WALK_DEPTH,
  decodeTextBytes,
  revealFile,
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
  const syncHandlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    // preload 用 sendSync 问的通道必须用 `on` + `event.returnValue` 注册——
    // 用 handle 注册会让渲染进程永远等不到返回（窗口加载不出来）。
    on(channel, fn) {
      syncHandlers.set(channel, fn);
    },
    async invoke(channel, payload, event = { sender: "main" }) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`未注册的通道 ${channel}`);
      return fn(event, payload);
    },
    sendSync(channel, payload, event = { sender: "main" }) {
      const fn = syncHandlers.get(channel);
      if (!fn) throw new Error(`未同步注册的通道 ${channel}`);
      const box = { ...event, returnValue: undefined };
      fn(box, payload);
      return box.returnValue;
    },
    isSync(channel) {
      return syncHandlers.has(channel);
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
    defaultRootDir: deps.defaultRootDir,
    shell: deps.shell,
    backupDir: deps.backupDir,
  });
  return ipc;
}

/** 在临时工作区里跑一个用例，结束自动清理。 */
function withWorkspace(fn) {
  const ws = makeWorkspace();
  return Promise.resolve(fn(ws)).finally(() => ws.cleanup());
}

/** 建一个指向目录的链接；环境不允许时跳过当前用例并返回 false。 */
function makeDirLink(t, target, link) {
  try {
    fs.symlinkSync(target, link, "dir");
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link, "junction");
      return true;
    } catch (e) {
      t.skip(`当前环境不能创建目录链接（${e.code}），跳过`);
      return false;
    }
  }
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

/* ───────────── ③-4 安全复审：零网络的结构性守卫 ───────────── */

/** 剥掉 // 与 /* *\/ 注释，避免注释里的「网络」字样干扰判定（要求剥注释后 grep）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("源码（剥注释后）不含任何网络能力：fetch / http / https / net / dns / tls / WebSocket", () => {
  const raw = fs.readFileSync(path.join(__dirname, "file-fs.js"), "utf8");
  const src = stripComments(raw);
  assert.ok(!/\bfetch\s*\(/.test(src), "file-fs.js 不应发起 fetch");
  assert.ok(!/XMLHttpRequest/.test(src), "file-fs.js 不应使用 XMLHttpRequest");
  assert.ok(!/\bnew\s+WebSocket\b/.test(src), "file-fs.js 不应建 WebSocket");
  assert.ok(!/require\(\s*["'](?:node:)?(?:http|https|net|dgram|dns|tls)["']\s*\)/.test(src));
  // require 白名单：只允许文件系统/路径/加密与共享路径判定
  const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const allowed = new Set(["node:fs", "node:fs/promises", "node:path", "node:crypto", "./path-guard"]);
  for (const mod of required) assert.ok(allowed.has(mod), `file-fs.js 引入了非白名单模块：${mod}`);
});

/* ────────────────────────────── glob 语法 ────────────────────────────── */

test("globToRegExp：`*` 只在段内、`?` 匹配单字符、大小写不敏感", () => {
  const re = globToRegExp("*.md");
  assert.equal(re.test("a.md"), true);
  assert.equal(re.test("a.txt"), false);
  assert.equal(re.test("子目录/a.md"), false, "`*` 不应跨段");
  assert.equal(globToRegExp("a?.md").test("a1.md"), true);
  assert.equal(globToRegExp("a?.md").test("ab.md"), true);
  assert.equal(globToRegExp("a?.md").test("abc.md"), false, "`?` 只吃一个字符");
  assert.equal(globToRegExp("Report.MD").test("report.md"), true);
});

test("globToRegExp：`**` 跨段，且双星后接斜杠时可匹配零层", () => {
  const re = globToRegExp("**/*.ts");
  assert.equal(re.test("a.ts"), true, "应能命中根下文件（零层）");
  assert.equal(re.test("src/a.ts"), true);
  assert.equal(re.test("src/lib/a.ts"), true);
  const nested = globToRegExp("src/**/*.ts");
  assert.equal(nested.test("src/lib/deep/a.ts"), true);
  assert.equal(nested.test("a.ts"), false, "有前缀目录约束时不应命中外层文件");
});

test("globToRegExp：`{a,b}` 并集、`[abc]` 字符集（含取反）", () => {
  const union = globToRegExp("*.{md,txt}");
  assert.equal(union.test("笔记.md"), true);
  assert.equal(union.test("笔记.txt"), true);
  assert.equal(union.test("笔记.js"), false);
  const cls = globToRegExp("file[0-9].log");
  assert.equal(cls.test("file3.log"), true);
  assert.equal(cls.test("filex.log"), false);
  const negated = globToRegExp("file[!0-9].log");
  assert.equal(negated.test("filex.log"), true);
  assert.equal(negated.test("file3.log"), false);
});

test("globToRegExp：非法模式抛 invalid-pattern（未闭合/空/绝对路径/过长）", () => {
  const bad = ["", "   ", "a/[", "a/{b", "/abs/*.md", "C:/x/*.md", "x".repeat(2000)];
  for (const pattern of bad) {
    assert.throws(() => globToRegExp(pattern), (e) => e && e.code === "invalid-pattern", `应拒绝：${pattern}`);
  }
});

/* ────────────────────────────── globFiles ────────────────────────────── */

test("globFiles：返回绝对路径、root，并按 mtime 降序（同 mtime 再按相对路径升序）", () =>
  withWorkspace(async (ws) => {
    const older = path.join(ws.writeRoot, "a.md");
    const newer = path.join(ws.writeRoot, "b.md");
    fs.writeFileSync(older, "甲\n");
    fs.writeFileSync(newer, "乙\n");
    fs.utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.utimesSync(newer, new Date(2021, 0, 1), new Date(2021, 0, 1));
    const result = await globFiles({ roots: ws.roots, pattern: "*.md" });
    assert.equal(result.ok, true);
    assert.equal(result.root.toLowerCase(), ws.writeRoot.toLowerCase());
    assert.deepEqual(result.paths, [newer, older]);
    assert.equal(result.truncated, false);
  }));

test("globFiles：跳过 node_modules / .git，但包含隐藏文件", () =>
  withWorkspace(async (ws) => {
    fs.mkdirSync(path.join(ws.writeRoot, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(ws.writeRoot, "node_modules", "pkg", "x.md"), "x");
    fs.mkdirSync(path.join(ws.writeRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(ws.writeRoot, ".git", "y.md"), "y");
    fs.writeFileSync(path.join(ws.writeRoot, ".隐藏.md"), "h");
    fs.mkdirSync(path.join(ws.writeRoot, "src"));
    fs.writeFileSync(path.join(ws.writeRoot, "src", "a.md"), "a");
    const result = await globFiles({ roots: ws.roots, pattern: "**/*.md" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths.map((p) => path.basename(p)).sort(), [".隐藏.md", "a.md"]);
  }));

test("globFiles：构建产物目录默认跳过，但结果里点名说清（d.231）", () =>
  withWorkspace(async (ws) => {
    for (const dir of ["src", "dist", "build", "node_modules/pkg"]) {
      fs.mkdirSync(path.join(ws.writeRoot, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(ws.writeRoot, "src", "a.md"), "a");
    fs.writeFileSync(path.join(ws.writeRoot, "dist", "bundle.md"), "b");
    fs.writeFileSync(path.join(ws.writeRoot, "build", "gen.md"), "g");
    fs.writeFileSync(path.join(ws.writeRoot, "node_modules", "pkg", "dep.md"), "d");
    const result = await globFiles({ roots: ws.roots, pattern: "**/*.md" });
    assert.equal(result.ok, true);
    // 源码找得到，产物一个都不混进来
    assert.deepEqual(result.paths.map((p) => path.basename(p)), ["a.md"]);
    // 但「没搜到」不等于「不存在」：跳过了谁必须点名
    assert.deepEqual(result.skipped, ["build", "dist", "node_modules"]);
  }));

test("globFiles：把 dir 指到被跳过的目录里，照样搜得到（不是禁地）", () =>
  withWorkspace(async (ws) => {
    fs.mkdirSync(path.join(ws.writeRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(ws.writeRoot, "dist", "bundle.md"), "b");
    const result = await globFiles({
      roots: ws.roots,
      pattern: "*.md",
      dir: path.join(ws.writeRoot, "dist"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths.map((p) => path.basename(p)), ["bundle.md"]);
    // 起点本身是被跳过的目录：不再有「跳过」可报
    assert.deepEqual(result.skipped, []);
  }));

test("grepFiles：产物目录里的命中不算，但 skipped 说清跳过了谁（d.231）", () =>
  withWorkspace(async (ws) => {
    fs.mkdirSync(path.join(ws.writeRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(ws.writeRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(ws.writeRoot, "src", "a.ts"), "const need = 1;\n");
    fs.writeFileSync(path.join(ws.writeRoot, "dist", "bundle.js"), "var need=1;\n");
    const result = await grepFiles({ roots: ws.roots, pattern: "need" });
    assert.equal(result.ok, true);
    assert.equal(result.matches.length, 1);
    assert.equal(path.basename(result.matches[0].path), "a.ts");
    assert.deepEqual(result.skipped, ["dist"]);
  }));

test("globFiles：不把本模块的原子写临时文件当用户文件", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "a.md"), "a");
    fs.writeFileSync(path.join(ws.writeRoot, ".a.md.heming-tmp-abcdef"), "tmp");
    const result = await globFiles({ roots: ws.roots, pattern: "**/*" });
    assert.deepEqual(result.paths.map((p) => path.basename(p)), ["a.md"]);
  }));

test("globFiles：软链目录不跟随（链接指向根外也不泄漏）", (t) =>
  withWorkspace(async (ws) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-out-"));
    try {
      fs.writeFileSync(path.join(outside, "外.md"), "外");
      if (!makeDirLink(t, outside, path.join(ws.writeRoot, "外链"))) return;
      const result = await globFiles({ roots: ws.roots, pattern: "**/*.md" });
      assert.equal(result.ok, true);
      assert.deepEqual(result.paths, []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

test("globFiles：结果上限 MAX_GLOB_RESULTS，超限 truncated=true", () =>
  withWorkspace(async (ws) => {
    for (let i = 0; i <= MAX_GLOB_RESULTS; i += 1) {
      fs.writeFileSync(path.join(ws.writeRoot, `f${String(i).padStart(3, "0")}.md`), "x");
    }
    const result = await globFiles({ roots: ws.roots, pattern: "*.md" });
    assert.equal(result.ok, true);
    assert.equal(result.paths.length, MAX_GLOB_RESULTS);
    assert.equal(result.truncated, true);
  }));

test("globFiles：超过深度上限的子目录不遍历，但 truncated=true 明示", () =>
  withWorkspace(async (ws) => {
    let dir = ws.writeRoot;
    for (let i = 1; i <= MAX_WALK_DEPTH + 2; i += 1) {
      dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(path.join(dir, "深.md"), "深");
    fs.writeFileSync(path.join(ws.writeRoot, "浅.md"), "浅");
    const result = await globFiles({ roots: ws.roots, pattern: "**/*.md" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths.map((p) => path.basename(p)), ["浅.md"]);
    assert.equal(result.truncated, true);
  }));

test("globFiles：dir 必须夹在根内；根外/不存在/非目录统一 outside-roots", () =>
  withWorkspace(async (ws) => {
    const outside = await globFiles({ roots: ws.roots, pattern: "*.md", dir: ws.base });
    assert.equal(outside.ok, false);
    assert.equal(outside.code, "outside-roots");
    const missing = await globFiles({ roots: ws.roots, pattern: "*.md", dir: path.join(ws.writeRoot, "没有") });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "outside-roots");
    fs.writeFileSync(path.join(ws.writeRoot, "a.md"), "a");
    const notDir = await globFiles({ roots: ws.roots, pattern: "*.md", dir: path.join(ws.writeRoot, "a.md") });
    assert.equal(notDir.ok, false);
    assert.equal(notDir.code, "outside-roots");
  }));

test("globFiles：dir 缺省用第一个根；指定根内子目录时模式相对该目录", () =>
  withWorkspace(async (ws) => {
    fs.mkdirSync(path.join(ws.writeRoot, "src"));
    fs.writeFileSync(path.join(ws.writeRoot, "src", "a.md"), "a");
    fs.writeFileSync(path.join(ws.writeRoot, "b.md"), "b");
    const byDefault = await globFiles({ roots: ws.roots, pattern: "**/*.md" });
    assert.equal(byDefault.paths.length, 2);
    const nested = await globFiles({ roots: ws.roots, pattern: "*.md", dir: path.join(ws.writeRoot, "src") });
    assert.deepEqual(nested.paths.map((p) => path.basename(p)), ["a.md"]);
  }));

test("搜索覆盖只读根（读权限即可）", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.readRoot, "参考.md"), "needle\n");
    const globbed = await globFiles({ roots: ws.roots, pattern: "*.md", dir: ws.readRoot });
    assert.equal(globbed.ok, true);
    assert.deepEqual(globbed.paths.map((p) => path.basename(p)), ["参考.md"]);
    const grepped = await grepFiles({ roots: ws.roots, pattern: "needle", dir: ws.readRoot });
    assert.equal(grepped.ok, true);
    assert.equal(grepped.matches.length, 1);
  }));

test("globFiles：未配置根时返回 no-roots", async () => {
  const result = await globFiles({ roots: [], pattern: "*.md" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-roots");
});

test("IPC file:glob：正常返回；非可信来源被拒绝（fail-closed）", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "a.md"), "a");
    const ipc = register();
    const ok = await ipc.invoke("file:glob", { roots: ws.roots, pattern: "*.md" });
    assert.equal(ok.ok, true);
    assert.equal(ok.paths.length, 1);
    const blocked = await register({ isTrustedSender: () => false }).invoke("file:glob", {
      roots: ws.roots,
      pattern: "*.md",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "untrusted-sender");
  }));

/* ────────────────────────────── grepFiles ────────────────────────────── */

test("grepFiles：命中行号/行文本正确，返回绝对路径与 root", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "a.md");
    fs.writeFileSync(target, "第一行\n第二行 needle\n第三行\n");
    const result = await grepFiles({ roots: ws.roots, pattern: "needle" });
    assert.equal(result.ok, true);
    assert.equal(result.root.toLowerCase(), ws.writeRoot.toLowerCase());
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, target);
    assert.equal(result.matches[0].line, 2);
    assert.equal(result.matches[0].text, "第二行 needle");
    assert.equal(result.truncated, false);
  }));

test("grepFiles：CRLF 行号正确；内容匹配大小写敏感", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "a.md"), "alpha\r\nFoo\r\nfoo\r\n");
    const lower = await grepFiles({ roots: ws.roots, pattern: "foo" });
    assert.deepEqual(lower.matches.map((m) => m.line), [3]);
    const upper = await grepFiles({ roots: ws.roots, pattern: "Foo" });
    assert.deepEqual(upper.matches.map((m) => m.line), [2]);
  }));

test("grepFiles：include 过滤（按文件名与相对路径两种写法）", () =>
  withWorkspace(async (ws) => {
    fs.mkdirSync(path.join(ws.writeRoot, "src"));
    fs.writeFileSync(path.join(ws.writeRoot, "src", "a.ts"), "hit\n");
    fs.writeFileSync(path.join(ws.writeRoot, "src", "b.txt"), "hit\n");
    const byName = await grepFiles({ roots: ws.roots, pattern: "hit", include: "*.ts" });
    assert.deepEqual(byName.matches.map((m) => path.basename(m.path)), ["a.ts"]);
    const byPath = await grepFiles({ roots: ws.roots, pattern: "hit", include: "src/**/*.ts" });
    assert.deepEqual(byPath.matches.map((m) => path.basename(m.path)), ["a.ts"]);
  }));

test("grepFiles：二进制 / 非法 UTF-8 / 超 2MB 文件被静默跳过", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "bin.dat"), Buffer.from([0x68, 0x69, 0x74, 0x00]));
    fs.writeFileSync(path.join(ws.writeRoot, "bad.txt"), Buffer.from([0xc3, 0x28, 0x68, 0x69, 0x74]));
    fs.writeFileSync(path.join(ws.writeRoot, "big.txt"), `hit\n${"x".repeat(MAX_FILE_BYTES)}`);
    const result = await grepFiles({ roots: ws.roots, pattern: "hit" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.matches, []);
  }));

test("grepFiles：长行只回传前 MAX_GREP_LINE_CHARS 个字符", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "long.md"), `hit ${"x".repeat(MAX_GREP_LINE_CHARS * 2)}\n`);
    const result = await grepFiles({ roots: ws.roots, pattern: "hit" });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].text.length, MAX_GREP_LINE_CHARS);
  }));

test("grepFiles：命中上限 MAX_GREP_MATCHES，超限 truncated=true", () =>
  withWorkspace(async (ws) => {
    const lines = Array.from({ length: MAX_GREP_MATCHES + 5 }, () => "hit").join("\n");
    fs.writeFileSync(path.join(ws.writeRoot, "many.md"), lines);
    const result = await grepFiles({ roots: ws.roots, pattern: "hit" });
    assert.equal(result.matches.length, MAX_GREP_MATCHES);
    assert.equal(result.truncated, true);
  }));

test("grepFiles：非法正则 / 根外 dir / 无根 分别给出契约错误码", () =>
  withWorkspace(async (ws) => {
    const bad = await grepFiles({ roots: ws.roots, pattern: "[" });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "invalid-pattern");
    const outside = await grepFiles({ roots: ws.roots, pattern: "x", dir: ws.base });
    assert.equal(outside.ok, false);
    assert.equal(outside.code, "outside-roots");
    const none = await grepFiles({ roots: [], pattern: "x" });
    assert.equal(none.ok, false);
    assert.equal(none.code, "no-roots");
  }));

test("IPC file:grep：正常返回；非可信来源被拒绝（fail-closed）", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "a.md"), "needle\n");
    const ipc = register();
    const ok = await ipc.invoke("file:grep", { roots: ws.roots, pattern: "needle" });
    assert.equal(ok.ok, true);
    assert.equal(ok.matches.length, 1);
    const blocked = await register({ isTrustedSender: () => false }).invoke("file:grep", {
      roots: ws.roots,
      pattern: "needle",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "untrusted-sender");
  }));

/* ────────────────────────────── write 建父目录（createParents） ────────────────────────────── */

test("createParents=true：补建深层父目录并写入（仍走 tmp+rename，无残留）", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "新", "深", "层", "a.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "深层内容\n" }], true);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(target, "utf8"), "深层内容\n");
    assert.deepEqual(tmpLeftoversDeep(ws.writeRoot), []);
  }));

test("createParents 默认 false：父目录仍不会被创建（老语义不变）", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "别建", "a.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "甲\n" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /父目录/);
    assert.equal(fs.existsSync(path.join(ws.writeRoot, "别建")), false);
  }));

test("createParents=true：父目录名是 Windows 保留名时拒绝，且不建目录", () =>
  withWorkspace(async (ws) => {
    const target = path.join(ws.writeRoot, "con", "a.md");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "甲\n" }], true);
    assert.equal(result.ok, false);
    assert.match(result.error, /保留名/);
    assert.equal(fs.existsSync(path.join(ws.writeRoot, "con")), false);
  }));

test("createParents=true：父路径中间是普通文件时拒绝，原文件内容不变", () =>
  withWorkspace(async (ws) => {
    const blocker = path.join(ws.writeRoot, "占位");
    fs.writeFileSync(blocker, "原内容\n");
    const result = await writeBatch(ws.roots, [{ kind: "write", path: path.join(blocker, "a.md"), content: "甲\n" }], true);
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(blocker, "utf8"), "原内容\n");
  }));

test("createParents=true：中间软链目录仍拒绝（不放宽软链红线）", (t) =>
  withWorkspace(async (ws) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-out-"));
    try {
      if (!makeDirLink(t, outside, path.join(ws.writeRoot, "外链目录"))) return;
      const target = path.join(ws.writeRoot, "外链目录", "新", "a.md");
      const result = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "越界\n" }], true);
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(path.join(outside, "新")), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

test("createParents=true：写入阶段失败时把本次补建的空目录收回", () =>
  withWorkspace(async (ws) => {
    const parent = path.join(ws.writeRoot, "回滚", "深");
    const originalOpen = fsp.open;
    fsp.open = async () => {
      throw new Error("模拟 open 失败");
    };
    try {
      const result = await writeBatch(
        ws.roots,
        [{ kind: "write", path: path.join(parent, "a.md"), content: "甲\n" }],
        true,
      );
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(parent), false);
      assert.equal(fs.existsSync(path.join(ws.writeRoot, "回滚")), false);
    } finally {
      fsp.open = originalOpen;
    }
  }));

test("IPC file:write：只认显式 createParents===true（字符串 \"true\" 不放宽）", () =>
  withWorkspace(async (ws) => {
    const ipc = register();
    const viaTrue = await ipc.invoke("file:write", {
      roots: ws.roots,
      createParents: true,
      ops: [{ kind: "write", path: path.join(ws.writeRoot, "允许", "a.md"), content: "甲\n" }],
    });
    assert.equal(viaTrue.ok, true);
    const viaString = await ipc.invoke("file:write", {
      roots: ws.roots,
      createParents: "true",
      ops: [{ kind: "write", path: path.join(ws.writeRoot, "不允许", "a.md"), content: "乙\n" }],
    });
    assert.equal(viaString.ok, false);
    assert.equal(fs.existsSync(path.join(ws.writeRoot, "不允许")), false);
  }));

/* ────────────────────────────── 默认工作区（file:default-root） ────────────────────────────── */

test("IPC file:default-root 必须同步注册（sendSync 通道用 handle 注册会卡死窗口加载）", async () => {
  const ipc = register({ defaultRootDir: path.join(process.cwd(), "不该建") });
  assert.equal(ipc.isSync("file:default-root"), true, "preload 用 sendSync 问，主进程必须用 ipcMain.on + event.returnValue");
  await assert.rejects(() => ipc.invoke("file:default-root"), /未注册的通道/, "不该同时用 handle 注册（两个监听者会让语义含糊）");
});

test("IPC file:default-root：可信来源下补建默认工作区并返回路径", () =>
  withWorkspace(async (ws) => {
    const dir = path.join(ws.base, "默认工作区", "和鸣");
    const result = await register({ defaultRootDir: dir }).sendSync("file:default-root");
    assert.equal(result.ok, true);
    assert.equal(result.path, dir);
    assert.ok(fs.statSync(dir).isDirectory());
  }));

test("IPC file:default-root：非可信来源被拒绝（fail-closed）", () =>
  withWorkspace(async (ws) => {
    const dir = path.join(ws.base, "不该建");
    const blocked = await register({ defaultRootDir: dir, isTrustedSender: () => false }).sendSync("file:default-root");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "untrusted-sender");
    assert.equal(fs.existsSync(dir), false);
  }));

test("IPC file:default-root：目录已存在时幂等，且忽略渲染层传的路径", () =>
  withWorkspace(async (ws) => {
    const dir = path.join(ws.base, "默认工作区", "和鸣");
    const ipc = register({ defaultRootDir: dir });
    const first = await ipc.sendSync("file:default-root");
    const second = await ipc.sendSync("file:default-root");
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.path, dir);
    // 渲染层传什么都无效：通道只回主进程算好的那一个目录，不能借它探测任意路径
    const spoofed = await ipc.sendSync("file:default-root", { path: path.join(ws.base, "别处") });
    assert.equal(spoofed.path, dir);
    assert.equal(fs.existsSync(path.join(ws.base, "别处")), false);
  }));

test("IPC file:default-root：未配置默认目录时回错误，不抛", () =>
  withWorkspace(async () => {
    const result = await register({}).sendSync("file:default-root");
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  }));

/* ────────────────────────── 读图（file_image / file:image） ────────────────────────── */

/** 四种受支持格式的最小文件头（后面补零到 ≥ 12 字节，够嗅探即可）。 */
const IMAGE_HEADS = {
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  "image/gif": Buffer.from("GIF89a\x00\x00\x00\x00\x00\x00", "latin1"),
  "image/webp": Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "latin1"), Buffer.from([0, 0, 0, 0])]),
};

test("sniffImageMime：按文件头认四种图片，其它一律 null（扩展名不算数）", () => {
  for (const [mime, head] of Object.entries(IMAGE_HEADS)) {
    assert.equal(sniffImageMime(head), mime, mime);
  }
  assert.equal(sniffImageMime(Buffer.from("plain text file")), null);
  assert.equal(sniffImageMime(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d])), null, "PDF 不是图片");
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from("\x89PNG")), null, "太短不算（避免半截头误判）");
});

test("readImage：返回 mime/bytes/base64，且 base64 能还原原始字节", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "截图.png");
    // 故意把 jpeg 存成 .png：扩展名不可信，必须按魔数判
    fs.writeFileSync(file, IMAGE_HEADS["image/jpeg"]);
    const result = await readImage(ws.roots, file);
    assert.equal(result.ok, true);
    assert.equal(result.mime, "image/jpeg");
    assert.equal(result.bytes, IMAGE_HEADS["image/jpeg"].length);
    assert.deepEqual(Buffer.from(result.base64, "base64"), IMAGE_HEADS["image/jpeg"]);
  }));

test("readImage：不是图片时回 unsupported-image，并提示改用 file_read", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "笔记.png");
    fs.writeFileSync(file, "这其实是文本\n");
    const result = await readImage(ws.roots, file);
    assert.equal(result.ok, false);
    assert.equal(result.code, "unsupported-image");
    assert.match(result.error, /PNG \/ JPEG \/ GIF \/ WebP/);
    assert.match(result.error, /file_read/);
  }));

test("readImage：超过单张上限回 too-large（图片上限与文本上限不同）", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "大图.png");
    const buf = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    IMAGE_HEADS["image/png"].copy(buf, 0);
    fs.writeFileSync(file, buf);
    const result = await readImage(ws.roots, file);
    assert.equal(result.ok, false);
    assert.equal(result.code, "too-large");
    assert.match(result.error, new RegExp(String(Math.round(MAX_IMAGE_BYTES / 1024))));
  }));

test("readImage：根外路径、相对路径、NUL 一律拒绝（与 readFile 同一道闸）", () =>
  withWorkspace(async (ws) => {
    const outside = path.join(ws.base, "根外.png");
    fs.writeFileSync(outside, IMAGE_HEADS["image/png"]);
    assert.equal((await readImage(ws.roots, outside)).code, "outside-roots");
    assert.equal((await readImage(ws.roots, "库/截图.png")).code, "invalid-path");
    assert.equal((await readImage(ws.roots, path.join(ws.writeRoot, "a\0.png"))).code, "invalid-path");
  }));

test("readImage：软链指向根外图片时拒绝（不能借链接绕出根）", (t) =>
  withWorkspace(async (ws) => {
    const outside = path.join(ws.base, "根外.png");
    fs.writeFileSync(outside, IMAGE_HEADS["image/png"]);
    const link = path.join(ws.writeRoot, "链接.png");
    try {
      fs.symlinkSync(outside, link, "file");
    } catch {
      t.skip("当前环境不允许建符号链接");
      return;
    }
    const result = await readImage(ws.roots, link);
    assert.equal(result.ok, false);
    assert.equal(result.code, "symlink");
  }));

test("IPC file:image：正常读取；无根回 no-roots；非可信来源回 untrusted-sender", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "图.png");
    fs.writeFileSync(file, IMAGE_HEADS["image/png"]);
    const ok = await register().invoke("file:image", { roots: ws.roots, path: file });
    assert.equal(ok.ok, true);
    assert.equal(ok.mime, "image/png");

    const noRoots = await register().invoke("file:image", { roots: [], path: file });
    assert.equal(noRoots.ok, false);
    assert.equal(noRoots.code, "no-roots");

    const denied = await register({ isTrustedSender: () => false }).invoke("file:image", { roots: ws.roots, path: file });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "untrusted-sender");
  }));

/* ────────────────────── 撤销上一次写入（d.170 · file:undo） ────────────────────── */

/** 建一个和文件系统分开的备份目录（模拟 userData/backups）。 */
function makeBackupDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "heming-backups-"));
  return {
    dir: base,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

test("覆盖已有文件前会留备份；undoWrite 能把旧内容写回去", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "笔记.md");
      fs.writeFileSync(target, "旧内容\n");

      const written = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "新内容\n" }], false, bak.dir);
      assert.equal(written.ok, true);
      assert.equal(fs.readFileSync(target, "utf8"), "新内容\n");
      assert.equal(written.backups.length, 1, "覆盖已有文件应产生一份备份");
      assert.equal(written.backups[0].path, target);

      const undone = await undoWrite(ws.roots, target, bak.dir);
      assert.equal(undone.ok, true);
      assert.equal(fs.readFileSync(target, "utf8"), "旧内容\n", "撤销后必须一字不差还原");
      assert.ok(undone.restoredFrom, "要告诉调用方恢复的是哪一刻的版本");
    } finally {
      bak.cleanup();
    }
  }));

test("新建文件没有旧版本：不产生备份，undo 回 no-backup", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "新文件.md");
      const written = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "第一次\n" }], false, bak.dir);
      assert.equal(written.ok, true);
      assert.equal(written.backups, undefined, "新建文件不该产生备份");

      const undone = await undoWrite(ws.roots, target, bak.dir);
      assert.equal(undone.ok, false);
      assert.equal(undone.code, "no-backup");
      assert.equal(fs.readFileSync(target, "utf8"), "第一次\n", "撤销失败不能动文件");
    } finally {
      bak.cleanup();
    }
  }));

test("删除文件也会先备份；undo 能把被删的文件原样恢复", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "要删的.md");
      fs.writeFileSync(target, "别删我\n");
      const removed = await writeBatch(ws.roots, [{ kind: "delete", path: target }], false, bak.dir);
      assert.equal(removed.ok, true);
      assert.equal(fs.existsSync(target), false);

      const undone = await undoWrite(ws.roots, target, bak.dir);
      assert.equal(undone.ok, true);
      assert.equal(fs.readFileSync(target, "utf8"), "别删我\n");
    } finally {
      bak.cleanup();
    }
  }));

test("一份备份只能用一次：撤销成功后紧接着再撤销回 no-backup（不来回横跳）", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "a.md");
      fs.writeFileSync(target, "v1\n");
      await writeBatch(ws.roots, [{ kind: "write", path: target, content: "v2\n" }], false, bak.dir);
      assert.equal((await undoWrite(ws.roots, target, bak.dir)).ok, true);
      const again = await undoWrite(ws.roots, target, bak.dir);
      assert.equal(again.ok, false);
      assert.equal(again.code, "no-backup");
      assert.equal(fs.readFileSync(target, "utf8"), "v1\n");
    } finally {
      bak.cleanup();
    }
  }));

test("undo 的越界/只读根一律拒绝，且文件保持原样", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const readOnly = path.join(ws.readRoot, "参考.txt");
      fs.writeFileSync(readOnly, "只读\n");
      const ro = await undoWrite(ws.roots, readOnly, bak.dir);
      assert.equal(ro.ok, false);
      assert.equal(ro.code, "outside-roots");

      const outside = path.join(ws.base, "外部.txt");
      const out = await undoWrite(ws.roots, outside, bak.dir);
      assert.equal(out.ok, false);
      assert.equal(out.code, "outside-roots");

      const relative = await undoWrite(ws.roots, "库/a.md", bak.dir);
      assert.equal(relative.ok, false);
      assert.equal(relative.code, "outside-roots");

      const noDir = await undoWrite(ws.roots, path.join(ws.writeRoot, "x.md"), null);
      assert.equal(noDir.ok, false);
      assert.equal(noDir.code, "no-backup-dir");
    } finally {
      bak.cleanup();
    }
  }));

test("每个文件只留最近 MAX_BACKUPS_PER_PATH 份备份（超出丢最旧）", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "count.md");
      fs.writeFileSync(target, "v0\n");
      for (let i = 1; i <= MAX_BACKUPS_PER_PATH + 3; i++) {
        await writeBatch(ws.roots, [{ kind: "write", path: target, content: "v" + i + "\n" }], false, bak.dir);
      }
      const index = await readBackupIndex(bak.dir);
      const key = Object.keys(index)[0];
      assert.equal(index[key].length, MAX_BACKUPS_PER_PATH, "每文件备份数必须被裁剪到上限");
      // 最新的那份是 v12（倒数第二次写入前的内容）
      const undone = await undoWrite(ws.roots, target, bak.dir);
      assert.equal(undone.ok, true);
      assert.equal(fs.readFileSync(target, "utf8"), "v" + (MAX_BACKUPS_PER_PATH + 2) + "\n");
    } finally {
      bak.cleanup();
    }
  }));

test("同一毫秒两次备份各占一个文件，不互相覆盖（撤销能回各自版本）", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    const realNow = Date.now;
    try {
      // 固定时钟重现碰撞窗口：文件名只依赖路径+时间时，两次备份会落到同一个 .bak。
      Date.now = () => 1700000000000;
      const target = path.join(ws.writeRoot, "collision.md");
      const first = await createBackup(bak.dir, target, Buffer.from("VERSION-ONE"));
      const second = await createBackup(bak.dir, target, Buffer.from("VERSION-TWO"));
      assert.ok(first && second, "两次备份都要成功");
      assert.notEqual(first.file, second.file, "同一毫秒的两次备份不能共用一个文件名");
      assert.equal(fs.readFileSync(path.join(bak.dir, first.file), "utf8"), "VERSION-ONE", "第一份备份不能被第二份静默覆盖");
      assert.equal(fs.readFileSync(path.join(bak.dir, second.file), "utf8"), "VERSION-TWO");
    } finally {
      Date.now = realNow;
      bak.cleanup();
    }
  }));

test("备份目录不可写时：写入照常成功，只是没有备份（安全网不能挡住主功能）", () =>
  withWorkspace(async (ws) => {
    const bogus = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "heming-broken-")), "not-a-dir");
    fs.writeFileSync(bogus, "我是一个文件，不是目录");
    try {
      const target = path.join(ws.writeRoot, "b.md");
      fs.writeFileSync(target, "旧\n");
      const written = await writeBatch(ws.roots, [{ kind: "write", path: target, content: "新\n" }], false, bogus);
      assert.equal(written.ok, true);
      assert.equal(fs.readFileSync(target, "utf8"), "新\n");
      assert.equal(written.backups, undefined, "备份失败不该假装备份成功");
    } finally {
      fs.rmSync(path.dirname(bogus), { recursive: true, force: true });
    }
  }));

test("IPC file:undo：正常撤销；无根回 no-roots；非可信来源回 untrusted-sender", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "ipc.md");
      fs.writeFileSync(target, "IPC 旧\n");
      const ipc = fakeIpc();
      registerFileIpc(ipc, { isTrustedSender: () => true, backupDir: bak.dir });
      await ipc.invoke("file:write", { roots: ws.roots, ops: [{ kind: "write", path: target, content: "IPC 新\n" }] });
      const ok = await ipc.invoke("file:undo", { roots: ws.roots, path: target });
      assert.equal(ok.ok, true);
      assert.equal(fs.readFileSync(target, "utf8"), "IPC 旧\n");

      const noRoots = await ipc.invoke("file:undo", { roots: [], path: target });
      assert.equal(noRoots.ok, false);
      assert.equal(noRoots.code, "no-roots");

      const denied = await (async () => {
        const bad = fakeIpc();
        registerFileIpc(bad, { isTrustedSender: () => false, backupDir: bak.dir });
        return bad.invoke("file:undo", { roots: ws.roots, path: target });
      })();
      assert.equal(denied.ok, false);
      assert.equal(denied.code, "untrusted-sender");
    } finally {
      bak.cleanup();
    }
  }));

/* ──────────────── 预览改动（d.207.4.110 · file:backup-preview） ──────────────── */

test("previewBackup：回「改动前」的原文，且只读——不消费备份、不动当前文件", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "preview.md");
      fs.writeFileSync(target, "第一版\nsecond\n");
      await writeBatch(ws.roots, [{ kind: "write", path: target, content: "第二版\nsecond\n" }], false, bak.dir);

      const first = await previewBackup(ws.roots, target, bak.dir);
      assert.equal(first.ok, true);
      assert.equal(first.text, "第一版\nsecond\n", "预览必须回改动前的原文");
      assert.equal(first.bytes, Buffer.byteLength("第一版\nsecond\n"));
      assert.equal(first.truncated, false);
      assert.equal(first.binary, false);
      assert.equal(fs.readFileSync(target, "utf8"), "第二版\nsecond\n", "预览不能改目标文件");

      // 只读语义：连预览两次都在，之后仍然能撤销
      const second = await previewBackup(ws.roots, target, bak.dir);
      assert.equal(second.ok, true);
      const undone = await undoWrite(ws.roots, target, bak.dir);
      assert.equal(undone.ok, true, "预览不该把备份用掉");
      assert.equal(fs.readFileSync(target, "utf8"), "第一版\nsecond\n");
    } finally {
      bak.cleanup();
    }
  }));

test("previewBackup：新建文件没有改动前内容 → no-backup；只读根/根外 → outside-roots", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const fresh = path.join(ws.writeRoot, "brand-new.md");
      await writeBatch(ws.roots, [{ kind: "write", path: fresh, content: "新文件\n" }], false, bak.dir);
      const none = await previewBackup(ws.roots, fresh, bak.dir);
      assert.equal(none.ok, false);
      assert.equal(none.code, "no-backup");
      assert.match(none.error, /没有/);

      const readOnly = path.join(ws.readRoot, "ref.md");
      fs.writeFileSync(readOnly, "参考\n");
      const ro = await previewBackup(ws.roots, readOnly, bak.dir);
      assert.equal(ro.ok, false);
      assert.equal(ro.code, "outside-roots");

      const outside = await previewBackup(ws.roots, path.join(ws.base, "..", "逃出去.md"), bak.dir);
      assert.equal(outside.ok, false);
      assert.equal(outside.code, "outside-roots");
    } finally {
      bak.cleanup();
    }
  }));

test("previewBackup：二进制与超大备份如实标注，不硬凑成文本", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const binPath = path.join(ws.writeRoot, "blob.bin");
      fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
      await writeBatch(ws.roots, [{ kind: "write", path: binPath, content: "文本\n" }], false, bak.dir);
      const bin = await previewBackup(ws.roots, binPath, bak.dir);
      assert.equal(bin.ok, true);
      assert.equal(bin.binary, true, "含 NUL 的备份按二进制处理");
      assert.equal(bin.text, "", "二进制不硬凑文本");

      const bigPath = path.join(ws.writeRoot, "big.txt");
      fs.writeFileSync(bigPath, "x".repeat(400));
      await writeBatch(ws.roots, [{ kind: "write", path: bigPath, content: "y\n" }], false, bak.dir);
      const big = await previewBackup(ws.roots, bigPath, bak.dir, 100);
      assert.equal(big.ok, true);
      assert.equal(big.truncated, true);
      assert.equal(big.text.length, 100, "按 maxBytes 截断");
      assert.equal(big.bytes, 400, "bytes 报真实大小");
    } finally {
      bak.cleanup();
    }
  }));

test("IPC file:backup-preview：正常预览；无根回 no-roots；非可信来源回 untrusted-sender", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "ipc-preview.md");
      fs.writeFileSync(target, "旧内容\n");
      const ipc = fakeIpc();
      registerFileIpc(ipc, { isTrustedSender: () => true, backupDir: bak.dir });
      await ipc.invoke("file:write", { roots: ws.roots, ops: [{ kind: "write", path: target, content: "新内容\n" }] });
      const ok = await ipc.invoke("file:backup-preview", { roots: ws.roots, path: target });
      assert.equal(ok.ok, true);
      assert.equal(ok.text, "旧内容\n");

      const noRoots = await ipc.invoke("file:backup-preview", { roots: [], path: target });
      assert.equal(noRoots.ok, false);
      assert.equal(noRoots.code, "no-roots");

      const bad = fakeIpc();
      registerFileIpc(bad, { isTrustedSender: () => false, backupDir: bak.dir });
      const denied = await bad.invoke("file:backup-preview", { roots: ws.roots, path: target });
      assert.equal(denied.ok, false);
      assert.equal(denied.code, "untrusted-sender");
    } finally {
      bak.cleanup();
    }
  }));

/* ──────────────── 最近改动列表（d.171 · file:backups） ──────────────── */

test("listBackups：只列可写根内的最新一份备份，按时间倒序；只读根里的不列", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const a = path.join(ws.writeRoot, "a.md");
      const b = path.join(ws.writeRoot, "sub", "b.md");
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.writeFileSync(a, "a1");
      fs.writeFileSync(b, "b1");
      await writeBatch(ws.roots, [{ kind: "write", path: a, content: "a2" }], false, bak.dir);
      await new Promise((r) => setTimeout(r, 5));
      await writeBatch(ws.roots, [{ kind: "write", path: b, content: "b2" }], false, bak.dir);

      // 只读根里的文件即使有备份也不该出现在列表里（列出来也点不动）
      const readOnlyFile = path.join(ws.readRoot, "r.md");
      fs.writeFileSync(readOnlyFile, "r1");
      await createBackup(bak.dir, readOnlyFile, Buffer.from("r1"));

      const listed = await listBackups(ws.roots, bak.dir);
      assert.equal(listed.ok, true);
      assert.deepEqual(
        listed.items.map((it) => path.basename(it.path)),
        ["b.md", "a.md"],
        "最新的在最前，且只读根里的被过滤掉",
      );
      assert.ok(listed.items.every((it) => typeof it.at === "string" && it.bytes > 0));
    } finally {
      bak.cleanup();
    }
  }));

test("listBackups：没有备份目录 / 没有可写根时回空列表（不是错误）", () =>
  withWorkspace(async (ws) => {
    const none = await listBackups(ws.roots, null);
    assert.deepEqual(none, { ok: true, items: [] });
    const bak = makeBackupDir();
    try {
      const readOnlyOnly = [{ name: "只读", path: ws.readRoot, mode: "read" }];
      const empty = await listBackups(readOnlyOnly, bak.dir);
      assert.deepEqual(empty, { ok: true, items: [] });
    } finally {
      bak.cleanup();
    }
  }));

test("IPC file:backups：正常列出；无根回 no-roots；非可信来源回 untrusted-sender", () =>
  withWorkspace(async (ws) => {
    const bak = makeBackupDir();
    try {
      const target = path.join(ws.writeRoot, "ipc-list.md");
      fs.writeFileSync(target, "v1");
      const ipc = fakeIpc();
      registerFileIpc(ipc, { isTrustedSender: () => true, backupDir: bak.dir });
      await ipc.invoke("file:write", { roots: ws.roots, ops: [{ kind: "write", path: target, content: "v2" }] });

      const ok = await ipc.invoke("file:backups", { roots: ws.roots });
      assert.equal(ok.ok, true);
      assert.equal(ok.items.length, 1);
      assert.equal(ok.items[0].path, target);

      const noRoots = await ipc.invoke("file:backups", { roots: [] });
      assert.equal(noRoots.ok, false);
      assert.equal(noRoots.code, "no-roots");

      const bad = fakeIpc();
      registerFileIpc(bad, { isTrustedSender: () => false, backupDir: bak.dir });
      const denied = await bad.invoke("file:backups", { roots: ws.roots });
      assert.equal(denied.code, "untrusted-sender");
    } finally {
      bak.cleanup();
    }
  }));

test("GBK 文本：读得到、搜得到，但覆盖写会被拦下（d.229）", async () => {
  const ws = makeWorkspace();
  try {
    // 「中文\n测试\n」的 GBK 字节（936 代码页）——中文 Windows 上这类文件仍然常见
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]);
    const legacy = path.join(ws.writeRoot, "旧.txt");
    fs.writeFileSync(legacy, gbkBytes);

    // 1) 读：不再回「这不是 UTF-8 文本文件」，而是解出来并报出编码
    const read = await readFile(ws.roots, legacy);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.content, "中文\n测试\n");
    assert.equal(read.encoding, "gbk");
    assert.equal(read.bytes, gbkBytes.length);

    // 2) 搜：grep 不再静默跳过 GBK 文件
    const grep = await grepFiles({ roots: ws.roots, dir: ws.writeRoot, pattern: "中文" });
    assert.equal(grep.ok, true, JSON.stringify(grep));
    assert.equal(grep.matches.length, 1);
    assert.equal(grep.matches[0].path.replace(/\\/g, "/"), legacy.replace(/\\/g, "/"));

    // 3) 写：覆盖非 UTF-8 文件必须被拒，且**原文件一个字节都不能变**
    const denied = await writeBatch(ws.roots, [{ kind: "write", path: legacy, content: "新内容" }]);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /不是 UTF-8 编码/);
    assert.deepEqual(fs.readFileSync(legacy), gbkBytes, "被拒之后原文件必须一字未改");

    // 4) UTF-8 目标与新建文件不受影响
    const utf8File = path.join(ws.writeRoot, "新.txt");
    fs.writeFileSync(utf8File, "旧内容", "utf8");
    const overwrite = await writeBatch(ws.roots, [{ kind: "write", path: utf8File, content: "改过了" }]);
    assert.equal(overwrite.ok, true, JSON.stringify(overwrite));
    assert.equal(fs.readFileSync(utf8File, "utf8"), "改过了");
    const created = await writeBatch(ws.roots, [{ kind: "write", path: path.join(ws.writeRoot, "另一个.txt"), content: "x" }]);
    assert.equal(created.ok, true, JSON.stringify(created));
  } finally {
    ws.cleanup();
  }
});

test("GBK 的改动前备份预览也按实际编码解（d.229）", async () => {
  const ws = makeWorkspace();
  const backupDir = path.join(ws.base, "backups");
  try {
    const file = path.join(ws.writeRoot, "报告.bat");
    const gbkBytes = Buffer.from([0xb1, 0xa8, 0xb8, 0xe6, 0x0a]); // 「报告\n」
    fs.writeFileSync(file, gbkBytes);
    const made = await createBackup(backupDir, file, gbkBytes);
    assert.ok(made && made.file, JSON.stringify(made));

    const preview = await previewBackup(ws.roots, file, backupDir);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.text, "报告\n", "预览要解成中文，而不是一片乱码");
    assert.equal(preview.encoding, "gbk");
    assert.equal(preview.binary, false);
  } finally {
    ws.cleanup();
  }
});

test("decodeTextBytes：UTF-8 优先、GBK 兜底、BOM 剥掉、两种都不成立则失败（d.229）", () => {
  assert.deepEqual(decodeTextBytes(Buffer.from("中文 ok", "utf8")), {
    ok: true,
    text: "中文 ok",
    encoding: "utf-8",
  });
  assert.deepEqual(decodeTextBytes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), {
    ok: true,
    text: "中文",
    encoding: "gbk",
  });
  assert.deepEqual(decodeTextBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")])), {
    ok: true,
    text: "x",
    encoding: "utf-8",
  });
  assert.equal(decodeTextBytes(Buffer.from([0xff, 0xfe, 0x80, 0xff])).ok, false);
});

test("grepFiles：搜不了的文件要报出来（d.232 没找到 ≠ 没去找）", () =>
  withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws.writeRoot, "命中.md"), "needle 在这里\n");
    // 2MB+ 的大文件、含 NUL 的二进制、两种编码都不成立的字节：以前一律静默跳过
    fs.writeFileSync(path.join(ws.writeRoot, "巨大.log"), "x".repeat(MAX_FILE_BYTES + 10));
    fs.writeFileSync(
      path.join(ws.writeRoot, "图片.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    );
    fs.writeFileSync(path.join(ws.writeRoot, "坏编码.bin"), Buffer.from([0x81, 0x20, 0xff]));

    const found = await grepFiles({ roots: ws.roots, pattern: "needle", dir: ws.writeRoot });
    assert.equal(found.ok, true);
    assert.equal(found.matches.length, 1);
    assert.equal(found.skippedFiles.total, 3);
    assert.equal(found.skippedFiles.tooLarge, 1);
    assert.equal(found.skippedFiles.binary, 1);
    assert.equal(found.skippedFiles.undecodable, 1);
    assert.deepEqual([...found.skippedFiles.sample].sort(), ["图片.png", "坏编码.bin", "巨大.log"].sort());

    // 全都搜得到的时候不报（不能编出一条「另有 0 个」）
    fs.writeFileSync(path.join(ws.readRoot, "干净.md"), "needle\n");
    const clean = await grepFiles({ roots: ws.roots, pattern: "needle", dir: ws.readRoot });
    assert.equal(clean.ok, true);
    assert.equal(clean.skippedFiles, null);
  }));


/* ────────────────────────────── revealFile（d.234 在文件夹里显示） ────────────────────────────── */

function fakeShell() {
  const calls = [];
  return {
    calls,
    showItemInFolder(target) {
      calls.push(["showItemInFolder", target]);
    },
    async openPath(target) {
      calls.push(["openPath", target]);
      return "";
    },
  };
}

test("revealFile：文件走「选中它」，目录走「打开它」", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "a.md");
    fs.writeFileSync(file, "a");
    const shell = fakeShell();
    const revealed = await revealFile(ws.roots, file, shell);
    assert.equal(revealed.ok, true);
    assert.equal(revealed.kind, "file");

    const dir = path.join(ws.writeRoot, "子目录");
    fs.mkdirSync(dir, { recursive: true });
    const opened = await revealFile(ws.roots, dir, shell);
    assert.equal(opened.ok, true);
    assert.equal(opened.kind, "directory");

    assert.deepEqual(shell.calls, [
      ["showItemInFolder", file],
      ["openPath", dir],
    ]);
  }));

test("revealFile：根外路径不放行，什么都不弹", () =>
  withWorkspace(async (ws) => {
    const shell = fakeShell();
    const outside = path.join(ws.base, "别人.md");
    fs.writeFileSync(outside, "x");
    const res = await revealFile(ws.roots, outside, shell);
    assert.equal(res.ok, false);
    assert.equal(res.code, "outside-roots");
    assert.deepEqual(shell.calls, []);
  }));

test("revealFile：文件不在了说「找不到」，不弹空文件夹", () =>
  withWorkspace(async (ws) => {
    const shell = fakeShell();
    const gone = path.join(ws.writeRoot, "没了.md");
    const res = await revealFile(ws.roots, gone, shell);
    assert.equal(res.ok, false);
    assert.equal(res.code, "not-found");
    assert.match(res.error, /找不到/);
    assert.deepEqual(shell.calls, []);
  }));

test("revealFile：没有 shell 时结构化失败（老环境不崩）", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "b.md");
    fs.writeFileSync(file, "b");
    const res = await revealFile(ws.roots, file, null);
    assert.equal(res.ok, false);
    assert.equal(res.code, "unsupported");
  }));

test("IPC file:reveal：正常定位；非可信来源被拒（fail-closed）", () =>
  withWorkspace(async (ws) => {
    const file = path.join(ws.writeRoot, "c.md");
    fs.writeFileSync(file, "c");
    const shell = fakeShell();
    const ipc = register({ shell });
    const ok = await ipc.invoke("file:reveal", { roots: ws.roots, path: file });
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, "file");
    assert.deepEqual(shell.calls, [["showItemInFolder", file]]);

    const blocked = await register({ shell, isTrustedSender: () => false }).invoke("file:reveal", {
      roots: ws.roots,
      path: file,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "untrusted-sender");
  }));
