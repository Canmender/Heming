"use strict";
/**
 * 桌面主进程崩溃兜底（d.30 · P0-4）。
 *
 * 背景：此前 `packages/desktop/**` 内 `uncaughtException` / `unhandledRejection` /
 * `render-process-gone` / `crashReporter` **全部 0 命中**。后果是主进程抛一个未捕获
 * 异常就直接静默退出——用户只看到「应用莫名其妙没了」，而**本机没有任何日志可查**；
 * 渲染进程白屏也不会自恢复。
 *
 * 本模块只做两件事：
 * 1. 把崩溃现场写到 `~/Heming/logs/`（只写本机文件）；
 * 2. 渲染进程崩溃时自动重载**一次**。
 *
 * ── 为什么不上报云端（这是红线取舍，不是省事）────────────────────────────
 * 崩溃日志里可能混着用户输入片段（异常的 message 常常直接带用户数据），
 * 上报等于把个人数据送出设备，违反「个人数据不出设备」这条底线。
 * 代价是「厂商拿不到崩溃率」——这是个人工具不是商业产品，可接受。
 *
 * 因此本文件**不得**具备任何网络能力（http / https / net / dgram / fetch 一律不许用），
 * 这条红线由 crash-log.test.js 用「打桩网络 API 并断言未被调用」钉死。
 *
 * ── 为什么不依赖 electron ────────────────────────────────────────────────
 * 版本号经参数注入、文件系统经参数注入，所以本模块能当纯 node 模块单测。
 * （在模块里 require("electron") 会让纯 node 测试根本加载不了这个文件。）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 日志目录名（固定在 ~/Heming 下，与 charts / 知识库同级）。 */
const LOG_DIR_NAME = "logs";

/** 目录覆盖环境变量：测试指向临时目录用，也给用户一个「日志放别处」的出口。 */
const CRASH_DIR_ENV = "HEMING_CRASH_DIR";

/** 崩溃类型标识（写进日志，也便于人工按类型筛）。 */
const KIND_UNCAUGHT = "uncaughtException";
const KIND_UNHANDLED = "unhandledRejection";
const KIND_RENDER_GONE = "render-process-gone";

/** 单条附加信息与异常文本的长度上限：崩溃日志是给人看的，不是无限膨胀的存档。 */
const MAX_VALUE_LEN = 512;
const MAX_TEXT_LEN = 4000;

/**
 * 附加信息里**不许**落盘的字段名（大小写不敏感）。
 *
 * 崩溃现场的 extra 是调用方给的，但调用方也可能是未来的自己——
 * 一旦有人顺手把「用户 ID」「token」「消息正文」塞进 extra，
 * 落盘就等于把凭据留在磁盘上。这里按字段名直接拒收，比写注释靠得住。
 */
const FORBIDDEN_EXTRA_KEY =
  /(token|secret|password|passwd|authorization|auth|cookie|session|credential|user_?id|uid|message|body|content|text|payload|query|params|headers)/i;

/**
 * 异常文本里的敏感片段脱敏。
 *
 * 异常 message 常常是「拼出来的请求串」（`POST /api/x?token=…`），
 * 直接落盘就把凭据带进了日志文件——而日志文件是用户会拿去问人的东西。
 * 只盖高置信度的形态（Bearer 头、JWT、`key=value` 形式的凭据），不动其它内容。
 */
function redact(text) {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [已脱敏]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[JWT已脱敏]")
    .replace(
      /\b(token|access_token|refresh_token|authorization|password|passwd|secret|api_?key)\s*[=:]\s*("?)[^\s"',;]+/gi,
      "$1=[已脱敏]"
    );
}

/** 截断超长文本，避免一条异常把日志撑爆。 */
function clip(text) {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > MAX_TEXT_LEN ? `${s.slice(0, MAX_TEXT_LEN)}…（已截断，共 ${s.length} 字符）` : s;
}

/** 安全的 JSON 序列化（循环引用 / 抛异常都不怕）。 */
function safeStringify(value) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[循环引用]";
        seen.add(val);
      }
      if (typeof val === "string") return clip(redact(val));
      return val;
    });
  } catch {
    return "[无法序列化]";
  }
}

