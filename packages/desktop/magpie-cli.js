"use strict";
/**
 * 模型页 ↔ 内核的命令桥（d.99）。
 *
 * 「模型」页要完整复刻 magpie 的能力，但那些能力（供应商、订阅账号、分组路由、用量、
 * 库、备份、同步…）都实现在内核的 CLI 里。与其在 JS 里重写一遍，不如让页面通过主进程
 * 调用**我们自己的内核**：同一份能力、同一套校验、升级上游即自动获得新功能。
 *
 * 安全边界：
 * - 只允许白名单里的子命令（`magpie:cli` 的 argv[0]）——`uninstall`、`serve`、agent 改写
 *   这类危险/与页面无关的命令一律拒绝；
 * - 参数按数组传给 spawn，**不经过 shell**，因此不存在命令注入；
 * - 子进程继承内核路径解析（与托管同一个二进制），带超时与整树回收；
 * - stdout/stderr 逐块回流给页面（OAuth 登录、长输出不必等结束）。
 */

const ALLOWED_COMMANDS = new Set([
  "providers",
  "presets",
  "provider",
  "import",
  "models",
  "model",
  "visible",
  "search",
  "groups",
  "group",
  "accounts",
  "library",
  "backup",
  "restore",
  "webdav",
  "s3",
  "github",
  "usage",
  "settings",
  "profiles",
  "save",
  "use",
  "rename",
  "rm",
  "ls",
  "sessions",
  "gateway-key",
]);

/**
 * 可以改模型的本机智能体（magpie 的 agent 命令）。
 *
 * 只开放「查看 / 设模型 / 恢复默认」三种形态——这些命令会改本机其他 CLI 的配置，
 * 不能把 magpie 的全部 agent 字段编辑透出去玩；模型 id 也只接受安全字符。
 */
const AGENT_COMMANDS = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor",
  "copilot",
  "antigravity",
  "opencode",
  "mimo",
  "qoder",
  "workbuddy",
  "dsh",
  "crush",
  "goose",
  "cline",
  "droid",
  "devin",
  "pi",
  "raft",
  "atomcode",
  "commandcode",
  "codebuddy",
  "kiro",
]);

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,200}$/;

/** 交互式命令（需要用户输入/浏览器 OAuth），走「真终端」打开。 */
const INTERACTIVE = [
  { cmd: "accounts", sub: "add" },
  { cmd: "backup" },
  { cmd: "restore" },
];

/**
 * 校验一次调用：argv[0] 必须在白名单里，且参数里不能有 NUL。
 * 返回 `{ ok, reason }`，reason 直接展示给页面。
 */
function validateCliArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, reason: "缺少命令" };
  }
  if (args.length > 64) {
    return { ok: false, reason: "参数过多" };
  }
  for (const arg of args) {
    if (typeof arg !== "string") return { ok: false, reason: "参数必须是字符串" };
    if (arg.includes("\0")) return { ok: false, reason: "参数不能包含 NUL" };
    if (arg.length > 4000) return { ok: false, reason: "参数过长" };
  }
  const head = args[0];
  if (AGENT_COMMANDS.has(head)) {
    // 查看一个智能体
    if (args.length === 1) return { ok: true };
    // <agent> default：断开 magpie，恢复该智能体原来的模型
    if (args.length === 2 && args[1] === "default") return { ok: true };
    // <agent> <provider/model>：设模型
    if (args.length === 2 && MODEL_ID.test(args[1])) return { ok: true };
    return {
      ok: false,
      reason: "智能体命令只支持：查看、<智能体> <模型>、<智能体> default",
    };
  }
  if (!ALLOWED_COMMANDS.has(head)) {
    return { ok: false, reason: `不允许的命令：${head}（模型页只开放管理命令）` };
  }
  return { ok: true };
}

/** 是否需要真终端（交互式登录/备份口令）。 */
function needsTerminal(args) {
  const [head, sub] = args;
  if (head === "accounts" && sub === "add") return true;
  if (head === "backup" || head === "restore") return true;
  return false;
}

