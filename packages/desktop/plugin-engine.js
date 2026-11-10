"use strict";
/**
 * 插件自带引擎（第一方 bundle 插件专用）。
 *
 * ## 为什么需要它
 *
 * 界面插件原本只能是被沙箱住的 HTML（`widget://` + 受控 preload），宿主不给文件、
 * 进程、网络之外的任何东西。但「信息中枢」这类插件要读本机聊天归档、要写知识库，
 * 这些能力没法用浏览器 API 实现，又不应再往应用本体里塞业务代码。
 *
 * 所以把「随插件分发的本机进程」做成一项能力：
 * - 只有 `distribution: "bundle"` 且通过**首方验签**的插件才能声明 `contributions.engine`
 *   （清单与 files/** 都由官方密钥覆盖，见 plugin-package.js）；
 * - 入口固定是插件包内的 `.py` 文件，解释器固定用应用内置运行时（bundled-runtime.js），
 *   **不接受**任何命令字符串——清单被改坏也拼不出第二条命令；
 * - 通信走 stdin/stdout 的换行 JSON（与 infohub-bridge.js 同一协议），不开端口、
 *   不收外部连接，进程退出通道即消失。
 *
 * ## 权限边界（每条都可对照 plugin-host.js 的调用点）
 *
 * | 能力 | 条件 | 下发给引擎的东西 |
 * |---|---|---|
 * | 读/写自己的数据目录 | 恒有 | `HEMING_PLUGIN_DATA_DIR` |
 * | 调本机模型网关 | `permissions.chat: true` | `HEMING_CHAT`（网关地址 + 本机默认 Key + 后台任务模型） |
 * | 写和鸣知识库 | `permissions.kb: true` | `HEMING_KB_ROOTS`（各库根 + writeDirs） |
 *
 * 用户自己的供应商 Key 永远不下发（与 widget `chatConfig` 同口径）。
 *
 * ## 完整性
 *
 * 安装时验签 + packageSha256 已挡住「借壳包」，但落盘后的文件仍可能被外部改动。
 * 每次启动新版本引擎前按盘上 `files/**` 重算摘要（与安装同算法），不一致就拒绝启动。
 * 摘要按「插件@版本」缓存一次，35MB 的引擎只付一次开销。
 */

const fs = require("node:fs");
const path = require("node:path");
const { computeFilesDigest, sha256Hex } = require("./plugin-package");
const { teardownChild } = require("./child-kill");

/** 单行上限：正文不经过协议（页面按需分页取），正常请求只有几 KB。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 启动握手（ping）预算：内置解释器冷启动 + Python 导入通常 1s 内。 */
const HELLO_TIMEOUT_MS = 15_000;
/** 普通方法的默认超时；调用方可按方法放宽（采集/归档是长任务）。 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
/** 启动失败时留给用户看的 stderr 尾巴长度。 */
const MAX_STDERR_TAIL = 4_000;
/** 摘要缓存：`<id>@<version>:<packageSha256>` → Promise<boolean>。 */
const digestChecks = new Map();

/** 只保留「能安全放进环境变量」的 JSON：undefined 不出现，字符串长度受限。 */
function jsonEnv(value) {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch {
    return "null";
  }
}

/** 插件包内相对路径必须落在包目录里、且是普通文件（拒绝 `..` 与绝对路径）。 */
function resolveInside(baseDir, rel, { mustExist = true, wantDir = false } = {}) {
  if (typeof rel !== "string" || !rel.trim()) return "";
  const root = path.resolve(baseDir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return "";
  if (mustExist) {
    try {
      const stat = fs.lstatSync(target);
      if (wantDir ? !stat.isDirectory() : !stat.isFile()) return "";
    } catch {
      return "";
    }
  }
  return target;
}

/** 递归列出 `files/**`（只收普通文件；符号链接既不计入也打不开）。 */
function listFiles(filesDir) {
  const out = [];
  const walk = (abs, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child, rel);
      else if (entry.isFile()) {
        try {
          out.push({ path: rel, data: fs.readFileSync(child) });
        } catch {
          /* 读不了的文件无法参与摘要：让摘要校验失败更安全，但这里继续收集其余 */
        }
      }
    }
  };
  walk(filesDir, "files");
  return out;
}

