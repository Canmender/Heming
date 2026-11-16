"use strict";
// 桌面桥冒烟（d.166）：在**真实 Electron 渲染进程**里走一遍 preload → IPC → file-fs / shell-run，
// 补上「单测覆盖不到、又最容易在真实环境翻车」的那一段：
//
//   1. preload 真的把 __heming_files / __heming_shell 暴露到了渲染世界（contextBridge 生效）；
//   2. preload 里那些 sendSync 询问（file:default-root / secret:*）真的有同步监听者——
//      打空通道会让渲染进程永远等不到返回，**整个窗口加载不出来**（本轮就是这么抓到 d.162 的 bug）；
//   3. IPC 的 isTrustedSender 真的认主窗口、非主窗口的调用真的被拒；
//   4. 文件桥能建目录、写、读、glob、grep，越界与相对路径被主进程拒绝；
//   5. 命令桥能真的起一个进程并把 stdout 带回来（`node -e "console.log(...)"` 正好压 cmd.exe 的引号问题）；
//   6. **真实整页**（d.166）：用安装包同样的 `app://` 协议服务 `web-dist` 产物、开一个带真 preload 的窗口
//      加载 `app://heming/`，断言「页面真的起来了（React 挂到 #root）、桥在真源上可用、能在真源上写读文件」。
//      前五类是「桥本身」，第 6 类是「桥装进真实页面之后还通不通」——CSP、协议注册时机、产物形状
//      任何一处错，用户看到的就是白屏。
//
// 为什么不并进 `npm test`：要起 Electron（约 5–10 秒），且依赖当前机器有可用窗口系统；
// 单测守逻辑，这里守「链路真的通」。用 `pnpm --filter @heming/desktop smoke` 手动跑。
const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const fss = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { registerFileIpc } = require("../file-fs.js");
const { registerShellIpc } = require("../shell-run.js");
const { contentTypeFor, resolveRequest, INDEX_FILE, cspHeadersFor, DEFAULT_API_ORIGIN } = require("../app-protocol.js");

// 与 main.js 同口径：自定义协议必须在 app ready **之前**注册成 privileged，
// 否则页面拿不到 secure 语义（fetch / localStorage / service worker 全受限）。
const EMBEDDED_SCHEME = "app";
const SMOKE_ORIGIN = `${EMBEDDED_SCHEME}://heming`;
// d.168：同一进程里 `protocol.handle` 不能对同一个 scheme 重复注册（会抛
// 「Failed to register protocol」），而我们要在「enforce」和「report」两档下各起一次整页。
// 于是再注册一个同样 privileged 的 scheme，只用于 report 档那一次加载——
// 两档共用同一份产物与同一套 cspHeadersFor，差别只在响应头。
const REPORT_SCHEME = "app-report";
const REPORT_ORIGIN = `${REPORT_SCHEME}://heming`;
const PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true };
protocol.registerSchemesAsPrivileged([
  { scheme: EMBEDDED_SCHEME, privileges: PRIVILEGES },
  { scheme: REPORT_SCHEME, privileges: PRIVILEGES },
]);

const ROOT = path.join(os.tmpdir(), `heming-smoke-${process.pid}`);
const ROOT_POSIX = ROOT.replace(/\\/g, "/"); // 渲染层里一律用正斜杠绝对路径
const APP_VERSION = "d.165.4.96.11";
const TIMEOUT_MS = 45_000;

const log = (...args) => console.log("[smoke]", ...args);

function fail(message) {
  console.error(`[smoke] 失败：${message}`);
  process.exitCode = 1;
  app.exit(1);
}