/**
 * 把任意 thrown 值规整成 { name, message, stack }。
 *
 * `unhandledRejection` 的 reason **不保证是 Error**（可能是一个字符串、一个普通对象），
 * 所以不能直接读 `.stack`——读不到就是 undefined，格式会塌。这里逐字段兜底。
 */
function describeError(error) {
  if (error instanceof Error) {
    return {
      name: String(error.name || "Error"),
      message: String(error.message || ""),
      stack: String(error.stack || ""),
    };
  }
  if (error && typeof error === "object") {
    const name = typeof error.name === "string" && error.name ? error.name : "Object";
    const message =
      typeof error.message === "string" && error.message
        ? error.message
        : safeStringify(error);
    const stack = typeof error.stack === "string" ? error.stack : "";
    return { name, message, stack };
  }
  return { name: typeof error, message: safeStringify(error), stack: "" };
}

/**
 * 附加信息清洗：只留标量、拒收敏感字段名、限长。
 * 返回字符串数组（已格式化成 `key=value`），便于直接拼进日志正文。
 */
function sanitizeExtra(extra) {
  if (!extra || typeof extra !== "object") return [];
  const lines = [];
  for (const [key, value] of Object.entries(extra)) {
    if (FORBIDDEN_EXTRA_KEY.test(key)) continue; // 敏感字段直接不落盘
    if (value === null || value === undefined) continue;
    const type = typeof value;
    if (type === "string") {
      lines.push(`${key}=${clip(redact(value))}`);
    } else if (type === "number" || type === "boolean") {
      lines.push(`${key}=${String(value)}`);
    } else {
      // 对象/数组一律不落盘：里面多半裹着用户数据（消息体、请求参数……）
      lines.push(`${key}=[已省略 ${type}]`);
    }
  }
  return lines;
}

/**
 * 崩溃日志目录。
 *
 * 默认 `~/Heming/logs`；`HEMING_CRASH_DIR` 可覆盖（测试指向临时目录，
 * 也给用户一个把日志挪到别处的出口）。
 */
function crashLogDir(env) {
  const e = env || process.env;
  const override = e && typeof e.HEMING_CRASH_DIR === "string" ? e.HEMING_CRASH_DIR.trim() : "";
  if (override) return path.resolve(override);
  return path.join(os.homedir(), "Heming", LOG_DIR_NAME);
}

/** 默认应用版本：走 app-version.js（纯 node，不碰 electron）。取不到就写 unknown。 */
function defaultAppVersion() {
  try {
    return require("./app-version").appVersion();
  } catch {
    return "unknown";
  }
}

/** 判断文件是否已存在（注入的 fs 可能没有 existsSync，缺了就当不存在）。 */
function fileExists(fsImpl, file) {
  try {
    return typeof fsImpl.existsSync === "function" ? fsImpl.existsSync(file) : false;
  } catch {
    return false;
  }
}

/**
 * 生成本次崩溃的日志文件名。
 *
 * 形如 `crash-2026-10-22T08-12-33.481Z-12345.log`：
 * - ISO 时间戳里的**冒号要去掉**——Windows 文件名不允许冒号；
 * - 带 pid：多实例同时崩不会撞名；
 * - 同一进程内多次崩溃：追加序号后缀，**互不覆盖**（崩两次只留一份就等于没留）。
 */
function uniqueLogPath(dir, fsImpl, pid) {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const base = `crash-${stamp}-${pid ?? process.pid}`;
  let candidate = path.join(dir, `${base}.log`);
  let seq = 2;
  while (fileExists(fsImpl, candidate) && seq < 1000) {
    candidate = path.join(dir, `${base}-${seq}.log`);
    seq += 1;
  }
  return candidate;
}