/**
 * 校验落盘 `files/**` 是否仍与安装时一致。
 * 返回 Promise<boolean>；同一版本只算一次（失败也缓存，避免每次调用都扫 35MB）。
 */
function verifyFilesDigest(pluginDir, record) {
  const key = `${record.id}@${record.version}:${record.packageSha256 || ""}`;
  if (digestChecks.has(key)) return digestChecks.get(key);
  const expected = typeof record.packageSha256 === "string" ? record.packageSha256 : "";
  const filesDir = path.join(pluginDir, "files");
  const task = (async () => {
    if (!expected) return false;
    let stat;
    try {
      stat = fs.statSync(filesDir);
    } catch {
      return false;
    }
    if (!stat.isDirectory()) return false;
    const digest = computeFilesDigest(listFiles(filesDir));
    return digest === expected;
  })();
  digestChecks.set(key, task);
  return task;
}

/** 单行 JSON 解析：非 JSON（引擎误写的日志）忽略。 */
function parseLine(line) {
  const text = line.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts: object) => any} deps.spawn
 * @param {string|null} deps.bundledPythonPath 应用内置解释器（没有就明确报错，不回退系统 Python）
 * @param {(id: string) => string|null} deps.pluginDirFor 当前版本目录
 * @param {(id: string) => string} deps.dataDirOf 插件数据目录
 * @param {(id: string) => object} deps.readSettings
 * @param {() => Promise<object>} deps.getChatConfig 与 widget `chatConfig` 同一份（含网关/后台模型）
 * @param {() => Promise<Array<object>>} [deps.getKbRoots] 可写知识库（要 `permissions.kb` 才读取）
 * @param {() => string} [deps.appVersion]
 * @param {(pluginId: string, payload: object) => void} [deps.onEvent] 引擎主动上报（progress 等）
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(fn: Function, ms: number) => any} [deps.setTimeout]
 * @param {(timer: any) => void} [deps.clearTimeout]
 * @param {boolean} [deps.isWindows]
 * @param {(child: any, opts?: object) => Promise<object>} [deps.teardown]
 */