function rendererScript() {
  // 注意：这里是拼进渲染进程执行的一段 IIFE，所以不能直接引用 Node 侧变量，
  // 需要用 JSON.stringify 预先烤进字面量（含反斜杠转义）。
  const root = JSON.stringify(ROOT_POSIX);
  const roots = JSON.stringify([{ name: "冒烟根", path: ROOT, mode: "write" }]);
  return `(async () => {
    const out = { checks: [] };
    const files = window.__heming_files;
    const shell = window.__heming_shell;
    out.hasFiles = Boolean(files && typeof files.write === "function" && typeof files.read === "function");
    out.hasShell = Boolean(shell && typeof shell.run === "function");
    out.defaultRootPath = files ? files.defaultRootPath : null;
    const roots = ${roots};
    // 桌面桥只收**绝对路径**：相对路径的解析在 web 侧 toolOps 里做（那边知道根）。
    const abs = (rel) => ${root} + "/" + rel;

    out.write = await files.write({ roots, ops: [{ kind: "write", path: abs("notes/a.md"), content: "# smoke\\n\\n第二行\\n" }], createParents: true });
    out.read = await files.read({ roots, path: abs("notes/a.md") });
    out.glob = typeof files.glob === "function" ? await files.glob({ roots, pattern: "**/*.md", dir: ${root} }) : { ok: false, code: "missing" };
    out.grep = typeof files.grep === "function" ? await files.grep({ roots, pattern: "第二行", dir: ${root} }) : { ok: false, code: "missing" };
    out.escape = await files.write({ roots, ops: [{ kind: "write", path: abs("../escape.txt"), content: "x" }] });
    out.relative = await files.read({ roots, path: "notes/a.md" });
    out.cmd = await shell.run({ runId: "smoke-1", roots, command: 'node -e "console.log(6*7)"', cwd: ${root}, timeoutMs: 20000 });
    out.image = typeof files.image === "function" ? await files.image({ roots, path: abs("截图/像素.png") }) : { ok: false, code: "missing" };
    out.imageFake = typeof files.image === "function" ? await files.image({ roots, path: abs("截图/其实是文本.png") }) : { ok: false, code: "missing" };
    out.imageOutside = typeof files.image === "function" ? await files.image({ roots, path: abs("../根外.png") }) : { ok: false, code: "missing" };
    // 撤销（d.170）：先覆盖成第二版，再 undo，读回必须是第一版
    out.write2 = await files.write({ roots, ops: [{ kind: "write", path: abs("notes/a.md"), content: "# smoke 第二版（无换行）" }] });
    // 最近改动列表（d.171）：覆盖之后先列一次（应能看到 notes/a.md），撤销之后应该没有这条了
    out.listBefore = typeof files.backups === "function" ? await files.backups({ roots }) : { ok: false, code: "missing" };
    out.undo = typeof files.undo === "function" ? await files.undo({ roots, path: abs("notes/a.md") }) : { ok: false, code: "missing" };
    out.afterUndo = await files.read({ roots, path: abs("notes/a.md") });
    out.undoAgain = typeof files.undo === "function" ? await files.undo({ roots, path: abs("notes/a.md") }) : { ok: false, code: "missing" };
    out.undoOutside = typeof files.undo === "function" ? await files.undo({ roots, path: abs("../根外.md") }) : { ok: false, code: "missing" };
    out.listAfter = typeof files.backups === "function" ? await files.backups({ roots }) : { ok: false, code: "missing" };
    out.listUntrusted = null;
    // 后台作业（d.180）：起一条 1.5 秒后输出、约 2 秒结束的命令，轮询到它结束；
    // 再起一条 10 秒的命令立刻杀掉——两条路径合起来才证明「能等」和「能停」。
    out.jobStart = await shell.run({ runId: "smoke-job-1", roots, command: "node slow.js", cwd: ${root}, background: true });
    if (out.jobStart && out.jobStart.jobId) {
      out.jobFirst = await shell.jobOutput({ jobId: out.jobStart.jobId, waitMs: 0 });
      out.jobWaited = await shell.jobOutput({ jobId: out.jobStart.jobId, waitMs: 20000 });
      out.jobList = await shell.jobs();
    }
    out.jobKillStart = await shell.run({ runId: "smoke-job-2", roots, command: "node hang.js", cwd: ${root}, background: true });
    if (out.jobKillStart && out.jobKillStart.jobId) {
      out.jobKill = await shell.jobKill({ jobId: out.jobKillStart.jobId });
      await new Promise((r) => setTimeout(r, 800));
      out.jobKilled = await shell.jobOutput({ jobId: out.jobKillStart.jobId, waitMs: 5000 });
      out.jobUnknown = await shell.jobOutput({ jobId: "no-such-job", waitMs: 0 });
    }
    out.cmdOutside = await shell.run({ runId: "smoke-2", roots, command: "echo hi", cwd: "C:/Windows", timeoutMs: 20000 });
    return out;
  })()`;
}

/** 嵌入产物目录：优先 `desktop/web-dist`（构建产物，与安装包同源），回退 `web/dist`（开发态）。都没有 → null。 */
function webDistRoot() {
  const candidates = [path.join(__dirname, "..", "web-dist"), path.join(__dirname, "..", "..", "web", "dist")];
  for (const dir of candidates) {
    try {
      if (fss.existsSync(path.join(dir, INDEX_FILE))) return dir;
    } catch {
      /* 目录不可读就当没有 */
    }
  }
  return null;
}

