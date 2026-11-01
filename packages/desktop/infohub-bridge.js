"use strict";
/**
 * InfoHub 本机进程桥（桌面端）。
 *
 * ## 为什么是 stdio 子进程
 *
 * 并入和鸣的是 InfoHub 的 Python 核心（QQ/微信归档、FTS5 检索、议程提取）。
 * 这部分没法用 TypeScript 重写——SQLCipher 解密、Silk 转码这些依赖都在 Python 生态里。
 * 但归档是**个人数据**，不能上传云端、也不该开一个本机 HTTP 端口等人来连。
 *
 * 所以：Electron 主进程用 stdio 拉起 `python -m infohub.bridge`，
 * 换行分隔 JSON 一问一答。不开端口、不监听回环地址、不传 token，
 * 进程一退出通道就消失。归档库以 `mode=ro` 打开，浏览不写库。
 *
 * ## 与 MCP stdio 的区别
 *
 * mcp-stdio.js 说的是 JSON-RPC，用于第三方 MCP 服务；这里是 InfoHub 自己的
 * 极简协议（`{id, method, params}` → `{id, ok, result|error}`），
 * 方法白名单在两侧各留一份，任何一侧被改坏都不会变成任意代码执行。
 */

const fs = require("node:fs");
const path = require("node:path");
const { bundledPython } = require("./bundled-runtime");

/** 与 packages/infohub/infohub/bridge.py 的 `_ALLOWED_METHODS` 保持一致。 */
const ALLOWED_METHODS = new Set([
  "ping",
  "status",
  "conversations",
  "messages",
  "search",
  "agenda",
  "sync",
  "config.summary",
  "shutdown",
]);

/** 渲染层可调用的方法：去掉 shutdown（生命周期由 preload 的 stop 负责）。 */
const RENDERER_METHODS = new Set([...ALLOWED_METHODS].filter((m) => m !== "shutdown"));

/** 单次请求超时。采集可能跑十几分钟，单独放宽；其余方法应是即时返回。 */
const METHOD_TIMEOUTS = {
  sync: 30 * 60_000,
  agenda: 5 * 60_000,
};
const DEFAULT_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 20_000;

/** 单行上限：正文不经过这里，正常请求只有几 KB。与 Python 侧一致。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 进程启动失败时留给用户看的 stderr 尾巴长度。 */
const MAX_STDERR_TAIL = 4_000;

/**
 * InfoHub Python 包所在目录。
 *
 * 开发态：`packages/desktop/../infohub`
 * 打包后：`<安装目录>/resources/infohub`（electron-builder extraResources）
 *
 * 两种形态都由这里算，调用方不必判断自己跑在哪。
 */
function resolveInfohubPackageDir({ isPackaged, resourcesPath, dirname }) {
  if (isPackaged) return path.join(resourcesPath, "infohub");
  return path.join(dirname, "..", "infohub");
}

/** 首次使用且用户没指定目录时的默认位置：`<根目录>/infohub`（和鸣统一放在 ~/Heming 下）。 */
function resolveDefaultHome(rootDir) {
  return path.join(rootDir, "infohub");
}

/** 目录/解释器路径：只接受绝对路径，拒绝换行与控制符（防止拼出第二条命令）。 */
function normalizeAbsolute(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024) return fallback;
  if (/[\r\n\u0000]/.test(trimmed)) return fallback;
  if (!path.isAbsolute(trimmed)) return fallback;
  return path.normalize(trimmed);
}

function normalizeHome(value, fallback) {
  return normalizeAbsolute(value, fallback);
}

function normalizePython(value) {
  return normalizeAbsolute(value, "");
}

/**
 * 选解释器：用户显式配置的优先，其次内置运行时，最后报「找不到」。
 * 不抛异常——「内置缺失」应该由界面提示并允许改路径，不是崩溃。
 */
function resolvePython({ configured, bundled, exists = defaultExists }) {
  const picked = normalizePython(configured);
  if (picked && exists(picked)) return { python: picked, source: "configured" };
  const fallback = normalizePython(bundled);
  if (fallback && exists(fallback)) return { python: fallback, source: "bundled" };
  return { python: "", source: "missing" };
}

function defaultExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/** 一行一条 JSON：与 Python 侧 `_emit` 的格式一致（紧凑、无缩进）。 */
function encodeMessage(payload) {
  return JSON.stringify(payload) + "\n";
}

/**
 * 从缓冲区切出完整消息。返回 `messages` 与最后一段不完整的 `rest`。
 * 非 JSON 行（服务端误把日志写到 stdout）直接忽略，不影响后续消息。
 */
function extractMessages(buffer) {
  const parts = String(buffer).split("\n");
  const rest = parts.pop() ?? "";
  const messages = [];
  for (const line of parts) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") messages.push(parsed);
    } catch {
      /* 误写的日志行：忽略 */
    }
  }
  return { messages, rest };
}

function isValidMethod(method, allowShutdown = false) {
  if (typeof method !== "string") return false;
  const allowed = allowShutdown ? ALLOWED_METHODS : RENDERER_METHODS;
  return allowed.has(method);
}

/**
 * 创建桥实例。`spawn` 可注入（测试用假子进程）。
 *
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts: object) => any} deps.spawn
 * @param {string} deps.packageDir InfoHub 包目录（同时作为 cwd 与 PYTHONPATH）
 * @param {string} deps.defaultHome 用户未指定时的数据目录
 * @param {string|null} [deps.bundledPythonPath] 内置解释器
 * @param {(target: string) => boolean} [deps.exists]
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.helloTimeoutMs]
 */
