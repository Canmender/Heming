"use strict";

/**
 * MCP stdio 传输桥（仅桌面端）：主进程拉起 MCP 服务子进程，用换行分隔的 JSON-RPC
 * 在 stdin/stdout 上通信。
 *
 * 为什么放主进程：渲染进程（sandbox）没有 child_process 权限；而且 MCP 服务是
 * 本机长期进程，生命周期应当跟窗口/应用走，不能随页面刷新泄漏。
 *
 * 安全约束：
 * - 只在桌面壳里可用（preload 暴露的通道）；
 * - 命令与参数由用户显式填写，落库前经过校验；这里再做一次类型/长度校验；
 * - 不使用 shell 拼接参数（shell:false），Windows 下 `.cmd` 由调用方写成 `npx.cmd` 之类；
 * - 子进程 stderr 只记录不解析（MCP 规范里 stdout 只放 JSON-RPC）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { bundledEnv, resolveMcpCommand } = require("./bundled-runtime");

/** 单条消息编码：MCP stdio 用换行分隔的 JSON-RPC。 */
function encodeMessage(obj) {
  return JSON.stringify(obj) + "\n";
}

/**
 * 从缓冲区里切出完整消息（纯函数，便于单测）：
 * 返回 `messages`（按行解析成功的 JSON）与 `rest`（最后一段不完整内容）。
 */
function extractMessages(buffer) {
  const parts = String(buffer).split("\n");
  const rest = parts.pop() ?? "";
  const messages = [];
  for (const line of parts) {
    const text = line.trim();
    if (!text) continue;
    try {
      messages.push(JSON.parse(text));
    } catch {
      // 非 JSON 行（服务端误写日志到 stdout）忽略，不影响后续消息
    }
  }
  return { messages, rest };
}

/** 命令合法性：非空、长度受限、不含换行（防止注入多行命令）。 */
function isValidCommand(command) {
  return typeof command === "string" && command.trim().length > 0 && command.length <= 512 && !/[\r\n]/.test(command);
}

function isValidArgs(args) {
  return (
    args === undefined ||
    (Array.isArray(args) && args.length <= 64 && args.every((a) => typeof a === "string" && a.length <= 1024))
  );
}

/**
 * 补全子进程的 PATH。
 *
 * 为什么需要：GUI 方式启动的 Electron 继承的是**启动时**的 PATH，
 * 而用户后装的工具（uv/uvx、npx 常在 D 盘或用户目录）往往不在其中。
 * 结果是 spawn 报 ENOENT，界面上只显示「连不上」，看不出是 PATH 问题。
 *
 * 这里把几个常见安装位置补进去（已存在的不重复加）：
 * - PATH 里已有的一切（不动）
 * - Python 的 Scripts 目录（uv/uvx/pipx 都装在这，版本化目录名也不同）
 * - node 的全局 bin 与 npm 全局前缀（npx）
 * - 用户的 .local\bin、.cargo\bin、.deno\bin（各类工具链默认位置）
 *
 * 只影响子进程的查找路径，不修改系统环境变量，也不放宽任何命令校验。
 */