/**
 * 用与安装包相同的 `app://` 协议服务产物。
 *
 * d.167：这里现在**挂上与生产同一条 CSP**（enforce 档，比默认 report-only 更严），
 * 因为「页面在真实策略下还能不能起来」正是最容易白屏的一环：
 * `script-src` 一旦挡住 index.html 里的内联脚本或某个 wasm 资源，用户看到的就是白屏，
 * 而 report-only 只记录不拦、单测也只测头字符串。冒烟同时把响应头与「页内是否出现
 * CSP 拒绝」都抓下来断言。
 *
 * d.168：再补一次 **report 档**（生产的默认档）。两档的差别恰好是两面：
 * enforce 会拦（脚本不执行），report 只记录（脚本照跑、但违例要进日志）。
 * 只测 enforce 会漏掉「默认档悄悄变成 enforce → 用户白屏」这种事故。
 */
function installSmokeProtocol(rootDir, options = {}) {
  const scheme = options.scheme || EMBEDDED_SCHEME;
  const mode = options.mode || "enforce";
  const record = typeof options.record === "function" ? options.record : () => undefined;
  protocol.handle(scheme, async (request) => {
    let urlPath = "/";
    try {
      urlPath = new URL(request.url).pathname;
    } catch {
      return new Response("bad request", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const resolved = resolveRequest(urlPath, rootDir, (file) => {
      try {
        return fss.existsSync(file);
      } catch {
        return false;
      }
    });
    const cspHeaders = cspHeadersFor(urlPath, { mode, apiOrigin: DEFAULT_API_ORIGIN });
    if (resolved && urlPath === "/") record(cspHeaders);
    if (!resolved) {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...cspHeaders },
      });
    }
    try {
      const body = await fs.readFile(resolved.file);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentTypeFor(resolved.file),
          "Cache-Control": resolved.spaFallback ? "no-store" : "public, max-age=31536000, immutable",
          ...cspHeaders,
        },
      });
    } catch {
      return new Response("read failed", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...cspHeaders },
      });
    }
  });
}

let cspHeaderSeen = null;
let cspHeaderCalls = 0;
function recordCspHeader(headers) {
  if (cspHeaderCalls === 0) cspHeaderSeen = headers;
  cspHeaderCalls += 1;
}

// report 档的响应头单独记（两档各自要断言，不能用同一个变量互相覆盖）
let reportCspHeaderSeen = null;
let reportCspHeaderCalls = 0;
function recordReportCspHeader(headers) {
  if (reportCspHeaderCalls === 0) reportCspHeaderSeen = headers;
  reportCspHeaderCalls += 1;
}

/** 往某个窗口里插一段内联脚本，返回它有没有真的执行（CSP 决定拦还是不拦）。 */
function injectInlineVia(webContents) {
  return webContents
    .executeJavaScript(
      `(() => {
        const marker = "__smokeCspRan_" + Math.random().toString(36).slice(2, 8);
        window.__smokeCspMarker = marker;
        const el = document.createElement("script");
        el.textContent = "window[" + JSON.stringify(marker) + "] = 1;";
        document.head.appendChild(el);
        return { ran: window[marker] === 1 };
      })()`,
      true,
    )
    .catch((error) => ({ error: String(error) }));
}

/**
 * 子资源探针（d.172）：`connect-src` / `img-src` 被挡时页面**看起来是好的**——
 * 只有请求失败、图片空着，用户会以为「后端挂了」。冒烟此前只验 `script-src`（内联脚本），
 * 而这两条恰恰是最容易被误诊的失败形态，所以要在真机里各造一次违例。
 */