function createInfohubBridge({
  spawn,
  packageDir,
  defaultHome,
  bundledPythonPath = null,
  exists = defaultExists,
  log = () => {},
  helloTimeoutMs = HELLO_TIMEOUT_MS,
}) {
  /** 当前子进程与它对应的配置。 */
  let child = null;
  let current = null; // { home, python, pythonSource }
  let buffer = "";
  let nextId = 1;
  let hello = null;
  let stderrTail = "";
  /** 进行中的启动：Promise<hello>，并发调用方共用同一份。 */
  let starting = null;
  /** 本次启动的 hello 等待器；attach 里的 stdout/exit 处理器通过它通知结果。 */
  let helloDeferred = null;
  let startedAt = 0;
  const pending = new Map();
  const eventSinks = new Set();

  function resolveTarget(config = {}) {
    const home = normalizeHome(config.home, defaultHome);
    const picked = resolvePython({
      configured: config.python,
      bundled: bundledPythonPath,
      exists,
    });
    return { home, python: picked.python, pythonSource: picked.source };
  }

  function emitEvent(event) {
    for (const sink of eventSinks) {
      try {
        sink(event);
      } catch (err) {
        log(`[infohub] 事件处理失败: ${err && err.message}`);
      }
    }
  }

  function rejectAll(reason) {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    pending.clear();
  }

  function attach(targetChild, target) {
    targetChild.stdout?.setEncoding?.("utf8");
    targetChild.stderr?.setEncoding?.("utf8");

    targetChild.stdout?.on("data", (chunk) => {
      if (child !== targetChild) return;
      buffer += chunk;
      const { messages, rest } = extractMessages(buffer);
      buffer = rest;
      if (buffer.length > MAX_LINE_BYTES) buffer = "";
      for (const msg of messages) {
        if (msg.event === "hello") {
          hello = msg;
          helloDeferred?.resolve(msg);
          continue;
        }
        if (msg.event) {
          emitEvent(msg);
          continue;
        }
        if (msg.id === null || msg.id === undefined) {
          if (msg.ok === false) log(`[infohub] 协议错误: ${msg.error?.message ?? "未知"}`);
          continue;
        }
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        pending.delete(msg.id);
        if (msg.ok === false) {
          const error = new Error(msg.error?.message ?? "InfoHub 请求失败");
          error.type = msg.error?.type ?? "Error";
          waiter.reject(error);
        } else {
          waiter.resolve(msg.result);
        }
      }
    });

    targetChild.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) log(`[infohub] ${trimmed.slice(0, 500)}`);
      }
    });

    targetChild.on("exit", (code, signal) => {
      if (child !== targetChild) return;
      child = null;
      current = null;
      hello = null;
      buffer = "";
      const tail = stderrTail.trim().split("\n").pop() ?? "";
      const reason = `InfoHub 进程已退出（code=${code ?? "null"} signal=${signal ?? "null"}）${
        tail ? `：${tail.slice(0, 300)}` : ""
      }`;
      helloDeferred?.reject(new Error(reason));
      rejectAll(reason);
    });

    targetChild.on("error", (err) => {
      if (child !== targetChild) return;
      child = null;
      current = null;
      hello = null;
      const reason = `InfoHub 启动失败：${err?.message ?? err}`;
      helloDeferred?.reject(new Error(reason));
      rejectAll(reason);
    });

    current = target;
    startedAt = Date.now();
  }

  function launch(target) {
    buffer = "";
    stderrTail = "";
    hello = null;
    const pythonPath = process.env.PYTHONPATH
      ? packageDir + path.delimiter + process.env.PYTHONPATH
      : packageDir;
    const env = {
      ...process.env,
      INFOHUB_HOME: target.home,
      PYTHONPATH: pythonPath,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };

    let targetChild;
    try {
      targetChild = spawn(target.python, ["-m", "infohub.bridge"], {
        cwd: packageDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      return Promise.reject(new Error(`InfoHub 启动失败：${err?.message ?? err}`));
    }
    child = targetChild;
    attach(targetChild, target);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        helloDeferred = null;
        reject(new Error("InfoHub 启动超时：请检查 Python 解释器与数据目录是否正确"));
      }, helloTimeoutMs);
      timer.unref?.();
      helloDeferred = {
        resolve(msg) {
          clearTimeout(timer);
          helloDeferred = null;
          resolve(msg);
        },
        reject(err) {
          clearTimeout(timer);
          helloDeferred = null;
          reject(err);
        },
      };
    });
  }

  function snapshot() {
    return {
      ...info(),
      hello: hello ? { ...hello } : null,
    };
  }

  function info() {
    return {
      packageDir,
      defaultHome,
      bundledPython: bundledPythonPath,
      running: Boolean(child),
      pid: child?.pid ?? null,
      home: current?.home ?? null,
      python: current?.python ?? null,
      pythonSource: current?.pythonSource ?? null,
      startedAt: child ? startedAt : 0,
      methods: [...RENDERER_METHODS],
    };
  }

  function isSameTarget(target) {
    return Boolean(
      child &&
        current &&
        current.home === target.home &&
        current.python === target.python
    );
  }

  /**
   * 拉起进程并等 hello。配置没变则复用已有进程。
   * @returns {Promise<object>} 快照（含 hello）
   */
  async function start(config = {}) {
    const target = resolveTarget(config);
    if (!target.python) {
      throw new Error(
        "未找到可用的 Python 解释器。请把「Python 解释器」指向 InfoHub 的虚拟环境，或先构建内置运行时。"
      );
    }

    if (isSameTarget(target) && hello) return snapshot();
    if (starting) {
      // 并发启动共用同一份：等同一次 hello（失败则按本次配置重试）。
      try {
        await starting;
      } catch {
        /* 上一次失败不影响这一次 */
      }
      if (isSameTarget(target) && hello) return snapshot();
    }

    stop({ killDelayMs: 0, silent: true });
    starting = launch(target);
    try {
      await starting;
    } finally {
      starting = null;
    }
    return snapshot();
  }

  /**
   * 发一条请求。未启动或配置变化时自动拉起。
   * @param {string} method 白名单内的方法
   * @param {object} [params]
   * @param {{home?: string, python?: string}} [config]
   */
  async function call(method, params = {}, config = {}) {
    if (!isValidMethod(method, true)) throw new Error(`不支持的方法：${String(method)}`);
    const target = resolveTarget(config);
    if (!isSameTarget(target)) await start(config);

    const targetChild = child;
    if (!targetChild || !current) throw new Error("InfoHub 进程未启动");

    const id = nextId++;
    const timeoutMs = METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS;
    const message = { id, method, params: params && typeof params === "object" ? params : {} };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`InfoHub 请求超时（${Math.round(timeoutMs / 1000)}s）：${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        targetChild.stdin.write(encodeMessage(message));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`写入 InfoHub 进程失败：${err?.message ?? err}`));
      }
    });
  }

  /** 只发事件/通知，不等响应。 */
  function notify(method, params = {}, config = {}) {
    if (!isValidMethod(method, true) || !child) return false;
    try {
      child.stdin.write(encodeMessage({ id: null, method, params }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 停止进程。先请 Python 自杀（关闭归档库），超时再强杀。
   * @returns {boolean} 是否真的停了一个进程
   */
  function stop({ killDelayMs = 1_500, silent = false } = {}) {
    const targetChild = child;
    if (!targetChild) return false;
    child = null;
    current = null;
    hello = null;
    buffer = "";
    rejectAll("InfoHub 进程已停止");
    if (starting) {
      helloDeferred?.reject(new Error("InfoHub 进程已停止"));
      starting = null;
    }
    try {
      if (!silent) targetChild.stdin.write(encodeMessage({ id: null, method: "shutdown" }));
      targetChild.stdin.end?.();
    } catch {
      /* 进程可能已经退了 */
    }
    if (killDelayMs <= 0) {
      try {
        targetChild.kill();
      } catch {
        /* 已退出 */
      }
    } else {
      const timer = setTimeout(() => {
        try {
          targetChild.kill();
        } catch {
          /* 已退出 */
        }
      }, killDelayMs);
      timer.unref?.();
    }
    return true;
  }

  /** 应用退出时调用：不留孤儿进程。 */
  function dispose() {
    return stop({ killDelayMs: 0, silent: true });
  }

  /** 订阅进度/事件（`{"event":"progress",...}`）。返回取消订阅函数。 */
  function onEvent(callback) {
    if (typeof callback !== "function") return () => {};
    eventSinks.add(callback);
    return () => eventSinks.delete(callback);
  }

  return {
    call,
    dispose,
    info,
    isValidMethod: (method) => isValidMethod(method),
    notify,
    onEvent,
    start,
    stop,
  };
}

/**
 * 注册 IPC。放在模块里而不是 main.js，是为了能用假 ipcMain/dialog 单测。
 *
 * @param {object} ipcMain
 * @param {object} deps
 * @param {ReturnType<typeof createInfohubBridge>} deps.bridge
 * @param {{showOpenDialog: Function}} deps.dialog
 * @param {(event: any) => any} [deps.windowFromEvent]
 */
function registerInfohubIpc(ipcMain, { bridge, dialog, windowFromEvent = () => null }) {
  ipcMain.handle("infohub:info", () => bridge.info());

  ipcMain.handle("infohub:start", async (_event, config) => {
    const safe = config && typeof config === "object" ? config : {};
    return bridge.start({ home: safe.home, python: normalizePython(safe.python) });
  });

  ipcMain.handle("infohub:call", async (_event, payload) => {
    const safe = payload && typeof payload === "object" ? payload : {};
    const method = safe.method;
    if (typeof method !== "string" || !isValidMethod(method)) {
      throw new Error(`不支持的方法：${String(method)}`);
    }
    return bridge.call(method, safe.params && typeof safe.params === "object" ? safe.params : {}, {
      home: safe.home,
      python: safe.python,
    });
  });

  ipcMain.handle("infohub:stop", () => bridge.stop());

  ipcMain.handle("infohub:pick-home", async (event) => {
    const win = windowFromEvent(event);
    const options = {
      title: "选择 InfoHub 数据目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("infohub:pick-python", async (event) => {
    const win = windowFromEvent(event);
    const options = {
      title: "选择 Python 解释器",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [
              { name: "Python 解释器", extensions: ["exe"] },
              { name: "所有文件", extensions: ["*"] },
            ]
          : [{ name: "所有文件", extensions: ["*"] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
}

module.exports = {
  ALLOWED_METHODS,
  RENDERER_METHODS,
  createInfohubBridge,
  encodeMessage,
  extractMessages,
  isValidMethod,
  normalizeAbsolute,
  normalizeHome,
  normalizePython,
  registerInfohubIpc,
  resolveDefaultHome,
  resolveInfohubPackageDir,
  resolvePython,
};