/** 拼装日志正文。 */
function formatCrashLog({ kind, error, extra, version, pid, nodeVersion }) {
  const info = describeError(error);
  const lines = [
    "==== 和鸣 崩溃日志 ====",
    `appVersion: ${version ?? "unknown"}`,
    `time(UTC): ${new Date().toISOString()}`,
    `kind: ${kind}`,
    `pid: ${pid ?? process.pid}`,
  ];
  if (nodeVersion) lines.push(`node: ${nodeVersion}`);
  lines.push(`name: ${info.name}`);
  lines.push(`message: ${clip(redact(info.message))}`);
  lines.push("stack:");
  lines.push(info.stack ? clip(redact(info.stack)) : "（无 stack）");
  const extraLines = sanitizeExtra(extra);
  if (extraLines.length) {
    lines.push("--- extra ---");
    lines.push(...extraLines);
  }
  lines.push("==== 结束 ====");
  return `${lines.join("\n")}\n`;
}

/**
 * 写一条崩溃日志。
 *
 * ★ 绝不能抛：它会被装进 uncaughtException 处理器里用，处理器再抛就是死循环。
 * 写失败只 console.error 吞掉。
 *
 * ★ 只写本机文件，不做任何网络请求（见文件头「为什么不上报云端」）。
 *
 * @param {string} kind 崩溃类型（uncaughtException / unhandledRejection / render-process-gone）
 * @param {unknown} error 抛出的值 / 崩溃现场
 * @param {object} [extra] 附加信息（敏感字段名会被拒收，见 FORBIDDEN_EXTRA_KEY）
 * @param {object} [deps] 注入依赖：{ fs, logDir, appVersion, pid, env }
 * @returns {string|null} 落盘路径；失败返回 null
 */
function writeCrashLog(kind, error, extra, deps = {}) {
  const fsImpl = deps.fs || fs;
  const dir = deps.logDir || crashLogDir(deps.env);
  const version = deps.appVersion || defaultAppVersion();
  try {
    // 目录可能还不存在（首次崩溃就是这种情况）——顺手建出来。
    fsImpl.mkdirSync(dir, { recursive: true });
    const file = uniqueLogPath(dir, fsImpl, deps.pid);
    fsImpl.appendFileSync(file, formatCrashLog({ kind, error, extra, version, pid: deps.pid }), "utf8");
    return file;
  } catch (err) {
    safeError("[heming] 崩溃日志写入失败:", (err && err.message) || err);
    return null;
  }
}

/** console.error 的安全包装：连它自己抛了也不能把调用方带崩。 */
function safeError(...args) {
  try {
    console.error(...args);
  } catch {
    /* 忽略：连日志通道都坏了，那就只能放弃这条日志 */
  }
}

/**
 * 装上主进程崩溃兜底。
 *
 * 处理器里**不能抛错、不能 await**：处理器本身抛异常会变成死循环
 * （uncaughtException → 处理器抛 → 又是 uncaughtException → …）。
 * 这里全程同步、写文件用 appendFileSync，失败即吞。
 *
 * 关于退出行为：注册了 uncaughtException 处理器之后，**Node 就不再自动退出了**
 * （未捕获异常被处理器接住，进程继续跑）——这正是「假装没事继续跑」，
 * 状态已经被污染的进程继续跑只会把故障拖成更大的一次。所以处理器写完日志后
 * 显式 `exit(1)`，把 Node 默认的「崩了就退出」语义原样还原。
 *
 * @param {object} deps 注入依赖：{ proc, fs, appVersion, logDir, env, exitOnCrash, exitCode }
 */