function probeSubresources(webContents) {
  return webContents
    .executeJavaScript(
      `(async () => {
        const out = {};
        // connect-src：策略放行 'self' / app: / API 域 / **所有 https:** / wss: / 回环。
        // 注意 https: 是故意全放行的（用户自建 https 代理、MCP 网关都要用），
        // 所以能造出违例的只有「http 的非回环地址」——这也是这条策略真正的边界。
        // 用 XHR 而不是 fetch：Chromium 对 XHR 的 CSP 拒绝一定带 "Refused to connect" 控制台消息，
        // 而 fetch 在网络层先失败时，控制台里不一定有可解析的违例行（冒烟实测过）。
        out.xhrBlocked = await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", "http://blocked.invalid/api");
          xhr.onload = () => resolve(false);
          xhr.onerror = () => resolve(true);
          xhr.send();
          setTimeout(() => resolve(xhr.status === 0), 1500);
        });
        try {
          await fetch("http://blocked.invalid/api");
          out.fetchBlocked = false;
        } catch {
          out.fetchBlocked = true;
        }
        // img-src：策略只放行 'self' / app: / data: / blob:
        out.imgBlocked = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(false);
          img.onerror = () => resolve(true);
          img.src = "https://blocked.invalid/x.png";
          setTimeout(() => resolve(img.naturalWidth === 0), 1500);
        });
        // 对照：data: 图片必须能加载（证明 img-src 不是把图片全挡了）
        out.dataImgOk = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
          setTimeout(() => resolve(false), 1500);
        });
        return out;
      })()`,
      true,
    )
    .catch((error) => ({ error: String(error) }));
}

/**
 * 等一个文件出现并读到内容（违例上报走的是「渲染进程 console → 主进程 → 磁盘」，
 * 中间有 IPC 与异步写，不能读一次就断定「没写」）。
 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = fss.readFileSync(file, "utf8");
      if (text.trim().length > 0) return text;
    } catch {
      /* 还没写出来 */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 等日志里出现某条违例（waitForFile 只要文件非空就返回，会读到上一次的内容）。
 *
 * connect-src 的违例在主进程里是异步解析+写入的，而图片探针自带 1.5s 超时——
 * 先把 connect 那条等出来，再统一断言，否则只会读到旧的 script-src 行。
 */