function buildChildEnv(base) {
  const pathKey =
    Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = (base[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(current.map((p) => p.toLowerCase()));

  const home = base.USERPROFILE || base.HOME || "";
  const appData = base.APPDATA || "";
  const extras = [];

  // 版本化的 Python 安装目录：D:\Python314\Scripts、C:\Users\x\AppData\Local\Programs\Python\Python314\Scripts
  const driveRoot = process.env.SystemDrive || "C:";
  if (process.env.SystemRoot) {
    for (let minor = 30; minor >= 8; minor--) {
      extras.push(`${process.env.SystemRoot}\\Python${minor}\\Scripts`);
    }
  }
  extras.push(`${driveRoot}\\Python314\\Scripts`);
  extras.push(`${driveRoot}\\Python313\\Scripts`);
  extras.push(`${driveRoot}\\Python312\\Scripts`);
  if (appData) {
    for (const minor of [14, 13, 12, 11, 10]) {
      extras.push(
        `${appData}\\Local\\Programs\\Python\\Python${minor}\\Scripts`,
        `${appData}\\Local\\Programs\\Python\\Python${minor}\\Scripts`,
      );
    }
  }
  if (appData) {
    extras.push(`${appData}\\npm`, `${appData}\\npm\\node_modules\\.bin`);
  }
  if (home) {
    extras.push(
      `${home}\\.local\\bin`,
      `${home}\\.cargo\\bin`,
      `${home}\\.deno\\bin`,
      `${home}\\AppData\\Roaming\\npm`,
      `${home}\\scoop\\shims`,
    );
  }
  if (process.env.ProgramFiles) extras.push(`${process.env.ProgramFiles}\\nodejs`);
  if (process.env["ProgramFiles(x86)"]) {
    extras.push(`${process.env["ProgramFiles(x86)"]}\\nodejs`);
  }

  const additions = extras.filter((p) => {
    if (!p || seen.has(p.toLowerCase())) return false;
    seen.add(p.toLowerCase());
    // 目录不存在就别塞进去：留着无效路径只会让 PATH 变长、排查变难
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  return additions.length ? { ...base, [pathKey]: [...current, ...additions].join(path.delimiter) } : base;
}

/**
 * 创建桥实例。`spawn` 可注入（测试里用假的子进程）。
 *
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts: object) => any} deps.spawn
 * @param {number} [deps.timeoutMs] 单次请求超时
 * @param {() => number} [deps.now] 注入时钟（测试用）
 * @param {(...args: any[]) => void} [deps.log]
 */
function createStdioBridge({ spawn, timeoutMs = 30_000, now = () => Date.now(), log = () => {} }) {
  /** serverId → { child, buffer, nextId, pending } */
  const servers = new Map();

  const rejectAll = (entry, reason) => {
    for (const [, waiter] of entry.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    entry.pending.clear();
  };

  function start(serverId, config) {
    if (servers.has(serverId)) return servers.get(serverId);

    // 内置优先：预置里写的是 `uvx …`（开发态与降级时用），
    // 但打包后应指向包内的解释器与入口，用户无需装任何环境。
    // 这里按 serverId 重解析；解析不到就沿用原配置。
    const resolved = resolveMcpCommand({
      id: serverId,
      command: config?.command,
      args: config?.args,
    });
    const effective = resolved.bundled ? resolved : config;

    if (!isValidCommand(effective?.command)) throw new Error("stdio 启动命令不合法");
    if (!isValidArgs(effective?.args)) throw new Error("stdio 启动参数不合法");

    const child = spawn(effective.command, effective.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // bundledEnv 把内置运行时目录加进 PATH——
      // MCP 服务内部再调python/uv 时用的也是包内那份，版本才不会漂。
      //
      // buildChildEnv 仍然照跑：它补的是 uv/npx/python 这类**系统工具**的位置。
      // 内置服务虽然用不到它们，但用户自己在接口区加的 stdio 服务（如 npx 起的
      // filesystem）需要。省下那几次 existsSync 只有几毫秒，不值得为它加分支。
      env: buildChildEnv(bundledEnv({ ...process.env, ...(effective.env ?? {}) })),
    });
    const entry = { child, buffer: "", nextId: 1, pending: new Map() };
    servers.set(serverId, entry);

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => {
      entry.buffer += chunk;
      const { messages, rest } = extractMessages(entry.buffer);
      entry.buffer = rest;
      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        if (msg.id === undefined || msg.id === null) continue; // 通知：无需配对
        const waiter = entry.pending.get(msg.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        entry.pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(`${msg.error.message ?? "MCP 错误"}（code ${msg.error.code ?? "?"}）`));
        } else {
          waiter.resolve(msg.result);
        }
      }
    });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[mcp:${serverId}] ${text.slice(0, 500)}`);
    });
    child.on("exit", (code, signal) => {
      servers.delete(serverId);
      rejectAll(entry, `MCP 进程已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`);
    });
    child.on("error", (err) => {
      servers.delete(serverId);
      rejectAll(entry, `MCP 进程启动失败：${err.message}`);
    });
    return entry;
  }

  /**
   * 发一条 JSON-RPC 请求并等响应。
   * `config` 只在首次调用时用于拉起进程；已存在则忽略。
   */
  function request(serverId, config, method, params) {
    let entry = servers.get(serverId);
    if (!entry) entry = start(serverId, config);
    const id = entry.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new Error(`MCP stdio 请求超时（${Math.round(timeoutMs / 1000)}s）：${method}`));
      }, timeoutMs);
      entry.pending.set(id, { resolve, reject, timer, startedAt: now() });
      try {
        entry.child.stdin.write(encodeMessage(message));
      } catch (err) {
        clearTimeout(timer);
        entry.pending.delete(id);
        reject(new Error(`写入 MCP 进程失败：${err.message}`));
      }
    });
  }

  /** 只发通知（无响应），如 `notifications/initialized`。 */
  function notify(serverId, config, method, params) {
    let entry = servers.get(serverId);
    if (!entry) entry = start(serverId, config);
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    entry.child.stdin.write(encodeMessage(message));
  }

  function stop(serverId) {
    const entry = servers.get(serverId);
    if (!entry) return false;
    servers.delete(serverId);
    rejectAll(entry, "MCP 进程已被停止");
    try {
      entry.child.kill();
    } catch {
      /* 已退出 */
    }
    return true;
  }

  function disposeAll() {
    for (const id of [...servers.keys()]) stop(id);
  }

  function running() {
    return [...servers.keys()];
  }

  return { start, request, notify, stop, disposeAll, running };
}

module.exports = { createStdioBridge, encodeMessage, extractMessages, isValidCommand, isValidArgs };