function installCrashHandlers(deps = {}) {
  const proc = deps.proc || process;
  const fsImpl = deps.fs || fs;
  const logDir = deps.logDir || crashLogDir(deps.env);
  const version = deps.appVersion || defaultAppVersion();
  const exitOnCrash = deps.exitOnCrash !== false;
  const exitCode = typeof deps.exitCode === "number" ? deps.exitCode : 1;

  const onCrash = (kind, payload) => {
    try {
      writeCrashLog(kind, payload, undefined, { fs: fsImpl, logDir, appVersion: version });
    } catch (err) {
      // writeCrashLog 本身不抛，这里再兜一层：处理器里抛异常 = 死循环。
      safeError("[heming] 崩溃日志处理失败:", (err && err.message) || err);
    }
    if (!exitOnCrash) return;
    try {
      if (typeof proc.exit === "function") proc.exit(exitCode);
    } catch {
      /* 退不出去就算了：日志已经落盘，目的达到了 */
    }
  };

  const onUncaught = (err) => onCrash(KIND_UNCAUGHT, err);
  const onUnhandled = (reason) => onCrash(KIND_UNHANDLED, reason);

  proc.on("uncaughtException", onUncaught);
  proc.on("unhandledRejection", onUnhandled);

  return {
    /** 卸掉处理器（测试用：避免污染真实 process 的监听器列表）。 */
    uninstall() {
      try {
        if (typeof proc.off === "function") {
          proc.off("uncaughtException", onUncaught);
          proc.off("unhandledRejection", onUnhandled);
        } else if (typeof proc.removeListener === "function") {
          proc.removeListener("uncaughtException", onUncaught);
          proc.removeListener("unhandledRejection", onUnhandled);
        }
      } catch {
        /* 卸不掉也无妨 */
      }
    },
  };
}

/**
 * 渲染进程崩溃的自动恢复标志。
 *
 * 模块级：整个主进程生命周期共享一个「已经重载过一次」的记忆。
 * 之所以不做成「每个窗口各自一次」：崩溃循环（每次加载都崩）会把机器刷爆，
 * 一次重载之后还崩，就说明问题不在这一次渲染，剩下的是让人看到日志、
 * 而不是让机器一直重启。
 */
let renderReloaded = false;

/** 把「已经重载过」的标志复位（仅供测试隔离使用）。 */
function resetRenderCrashGuard() {
  renderReloaded = false;
}

/**
 * 渲染进程崩溃兜底：写一条日志 + 自动重载一次。
 *
 * @param {object} webContents Electron 的 webContents
 * @param {object} [deps] 注入依赖：{ fs, logDir, appVersion, reload }
 */
function attachRenderCrashRecovery(webContents, deps = {}) {
  const fsImpl = deps.fs || fs;
  const logDir = deps.logDir || crashLogDir(deps.env);
  const version = deps.appVersion || defaultAppVersion();
  const reload =
    deps.reload ||
    (() => {
      if (!webContents) return;
      try {
        if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return;
        if (typeof webContents.reload === "function") webContents.reload();
      } catch {
        /* 重载失败就让窗口留在原地，总比再崩一次好 */
      }
    });

  const handler = (_event, details) => {
    const reason = details && typeof details.reason === "string" ? details.reason : "unknown";
    const exitCode = details && typeof details.exitCode === "number" ? details.exitCode : null;
    try {
      writeCrashLog(
        KIND_RENDER_GONE,
        new Error(`渲染进程退出：${reason}`),
        { reason, exitCode },
        { fs: fsImpl, logDir, appVersion: version }
      );
    } catch (err) {
      safeError("[heming] 渲染进程崩溃日志写入失败:", (err && err.message) || err);
    }
    // clean-exit = 渲染进程是自己要退出的（比如页面自己关窗），重载会把用户的动作撤销。
    if (reason === "clean-exit") return;
    if (renderReloaded) return; // 只重载一次
    renderReloaded = true;
    try {
      reload();
    } catch {
      /* 重载失败就到此为止 */
    }
  };

  webContents.on(KIND_RENDER_GONE, handler);
  return {
    /** 当前是否已经重载过（测试断言用）。 */
    hasReloaded: () => renderReloaded,
    uninstall() {
      try {
        if (typeof webContents.off === "function") webContents.off(KIND_RENDER_GONE, handler);
        else if (typeof webContents.removeListener === "function") {
          webContents.removeListener(KIND_RENDER_GONE, handler);
        }
      } catch {
        /* 忽略 */
      }
    },
  };
}

module.exports = {
  crashLogDir,
  writeCrashLog,
  installCrashHandlers,
  attachRenderCrashRecovery,
  resetRenderCrashGuard,
  describeError,
  sanitizeExtra,
  redact,
  KIND_UNCAUGHT,
  KIND_UNHANDLED,
  KIND_RENDER_GONE,
  CRASH_DIR_ENV,
};