async function waitForText(file, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = fss.readFileSync(file, "utf8");
      if (pattern.test(text)) return text;
    } catch {
      /* 还没写出来 */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 在真实页面里跑的探针：React 是否挂载、桥是否可用、能否在真源上写读文件。 */
function pageProbeScript() {
  const root = JSON.stringify(ROOT_POSIX);
  const roots = JSON.stringify([{ name: "冒烟根", path: ROOT, mode: "write" }]);
  return `(async () => {
    const out = {};
    const files = window.__heming_files;
    const shell = window.__heming_shell;
    const rootEl = document.getElementById("root");
    out.rootChildren = rootEl ? rootEl.children.length : -1;
    out.title = document.title;
    out.hasFiles = Boolean(files && typeof files.write === "function" && typeof files.read === "function");
    out.hasShell = Boolean(shell && typeof shell.run === "function");
    out.origin = location.origin;
    const roots = ${roots};
    if (out.hasFiles) {
      const abs = ${root} + "/page/from-real-page.md";
      out.write = await files.write({ roots, ops: [{ kind: "write", path: abs, content: "# 来自真实页面\\n" }], createParents: true });
      out.read = await files.read({ roots, path: abs });
    }
    return out;
  })()`;
}

async function run() {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(path.join(ROOT, "seed.txt"), "hello seed\n", "utf8");
  // 后台作业（d.180）要一条「会跑一会儿」的命令：写成脚本文件，命令里就没有引号，
  // 免得在模板字面量里再嵌一层引号转义（那层转义最容易写错、也最难看出错在哪）。
  await fs.writeFile(path.join(ROOT, "slow.js"), 'setTimeout(() => console.log("bg-ok"), 1500);\n', "utf8");
  await fs.writeFile(path.join(ROOT, "hang.js"), 'setTimeout(() => {}, 10000);\n', "utf8");
  // 读图（d.168）：渲染层写不了二进制，所以由主进程种一张真 PNG 进根目录。
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  await fs.mkdir(path.join(ROOT, "截图"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "截图", "像素.png"), pngBytes);
  await fs.writeFile(path.join(ROOT, "截图", "其实是文本.png"), "这不是图片\n", "utf8");

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 诊断面：preload 抛错要看得见，否则冒烟只会说「超时」。
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[smoke] PRELOAD_ERROR", preloadPath, error && error.stack ? error.stack : String(error));
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("[smoke] DID_FAIL_LOAD", code, description, url);
  });

  // 真实整页窗口也要算可信来源，否则它自己调文件桥会被 fail-closed 拒掉。
  const trustedWindows = new Set([win]);
  const isTrustedSender = (event) => trustedWindows.has(BrowserWindow.fromWebContents(event.sender));

  // preload 在**加载时**用 sendSync 问这几件事，主进程必须有同步监听者（ipcMain.on + event.returnValue）。
  // 真实应用里 app:version / secret:* 由主进程注册；这里照实给桩，因为冒烟不测那几块。
  ipcMain.on("app:version", (event) => {
    event.returnValue = APP_VERSION;
  });
  ipcMain.on("secret:capabilities", (event) => {
    event.returnValue = { mode: null, sync: false, async: false };
  });
  ipcMain.on("secret:available", (event) => {
    event.returnValue = false;
  });

  registerFileIpc(ipcMain, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => win,
    defaultRootDir: ROOT,
    // 撤销（d.170）要读备份：冒烟也用真实备份目录，才能验证「写两次再撤销」整链
    backupDir: path.join(ROOT, "..", "heming-smoke-backups-" + process.pid),
    isTrustedSender,
  });
  registerShellIpc(ipcMain, { isTrustedSender });

  // 用 data: 页面而不是 file:：冒烟要的是「真实渲染进程 + 真实 preload」，不需要真实站点源。
  const pageUrl = "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><meta charset=\"utf-8\"><p>heming desktop bridge smoke</p>");
  await win.loadURL(pageUrl);
  const result = await win.webContents.executeJavaScript(rendererScript());

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  };

  check("preload 暴露 __heming_files", result.hasFiles);
  check("preload 暴露 __heming_shell", result.hasShell);
  check("file:default-root 同步下发（sendSync 有监听者）", result.defaultRootPath === ROOT, result.defaultRootPath);
  check("文件写入成功", result.write && result.write.ok === true && (result.write.written ?? 1) === 1, result.write);
  check("文件读取回原内容", result.read && result.read.ok === true && result.read.content.includes("第二行"), result.read && result.read.ok ? `${result.read.bytes} 字节` : result.read);
  check(
    "glob 命中刚写的文件",
    result.glob && result.glob.ok === true && (result.glob.paths || []).some((p) => p.replace(/\\/g, "/").endsWith("notes/a.md")),
    result.glob,
  );
  check("grep 命中中文内容", result.grep && result.grep.ok === true && (result.grep.matches || []).length >= 1, result.grep);
  check("越界写入被主进程拒绝", result.escape && result.escape.ok === false, result.escape);
  check("相对路径被主进程拒绝", result.relative && result.relative.ok === false && result.relative.code === "invalid-path", result.relative);
  check(
    "命令真的执行且 stdout 回来（引号未被 cmd.exe 吃掉）",
    result.cmd && result.cmd.ok === true && String(result.cmd.stdout).trim() === "42",
    result.cmd && result.cmd.ok ? { exitCode: result.cmd.exitCode, stdout: result.cmd.stdout } : result.cmd,
  );
  check(
    "读图：真 PNG 读成 base64（按魔数判类型，不看扩展名）",
    result.image && result.image.ok === true && result.image.mime === "image/png" &&
      Buffer.from(result.image.base64, "base64").subarray(0, 4).toString("hex") === "89504e47",
    result.image && result.image.ok ? { mime: result.image.mime, bytes: result.image.bytes } : result.image,
  );
  check(
    "读图：伪装成 .png 的文本被判 unsupported-image",
    result.imageFake && result.imageFake.ok === false && result.imageFake.code === "unsupported-image",
    result.imageFake,
  );
  check("读图：根外图片被主进程拒绝", result.imageOutside && result.imageOutside.ok === false, result.imageOutside);
  check("撤销：写第二版后 file:undo 成功（有备份）", result.undo && result.undo.ok === true, result.undo);
  check(
    "撤销后读回的是第一版内容",
    result.afterUndo && result.afterUndo.ok === true && result.afterUndo.content.includes("第二行"),
    result.afterUndo && result.afterUndo.ok ? result.afterUndo.content.slice(0, 40) : result.afterUndo,
  );
  const listedBefore = result.listBefore && result.listBefore.ok === true ? result.listBefore.items : [];
  check(
    "最近改动列表：能列出刚被覆盖的文件（设置区列表的数据源）",
    listedBefore.some((it) => String(it.path).replace(/\\/g, "/").endsWith("notes/a.md")),
    listedBefore.slice(0, 3),
  );
  const listedAfter = result.listAfter && result.listAfter.ok === true ? result.listAfter.items : [];
  check(
    "最近改动列表：撤销后那条备份消失（一份只能用一次，列表不能留点不动的行）",
    !listedAfter.some((it) => String(it.path).replace(/\\/g, "/").endsWith("notes/a.md")),
    listedAfter.slice(0, 3),
  );
  check("同一份备份只能用一次：再撤销回 no-backup", result.undoAgain && result.undoAgain.ok === false && result.undoAgain.code === "no-backup", result.undoAgain);
  check("撤销：根外路径被主进程拒绝", result.undoOutside && result.undoOutside.ok === false, result.undoOutside);
  check("越界工作目录被主进程拒绝", result.cmdOutside && result.cmdOutside.ok === false, result.cmdOutside);
  check(
    "后台作业：启动立即返回 jobId（不阻塞回合）",
    result.jobStart && result.jobStart.ok === true && typeof result.jobStart.jobId === "string",
    result.jobStart,
  );
  check(
    "后台作业：轮询能等到输出并看到进程结束",
    result.jobWaited && result.jobWaited.ok === true && result.jobWaited.running === false && String(result.jobWaited.stdout || "").includes("bg-ok"),
    result.jobWaited && result.jobWaited.ok ? { running: result.jobWaited.running, out: String(result.jobWaited.stdout || "").slice(0, 80) } : result.jobWaited,
  );
  check("后台作业：waitMs 0 的首次读取立即返回", result.jobFirst && result.jobFirst.ok === true, result.jobFirst);
  check(
    "后台作业：列表里能查到刚起的作业",
    result.jobList && result.jobList.ok === true && (result.jobList.jobs || []).some((j) => j.id === result.jobStart.jobId),
    result.jobList && result.jobList.ok ? (result.jobList.jobs || []).length : result.jobList,
  );
  check("后台作业：能杀掉还在跑的命令", result.jobKill && result.jobKill.ok === true && result.jobKill.alreadyFinished === false, result.jobKill);
  check("后台作业：杀完之后状态不再是运行中", result.jobKilled && result.jobKilled.ok === true && result.jobKilled.running === false, result.jobKilled);
  check(
    "后台作业：未知作业 id 回 unknown-job",
    result.jobUnknown && result.jobUnknown.ok === false && result.jobUnknown.code === "unknown-job",
    result.jobUnknown,
  );

  // 磁盘上的事实：真的写了文件（不是只在内存里说成功）
  const onDisk = await fs.readFile(path.join(ROOT, "notes", "a.md"), "utf8").catch(() => null);
  check("磁盘上确实有 notes/a.md", onDisk !== null && onDisk.includes("第二行"), onDisk === null ? null : `${onDisk.length} 字符`);

  // 不可信来源：另开一个 Node 化的窗口直接 invoke，也必须被拒（fail-closed 的端到端面）
  const stranger = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await stranger.loadURL(pageUrl);
  const strangerResult = await stranger.webContents.executeJavaScript(
    `(async () => {
      const { ipcRenderer } = require("electron");
      return ipcRenderer.invoke("file:write", { roots: ${JSON.stringify([{ name: "冒烟根", path: ROOT, mode: "write" }])}, ops: [{ kind: "write", path: ${JSON.stringify(`${ROOT_POSIX}/evil.txt`)}, content: "x" }] });
    })()`,
  );
  check("非主窗口调用被拒", strangerResult && strangerResult.ok === false, strangerResult);
  stranger.destroy();

  // ── 6. 真实整页（d.166）：app:// 服务 web-dist，带真 preload 加载，断言页面真的起来了 ──
  let skipped = 0;
  const skip = (name, detail) => {
    skipped += 1;
    log(`skip ${name} → ${JSON.stringify(detail)}`);
  };
  const distRoot = webDistRoot();
  if (!distRoot) {
    skip("真实整页（没有可用的 web-dist 产物）", "先跑 pnpm --filter @heming/desktop build:web");
  } else {
    installSmokeProtocol(distRoot, { mode: "enforce", record: recordCspHeader });
    const page = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    trustedWindows.add(page);
    const pageErrors = [];
    // CSP 违约在渲染进程里以 console 错误出现（enforce 档是「Refused to …」，report-only 是「[Report Only]」）。
    // 主进程侧统一收，不往生产 preload 里塞冒烟专用代码。
    const cspViolations = [];
    page.webContents.on("console-message", (_event, level, message) => {
      const text = typeof level === "object" && level !== null ? JSON.stringify(level) : String(message ?? "");
      if (/content security policy|refused to (load|execute|apply|connect|frame)/i.test(text)) cspViolations.push(text);
    });
    page.webContents.on("preload-error", (_event, preloadPath, error) => {
      pageErrors.push(`preload ${preloadPath}: ${error && error.message ? error.message : String(error)}`);
    });
    page.webContents.on("did-fail-load", (_event, code, description) => {
      pageErrors.push(`did-fail-load ${code} ${description}`);
    });
    page.webContents.on("render-process-gone", (_event, details) => {
      pageErrors.push(`render-process-gone ${details.reason}`);
    });

    let loaded = true;
    try {
      await page.loadURL(`${SMOKE_ORIGIN}/`);
    } catch (error) {
      loaded = false;
      pageErrors.push(`loadURL: ${error && error.message ? error.message : String(error)}`);
    }
    check("真实整页 app://heming 加载成功", loaded && pageErrors.length === 0, {
      dist: path.basename(distRoot),
      pageErrors,
    });

    // 给 React 首帧与 bootstrap 一点时间（真实产物里还有异步初始化）
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const probe = loaded
      ? await page.webContents.executeJavaScript(pageProbeScript()).catch((error) => ({ error: String(error) }))
      : { error: "not loaded" };
    check("真实整页 React 已挂载（#root 有内容）", probe.rootChildren > 0, {
      rootChildren: probe.rootChildren,
      title: probe.title,
      error: probe.error,
    });
    check(
      "真实整页里 preload 桥可用（真源上 __heming_files / __heming_shell）",
      probe.hasFiles === true && probe.hasShell === true,
      { origin: probe.origin, hasFiles: probe.hasFiles, hasShell: probe.hasShell },
    );
    check(
      "真实整页能在真源上写并读回文件",
      Boolean(probe.write && probe.write.ok === true && probe.read && probe.read.ok === true && String(probe.read.content).includes("来自真实页面")),
      probe.write && probe.write.ok ? { bytes: probe.read && probe.read.bytes } : probe,
    );

    // ── CSP：头要对，页面在 enforce 档下也要起得来 ──
    const policy = cspHeaderSeen && cspHeaderSeen["Content-Security-Policy"];
    const scriptSrc = typeof policy === "string" ? (policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src")) || "") : "";
    check(
      "app:// 首页响应带 enforce CSP 头（script-src 不放 unsafe-inline/unsafe-eval）",
      Boolean(
        typeof policy === "string" &&
          policy.length > 0 &&
          cspHeaderSeen["Content-Security-Policy-Report-Only"] === undefined &&
          scriptSrc.includes("'wasm-unsafe-eval'") &&
          !scriptSrc.includes("'unsafe-inline'") &&
          !scriptSrc.includes("'unsafe-eval'") &&
          policy.includes("object-src 'none'"),
      ),
      { scriptSrc, hasPolicy: typeof policy === "string", bytes: typeof policy === "string" ? policy.length : 0 },
    );
    check("真实整页在 enforce CSP 下没有触发拒绝（没有脚本/资源被挡）", cspViolations.length === 0, cspViolations.slice(0, 5));

    // ── 7. CSP 违例上报（d.167）：真实 Chromium 违例 → 主进程解析 → 本机日志 ──
    //
    // 这一段此前只有实现、没有测试：parseCspViolation 认得真实消息吗？去重生效吗？
    // 日志里会不会把页面内容也写进去？用真机造一次违例，比读代码可信。
    const { createCspReporter, attachCspReporter } = require("../csp-report.js");
    const reportFile = path.join(ROOT, "logs", "csp-report.log");
    const reporter = createCspReporter({ file: reportFile });
    attachCspReporter(page.webContents, reporter);

    const injectInline = () => injectInlineVia(page.webContents);

    const first = await injectInline();
    const reportText = await waitForFile(reportFile, 3000);
    check(
      "真实 Chromium 违例进了 csp-report.log（directive=script-src / blocked=inline）",
      Boolean(reportText && /directive=script-src/.test(reportText) && /blocked=inline/.test(reportText)),
      reportText === null ? "文件 3s 内没出现" : reportText.trim().slice(0, 200),
    );
    check("内联脚本被 enforce 真的拦住（window 标记没被写下）", first.ran === false, first);
    check(
      "日志只写元数据，不回显页面内容",
      Boolean(reportText && !reportText.includes("<script") && !reportText.includes("__smokeCspRan")),
      reportText === null ? null : reportText.trim().slice(0, 200),
    );

    await injectInline();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lineCount = reportText === null ? 0 : fss.readFileSync(reportFile, "utf8").trimEnd().split("\n").length;
    check("同一种违例只记一次（去重表生效）", lineCount === 1, { lineCount, seen: reporter.seenCount });
    // ── 7.5 子资源违例（d.172）：connect-src / img-src 被挡时页面看起来是好的 ──
    //
    // script-src 被挡会白屏（很明显），connect-src 被挡只是「请求失败」，img-src 被挡只是
    // 「图空着」——用户会以为是后端或网络的问题。所以这两条也要在真机里各造一次违例：
    // 既确认策略真的在拦，也确认拦下来之后违例照样进日志。
    const sub = await probeSubresources(page.webContents);
    // connect-src / img-src 两条要分别等：前者几乎立刻到，后者要等图片探针超时
    await waitForText(reportFile, /directive=connect-src/, 3000);
    const subText = await waitForText(reportFile, /directive=img-src/, 3000);
    check("connect-src：第三方请求被策略挡住（fetch 抛错）", sub.fetchBlocked === true, sub);
    check("connect-src：XHR 同样被挡住（status 为 0）", sub.xhrBlocked === true, sub);
    check("img-src：第三方图片被策略挡住（naturalWidth 为 0）", sub.imgBlocked === true, sub);
    check("img-src：data: 图片照常加载（不是把图全挡了）", sub.dataImgOk === true, sub);
    check(
      "子资源违例进了 csp-report.log（directive=connect-src）",
      Boolean(subText && /directive=connect-src/.test(subText)),
      subText === null ? "日志不可读" : subText.trim().slice(0, 300),
    );
    check(
      "子资源违例进了 csp-report.log（directive=img-src）",
      Boolean(subText && /directive=img-src/.test(subText)),
      subText === null ? "日志不可读" : subText.trim().slice(0, 300),
    );
    check(
      "子资源违例只写元数据，不写页面内容",
      Boolean(subText && !subText.includes("blocked.invalid/x.png?") && !subText.includes("<img")),
      subText === null ? null : subText.trim().slice(0, 300),
    );

    page.destroy();

    // ── 8. 生产默认档（report，d.168）：只记录、不拦，页面照跑 ──
    //
    // 内存里那条策略是 `report` 档，比 enforce 更像「用户装完默认看到的样子」：
    // 内联脚本会照常执行（不白屏），但违例必须进日志。只测 enforce 会漏掉
    // 「默认档被改成 enforce → 用户白屏」这类事故，也会漏掉「report 档其实没记录」。
    installSmokeProtocol(distRoot, { scheme: REPORT_SCHEME, mode: "report", record: recordReportCspHeader });
    const reportPage = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    trustedWindows.add(reportPage);
    const reportFile2 = path.join(ROOT, "logs", "csp-report-report.log");
    const reporter2 = createCspReporter({ file: reportFile2 });
    attachCspReporter(reportPage.webContents, reporter2);
    let reportLoadError = null;
    try {
      await reportPage.loadURL(`${REPORT_ORIGIN}/`);
    } catch (error) {
      reportLoadError = error && error.message ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const reportPolicy = reportCspHeaderSeen && reportCspHeaderSeen["Content-Security-Policy-Report-Only"];
    check(
      "report 档下发的是 Report-Only 头（生产默认档，只记录不拦）",
      Boolean(!reportLoadError && typeof reportPolicy === "string" && reportCspHeaderSeen["Content-Security-Policy"] === undefined),
      { loadError: reportLoadError, hasReportOnly: typeof reportPolicy === "string", bytes: typeof reportPolicy === "string" ? reportPolicy.length : 0 },
    );

    const reportRun = await injectInlineVia(reportPage.webContents);
    check("report 档下内联脚本照常执行（不白屏）", reportRun.ran === true, reportRun);

    const reportText2 = await waitForFile(reportFile2, 3000);
    check(
      "report 档的违例同样进日志（默认档出问题时也查得到）",
      Boolean(reportText2 && /directive=script-src/.test(reportText2) && /blocked=inline/.test(reportText2)),
      reportText2 === null ? "文件 3s 内没出现" : reportText2.trim().slice(0, 200),
    );
    reportPage.destroy();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`SMOKE_RESULT ${JSON.stringify({ total: checks.length, failed: failed.length, skipped, checks })}`);
  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", path.join(ROOT, "userdata"));
app.whenReady().then(() => {
  setTimeout(() => fail(`超时 ${TIMEOUT_MS}ms 未完成`), TIMEOUT_MS).unref?.();
  run().catch((error) => fail(error && error.stack ? error.stack : String(error)));
});