/** 给 `cmd /c start` 拼命令：只允许安全字符，避免壳注入。 */
function quoteForCmd(args) {
  const safe = /^[A-Za-z0-9_\-.:/\\=,@%+~ ]*$/;
  return args.map((arg) => {
    if (!safe.test(arg)) throw new Error(`参数含不安全字符：${arg}`);
    return /\s/.test(arg) ? `"${arg}"` : arg;
  });
}

/** 生成给可见终端窗口执行的完整命令串。 */
function terminalCommand(binaryPath, args) {
  const parts = [binaryPath, ...args];
  if (!quoteForCmd(parts)) throw new Error("unreachable");
  return parts
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

/**
 * 创建运行器。spawn/webContents 可注入，便于单测。
 */
function createMagpieCli(opts) {
  const {
    spawn,
    binaryPath,
    send,
    timeoutMs = 120_000,
    maxChunkBytes = 16_384,
    log = () => {},
  } = opts || {};
  const runs = new Map();
  let seq = 0;

  const emit = (runId, type, payload) => {
    try {
      send?.({ runId, type, ...payload });
    } catch (err) {
      log(`[magpie-cli] 事件发送失败：${err?.message ?? err}`);
    }
  };

  /** 启动一次命令；返回 runId（供页面配对事件）与 done（命令结束时 resolve）。 */
  function launch(args, { stdin = false, timeout = timeoutMs } = {}) {
    const checked = validateCliArgs(args);
    if (!checked.ok) {
      return { ok: false, error: checked.reason, done: Promise.resolve({ ok: false, error: checked.reason }) };
    }
    const runId = `cli-${++seq}`;
    const done = new Promise((resolve) => {
      let child;
      try {
        child = spawn(binaryPath, args, {
          windowsHide: true,
          stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({ ok: false, error: `无法启动内核：${err?.message ?? err}` });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        runs.delete(runId);
        clearTimeout(timer);
        emit(runId, "exit", { code: result.code ?? null, ok: result.ok === true, error: result.error });
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        finish({ ok: false, error: `命令超时（${Math.round(timeout / 1000)}s）`, stdout, stderr });
      }, timeout);
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        if (stdout.length < maxChunkBytes * 64) stdout += text;
        emit(runId, "stdout", { text });
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        if (stderr.length < maxChunkBytes * 16) stderr += text;
        emit(runId, "stderr", { text });
      });
      child.on("error", (err) => finish({ ok: false, error: err?.message ?? String(err), stdout, stderr }));
      child.on("exit", (code) => finish({ ok: code === 0, code, stdout, stderr }));
      runs.set(runId, child);
      emit(runId, "start", { args });
    });
    return { ok: true, runId, done };
  }

  function run(args, opts) {
    return launch(args, opts).done;
  }

  function start(args, opts = {}) {
    return run(args, { ...opts, stdin: opts.stdin ?? true });
  }

  /** 交互式命令：立刻返回 runId，页面按事件配对，输入经 input 写回。 */
  function begin(args, opts = {}) {
    const launched = launch(args, { ...opts, stdin: opts.stdin ?? true });
    if (!launched.ok) return { ok: false, error: launched.error };
    return { ok: true, runId: launched.runId };
  }

  function input(runId, text) {
    const child = runs.get(runId);
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(String(text));
      return true;
    } catch {
      return false;
    }
  }

  function kill(runId) {
    const child = runs.get(runId);
    if (!child) return false;
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    runs.delete(runId);
    return true;
  }

  return {
    run,
    start,
    begin,
    input,
    kill,
    validateCliArgs,
    needsTerminal,
    terminalCommand,
    agents: () => [...AGENT_COMMANDS],
    activeRuns: () => [...runs.keys()],
  };
}

module.exports = {
  AGENT_COMMANDS,
  ALLOWED_COMMANDS,
  INTERACTIVE,
  validateCliArgs,
  needsTerminal,
  quoteForCmd,
  terminalCommand,
  createMagpieCli,
};