function createPluginEngine(deps = {}) {
  const {
    spawn,
    bundledPythonPath = null,
    pluginDirFor,
    dataDirOf,
    readSettings = () => ({}),
    getChatConfig,
    getKbRoots,
    appVersion = () => "",
    onEvent = () => {},
    log = () => {},
    now = () => Date.now(),
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    isWindows = process.platform === "win32",
    teardown = teardownChild,
  } = deps;

  if (typeof spawn !== "function") throw new Error("plugin-engine: 缺少 spawn");
  if (typeof pluginDirFor !== "function") throw new Error("plugin-engine: 缺少 pluginDirFor");

  /** @type {Map<string, object>} pluginId → 运行态 */
  const engines = new Map();
  /** 最近一次异常退出/启动失败的原因：进程没了，页面仍要看到「为什么」。 */
  const lastErrors = new Map();

  function declared(record) {
    const spec = record && record.engine;
    return Boolean(spec && typeof spec.entry === "string" && spec.entry);
  }

  function requireRecord(record) {
    if (!record || typeof record !== "object") throw new Error("引擎调用失败：找不到插件记录");
    if (!declared(record)) throw new Error(`插件「${record.name || record.id}」没有声明本机引擎`);
    if (record.enabled !== true) throw new Error(`插件「${record.name || record.id}」已停用，引擎不会启动`);
  }

  /** 解析入口/依赖目录：清单可能被外部改过，这里每次启动都重新做路径约束。 */
  function resolveTargets(record) {
    const dir = pluginDirFor(record.id);
    if (!dir) throw new Error(`引擎启动失败：插件文件目录不存在（${record.id}）`);
    const spec = record.engine || {};
    if (!String(spec.entry).toLowerCase().endsWith(".py")) {
      throw new Error("引擎启动失败：入口必须是插件包内的 .py 文件");
    }
    const entry = resolveInside(dir, spec.entry);
    if (!entry) throw new Error(`引擎启动失败：入口不在插件目录内或不存在（${String(spec.entry)}）`);
    const lib = spec.lib ? resolveInside(dir, spec.lib, { wantDir: true }) : "";
    if (spec.lib && !lib) throw new Error(`引擎启动失败：依赖目录不可用（${String(spec.lib)}）`);
    return { dir, entry, lib };
  }

  /** 下发环境：只给该插件声明过的能力，别的一律不出现。 */
  async function buildEnv(record, target) {
    const permissions = (record.permissions || {});
    const settings = readSettings(record.id) || {};
    const paths = [path.dirname(target.entry)];
    if (target.lib) paths.push(target.lib);
    if (process.env.PYTHONPATH) paths.push(process.env.PYTHONPATH);

    const env = {
      ...process.env,
      HEMING_PLUGIN_ID: String(record.id),
      HEMING_PLUGIN_VERSION: String(record.version || ""),
      HEMING_PLUGIN_DATA_DIR: dataDirOf(record.id),
      HEMING_PLUGIN_SETTINGS: jsonEnv(settings),
      HEMING_APP_VERSION: String(appVersion() || ""),
      PYTHONPATH: paths.join(path.delimiter),
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };

    if (permissions.chat === true && typeof getChatConfig === "function") {
      try {
        const chat = await getChatConfig();
        const gateway = (chat && chat.gateway) || {};
        env.HEMING_CHAT = jsonEnv({
          baseUrl: typeof gateway.baseUrl === "string" ? gateway.baseUrl : null,
          key: typeof gateway.key === "string" ? gateway.key : "",
          model: typeof chat.backgroundModel === "string" ? chat.backgroundModel : "",
        });
      } catch (err) {
        log(`[plugin-engine:${record.id}] 对话配置不可用：${(err && err.message) || err}`);
      }
    }

    if (permissions.kb === true && typeof getKbRoots === "function") {
      try {
        const roots = await getKbRoots();
        env.HEMING_KB_ROOTS = jsonEnv(Array.isArray(roots) ? roots : []);
      } catch (err) {
        log(`[plugin-engine:${record.id}] 知识库目录不可用：${(err && err.message) || err}`);
      }
    }

    return env;
  }

  function appendStderr(engine, chunk) {
    engine.stderrTail = (engine.stderrTail + String(chunk)).slice(-MAX_STDERR_TAIL);
  }

  function failPending(engine, reason) {
    for (const pending of engine.pending.values()) {
      clearTimer(pending.timer);
      pending.reject(new Error(reason));
    }
    engine.pending.clear();
  }

  function handleLine(engine, line) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return;
    const payload = parseLine(line);
    if (!payload) return;
    if (payload.event) {
      try {
        onEvent(engine.pluginId, payload);
      } catch (err) {
        log(`[plugin-engine:${engine.pluginId}] 事件投递失败：${(err && err.message) || err}`);
      }
      return;
    }
    const id = payload.id;
    if (id === undefined || id === null) return;
    const pending = engine.pending.get(id);
    if (!pending) return;
    engine.pending.delete(id);
    clearTimer(pending.timer);
    if (payload.ok === true) pending.resolve(payload.result);
    else {
      const error = payload.error || {};
      const message = typeof error.message === "string" && error.message ? error.message : "引擎返回失败";
      const exc = new Error(message.slice(0, 800));
      exc.code = typeof error.type === "string" ? error.type : "ENGINE_ERROR";
      pending.reject(exc);
    }
  }

  function onStdout(engine, chunk) {
    engine.buffer += String(chunk);
    let index = engine.buffer.indexOf("\n");
    while (index >= 0) {
      const line = engine.buffer.slice(0, index);
      engine.buffer = engine.buffer.slice(index + 1);
      try {
        handleLine(engine, line);
      } catch (err) {
        log(`[plugin-engine:${engine.pluginId}] 协议行处理失败：${(err && err.message) || err}`);
      }
      index = engine.buffer.indexOf("\n");
    }
    // 引擎写不出换行（坏协议）时不能无限吃内存
    if (engine.buffer.length > MAX_LINE_BYTES) engine.buffer = "";
  }

  function send(engine, method, params, timeoutMs) {
    const id = (engine.seq += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        engine.pending.delete(id);
        reject(new Error(`引擎调用超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      engine.pending.set(id, { resolve, reject, timer });
      try {
        engine.child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + "\n");
      } catch (err) {
        clearTimer(timer);
        engine.pending.delete(id);
        reject(new Error(`引擎写入失败：${(err && err.message) || err}`));
      }
    });
  }

  /** 启动一个引擎（同一插件只会有一个；版本/入口一致时复用）。 */
  async function start(record) {
    requireRecord(record);
    lastErrors.delete(record.id);
    const target = resolveTargets(record);
    const existing = engines.get(record.id);
    if (existing) {
      const same =
        existing.version === record.version &&
        existing.target.entry === target.entry &&
        existing.ready;
      if (same) return existing.ready;
      // 升级/换入口：旧进程必须先收掉，否则调用会落到旧代码上
      await stop(record.id, { silent: true });
    }

    const engine = {
      pluginId: record.id,
      version: record.version,
      target,
      child: null,
      buffer: "",
      stderrTail: "",
      seq: 0,
      pending: new Map(),
      startedAt: 0,
      ready: null,
      error: "",
      stopped: false,
    };
    const ready = (async () => {
      if (!bundledPythonPath) {
        throw new Error("引擎启动失败：应用内置 Python 运行时不可用，请重新安装和鸣");
      }
      const integrityOk = await verifyFilesDigest(target.dir, record);
      if (!integrityOk) {
        throw new Error("引擎启动失败：插件文件校验不通过（可能被外部修改），请重新安装该插件");
      }
      const env = await buildEnv(record, target);
      let child;
      const spawnOpts = {
        cwd: target.dir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      };
      // 非 Windows 让引擎自成进程组，teardown 的 kill(-pid) 才打得对（同 infohub-bridge）
      if (!isWindows) spawnOpts.detached = true;
      try {
        child = spawn(bundledPythonPath, ["-u", target.entry], spawnOpts);
      } catch (err) {
        throw new Error(`引擎启动失败：${(err && err.message) || err}`);
      }
      engine.child = child;
      engine.startedAt = now();
      child.stdout?.on?.("data", (chunk) => onStdout(engine, chunk));
      child.stderr?.on?.("data", (chunk) => appendStderr(engine, chunk));
      child.on?.("error", (err) => {
        engine.error = (err && err.message) || String(err);
        failPending(engine, `引擎进程异常：${engine.error}`);
        log(`[plugin-engine:${record.id}] 进程异常：${engine.error}`);
      });
      child.on?.("exit", (code, signal) => {
        engine.child = null;
        const reason = `引擎已退出（code=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）`;
        failPending(engine, reason);
        if (!engine.stopped) {
          const tail = engine.stderrTail.trim();
          engine.error = tail ? `${reason}：${tail.slice(-600)}` : reason;
          lastErrors.set(record.id, engine.error);
          log(`[plugin-engine:${record.id}] ${engine.error}`);
        }
        if (engines.get(record.id) === engine) engines.delete(record.id);
      });

      // 握手：约定 `ping` 必须返回 ok，证明解释器与包路径都对了再放行调用方
      try {
        await send(engine, "ping", {}, HELLO_TIMEOUT_MS);
      } catch (err) {
        const tail = engine.stderrTail.trim();
        await stop(record.id, { graceMs: 0, silent: true });
        const detail = tail ? `：${tail.slice(-600)}` : "";
        throw new Error(`引擎启动失败：握手超时（${(err && err.message) || err}）${detail}`);
      }
      log(`[plugin-engine:${record.id}] 已就绪（${record.version}）`);
      if (engines.get(record.id) === engine) lastErrors.delete(record.id);
      return engine;
    })();

    engine.ready = ready;
    engines.set(record.id, engine);
    try {
      return await ready;
    } catch (err) {
      if (engines.get(record.id) === engine) engines.delete(record.id);
      throw err;
    }
  }

  /** 调用一个引擎方法：首次调用时懒启动。 */
  async function call(record, method, params, options = {}) {
    requireRecord(record);
    const name = typeof method === "string" ? method.trim() : "";
    if (!name || name.length > 64) throw new Error("引擎调用失败：方法名非法");
    const rawTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.round(rawTimeout)))
      : DEFAULT_TIMEOUT_MS;
    const engine = await start(record);
    return send(engine, name, params, timeoutMs);
  }

  /** 停一个插件引擎；`graceMs=0` 直接拔树（启动失败/退出时用）。 */
  async function stop(pluginId, options = {}) {
    const engine = engines.get(String(pluginId));
    if (!engine) return false;
    engines.delete(engine.pluginId);
    engine.stopped = true;
    failPending(engine, "引擎已停止");
    const child = engine.child;
    engine.child = null;
    if (!child) return true;
    try {
      // 先给协议层一次礼貌退出的机会（引擎可实现 shutdown；不实现也无妨）
      if (options.graceMs === undefined || options.graceMs > 0) {
        try {
          child.stdin.write(JSON.stringify({ id: 0, method: "shutdown", params: {} }) + "\n");
          child.stdin.end();
        } catch {
          /* stdin 已关 */
        }
      }
    } catch {
      /* 忽略 */
    }
    try {
      await teardown(child, { graceMs: options.graceMs ?? 1_500 });
    } catch (err) {
      log(`[plugin-engine:${engine.pluginId}] 回收进程失败：${(err && err.message) || err}`);
    }
    if (!options.silent) log(`[plugin-engine:${engine.pluginId}] 已停止`);
    return true;
  }

  /** 对账：停掉「不该再跑」的引擎（停用 / 卸载 / 版本变化 / 入口变化）。 */
  async function reconcile(records) {
    const desired = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !declared(record) || record.enabled !== true || record.error) continue;
      desired.set(record.id, record);
    }
    const stops = [];
    for (const [pluginId, engine] of [...engines.entries()]) {
      const record = desired.get(pluginId);
      const same = record && record.version === engine.version && record.engine.entry === engine.target.entry;
      if (!same) stops.push(stop(pluginId));
    }
    await Promise.allSettled(stops);
  }

  async function stopAll() {
    await Promise.allSettled([...engines.keys()].map((id) => stop(id)));
  }

  /** 给页面看的运行态（不含路径与子进程对象）。 */
  function status(pluginId, record) {
    const declaredHere = declared(record);
    const engine = engines.get(String(pluginId));
    return {
      declared: declaredHere,
      running: Boolean(engine && engine.child),
      pid: engine && engine.child ? engine.child.pid ?? null : null,
      startedAt: engine && engine.startedAt ? engine.startedAt : null,
      error: (engine && engine.error) || lastErrors.get(String(pluginId)) || "",
    };
  }

  return {
    call,
    start,
    stop,
    stopAll,
    reconcile,
    status,
    _internal: { resolveTargets, verifyFilesDigest, listFiles, sha256Hex },
  };
}

module.exports = {
  createPluginEngine,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_LINE_BYTES,
};
