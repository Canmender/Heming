/**
 * 本机命令执行桥（d.164 · `run_command`）。
 *
 * 为什么单独一个文件、还要单独一个 IPC 命名空间：
 * 文件桥的信任模型是「只能写用户显式给的可写根」；命令的信任模型是「**什么都能做**」，
 * 两者不能共用一个入口——共用之后任何一个「只检查路径」的疏漏都会变成任意代码执行。
 *
 * 所以这个模块的防线是四层，缺一层都不成立：
 * 1. 只认主窗口来源（`isTrustedSender`，fail-closed，与 file-fs 一致）；
 * 2. 工作目录必须在**可写根**内，且不是软链、真实存在、是目录；
 * 3. 有超时（默认 30s、上限 120s）与输出上限（512KB 采集、超出即杀），被杀时**杀进程树**，
 *    不留孤儿进程在后台继续跑；
 * 4. 不接 shell 拆分/管道的「智能解析」：命令原样交给系统的命令解释器
 *    （Windows `cmd.exe /d /s /c`、其它平台 `/bin/sh -c`）。这是刻意的：
 *    自己解析命令行只会多出一层「解释器差异」的漏洞，而用户已经在 HITL 上看过原文。
 *
 * 渲染层拿不到 pid、也不能指定解释器或环境变量——它只能给「根清单 + 工作目录 + 命令 + 超时」。
 */

const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { normalizeRoots } = require("./file-fs.js");
const { isInsideRoot, checkAbsoluteInside, assertNoSymlinkAncestor } = require("./path-guard.js");

/** 采集上限：超过就杀进程并回 too-large（比「截断后当成功」更安全：调用方会知道它没跑完）。 */
const MAX_CAPTURE_BYTES = 512 * 1024;

/** 命令长度上限（与 web 侧 `SHELL_MAX_COMMAND_CHARS` 同一口径，主进程不信任渲染层的校验）。 */
const MAX_COMMAND_CHARS = 2000;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;

/** 一次只跑一条命令：并发命令的输出交错在 HITL 与 UI 上都难以解释，也让超时语义变乱。 */
let runQueue = Promise.resolve();
function enqueue(task) {
  const run = runQueue.then(() => task());
  runQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function fail(code, error) {
  return { ok: false, code, error };
}

/**
 * 在跑的命令：runId → 中止函数（d.165）。
 *
 * 为什么要有这张表：`ipcRenderer.invoke` 没有 abort，用户点「停止」时渲染层
 * 只能另发一条 `shell:cancel`；主进程据此找到子进程并杀掉。
 */
const running = new Map();

/** 排到队列里但还没开始的取消请求（在 await 校验目录期间用户就可能点停止）。 */
const pendingCancel = new Set();
const MAX_PENDING_CANCEL = 50;

/** 没有 runId 的调用方（测试/内部）也能跑，只是取消不了它。 */
let localSeq = 0;

/**
 * 取消一条在跑或排队中的命令。
 *
 * @param {string} runId
 * @returns {{ok:boolean,code?:string,error?:string}}
 */
function cancelRun(runId) {
  const id = typeof runId === "string" ? runId.trim() : "";
  if (!id) return fail("unknown-run", "缺少 runId");
  const abort = running.get(id);
  if (abort) {
    abort();
    return { ok: true };
  }
  // 还没开始（在队列里或在校验目录）：记下来，等它真正要 spawn 时立刻放弃。
  if (pendingCancel.size < MAX_PENDING_CANCEL) pendingCancel.add(id);
  return { ok: true };
}

/**
 * 校验工作目录：必须在某个**可写根**内（根自身也算），且不是软链、是目录。
 *
 * @returns {Promise<{ok:true,cwd:string}|{ok:false,code:string,error:string}>}
 */
async function resolveWorkingDir(roots, rawCwd) {
  if (!Array.isArray(roots) || roots.length === 0) return fail("no-roots", "尚未配置任何根目录");
  if (!roots.some((root) => root.mode === "write")) {
    return fail("no-write-root", "没有可写根，命令无法确定工作目录（请在设置区添加一个可写根）");
  }
  if (typeof rawCwd !== "string" || !rawCwd.trim()) {
    return fail("outside-roots", "命令必须带一个绝对工作目录");
  }
  const raw = rawCwd.trim();
  if (raw.includes("\0")) return fail("outside-roots", "工作目录含非法字符（NUL）");
  if (!path.isAbsolute(raw)) return fail("outside-roots", "工作目录必须是绝对路径");

  // 选最长前缀的写根：嵌套根时以更具体的那个为准
  let root = null;
  const absKey = path.resolve(raw).toLowerCase();
  for (const item of roots) {
    if (item.mode !== "write") continue;
    const key = path.resolve(item.path).toLowerCase();
    if (key !== absKey && !isInsideRoot(item.path, path.resolve(raw))) continue;
    if (!root || item.path.length > root.path.length) root = item;
  }
  if (!root) return fail("outside-roots", `工作目录不在任何可写根内：${path.resolve(raw)}`);

  const abs = path.resolve(raw);
  const rootKey = path.resolve(root.path).toLowerCase();
  // 根自身合法；子目录再走一次绝对路径包含检查（checkAbsoluteInside 把「等于根」算作不合格，
  // 那是给文件路径用的语义——目录可以就是根本身）。
  if (absKey !== rootKey) {
    const checked = checkAbsoluteInside(abs, root.path);
    if (!checked.ok) return fail("outside-roots", `${checked.error}：${abs}`);
  }

  let stat = null;
  try {
    stat = await fsp.lstat(abs);
  } catch (e) {
    return fail("outside-roots", `工作目录不存在或不可访问：${abs}`);
  }
  if (stat.isSymbolicLink()) return fail("outside-roots", `工作目录是符号链接，已拒绝：${abs}`);
  if (!stat.isDirectory()) return fail("outside-roots", `工作目录不是目录：${abs}`);
  if (absKey !== path.resolve(root.path).toLowerCase()) {
    const link = assertNoSymlinkAncestor(root.path, abs);
    if (!link.ok) return fail("outside-roots", `${link.error}：${abs}`);
  }
  return { ok: true, cwd: abs };
}

/**
 * 杀进程树。
 *
 * Windows 上 `child.kill()` 只杀掉 cmd.exe，它拉起来的 node/git 会变成孤儿；
 * 用 `taskkill /t /f` 按 pid 整棵树杀——这是唯一能保证「超时就真停」的做法。
 */
function killTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  // 先停直接子进程：这一步同步生效，保证「调用返回前它已经不在跑」；
  // 再补一刀杀整棵树（Windows 上 cmd.exe 拉起的 node/git 不会跟着死）。
  try {
    child.kill("SIGKILL");
  } catch {
    /* 进程可能已经退出 */
  }
  try {
    if (process.platform === "win32" && pid) {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
      killer.on("error", () => {
        /* taskkill 不可用（精简系统/测试桩）：直接子进程已经停掉，这里不升级成失败 */
      });
    }
  } catch {
    /* 同上 */
  }
}

/**
 * 执行一条命令。
 *
 * @param {object} params
 * @param {Array<{name?:string,path:string,mode:string}>} params.roots 可写根清单（渲染层给，主进程重新校验）
 * @param {string} params.cwd 绝对工作目录
 * @param {string} params.command 原始命令
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal] 渲染层断开时中止
 * @param {Function} [params.spawnImpl] 测试注入
 * @returns {Promise<object>}
 */
async function runCommand(params, spawnImpl = spawn) {
  const roots = normalizeRoots(params && params.roots);
  const command = typeof (params && params.command) === "string" ? params.command.trim() : "";
  if (!command) return fail("invalid-command", "命令不能为空");
  if (command.includes("\0")) return fail("invalid-command", "命令里含非法字符（NUL）");
  if (command.length > MAX_COMMAND_CHARS) {
    return fail("invalid-command", `命令过长（${command.length} 字符，上限 ${MAX_COMMAND_CHARS}）`);
  }

  // 渲染层会给 runId；缺省时自己造一个（老调用方/测试），只是无法被 cancel 定向取消。
  const runId =
    typeof (params && params.runId) === "string" && params.runId.trim()
      ? params.runId.trim()
      : `local-${Date.now().toString(36)}-${localSeq++}`;

  const rawTimeout = params && params.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
      ? Math.min(Math.max(Math.floor(rawTimeout), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const dir = await resolveWorkingDir(roots, params && params.cwd);
  if (!dir.ok) return dir;

  // 校验目录期间用户可能已经点了停止：排队中的取消请求在这里消费掉。
  if (pendingCancel.delete(runId)) {
    return fail("aborted", "命令在执行前被取消");
  }

  // 用 Node 的 `shell: true`（Windows = ComSpec，Unix = /bin/sh）而不是自己拼
  // `cmd.exe /d /s /c "<命令>"`：命令里带引号是常态（`node -e "console.log(1)"`），
  // 自己拼参数时 cmd 的 /s 会吃掉一层引号——实测 `node -e "…"` 静默退出 0、输出为空，
  // 看起来「执行成功」其实什么都没跑。这件事由 d.165 的评测用例 cmd-001 抓出来。
  // `shell: true` 由 Node 负责给整条命令加引号，跨平台语义一致。
  return enqueue(
    () =>
      new Promise((resolve) => {
        const startedAt = Date.now();
        let child = null;
        let settled = false;
        let captured = 0;
        let truncated = false;
        const out = [];
        const err = [];

        const finish = (result) => {
          if (settled) return;
          settled = true;
          running.delete(runId);
          clearTimeout(timer);
          if (params && params.signal && typeof params.signal.removeEventListener === "function") {
            params.signal.removeEventListener("abort", onAbort);
          }
          resolve(result);
        };

        const tooBig = () => {
          truncated = true;
          killTree(child);
          finish(fail("too-large", `命令输出超过 ${MAX_CAPTURE_BYTES} 字节上限，已终止`));
        };

        const collect = (chunks) => (data) => {
          if (settled) return;
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          captured += buf.length;
          if (captured > MAX_CAPTURE_BYTES) {
            tooBig();
            return;
          }
          chunks.push(buf);
        };

        let timer = null;
        function onAbort() {
          killTree(child);
          finish(fail("aborted", "渲染层已断开，命令被中止"));
        }

        // 排队期间被取消：不再 spawn，直接收口（否则用户点了停止，命令还是跑起来了）。
        // 必须放在 `timer` 初始化之后：finish 会 clearTimeout(timer)，提前调用会踩 TDZ。
        if (pendingCancel.delete(runId)) {
          finish(fail("aborted", "命令在执行前被取消"));
          return;
        }

        try {
          child = spawnImpl(command, {
            cwd: dir.cwd,
            windowsHide: true,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
          });
        } catch (e) {
          finish(fail("spawn-failed", `无法启动命令解释器：${e && e.message ? e.message : String(e)}`));
          return;
        }

        // spawn 成功后才可被 `shell:cancel` 定向取消（spawn 前只能靠 pendingCancel）。
        running.set(runId, onAbort);

        if (params && params.signal) {
          if (params.signal.aborted) {
            onAbort();
            return;
          }
          if (typeof params.signal.addEventListener === "function") {
            params.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        timer = setTimeout(() => {
          killTree(child);
          finish(fail("timeout", `命令超过 ${timeoutMs}ms 未结束，已终止（可能是交互式命令或在等输入）`));
        }, timeoutMs);

        child.stdout.on("data", collect(out));
        child.stderr.on("data", collect(err));
        child.on("error", (e) => {
          finish(fail("spawn-failed", `启动命令失败：${e && e.message ? e.message : String(e)}`));
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          finish({
            ok: true,
            exitCode: typeof code === "number" ? code : null,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            truncated,
            durationMs: Date.now() - startedAt,
            cwd: dir.cwd.replace(/\\/g, "/"),
            ...(signal ? { signal } : {}),
          });
        });
      }),
  );
}

/**
 * 注册 `shell:run`。
 *
 * @param {object} ipcMain
 * @param {object} deps
 * @param {(event:any)=>boolean} [deps.isTrustedSender]
 * @param {Function} [deps.spawnImpl] 测试注入
 */
function registerShellIpc(ipcMain, deps) {
  const isTrustedSender = (deps && deps.isTrustedSender) || (() => false);
  const spawnImpl = (deps && deps.spawnImpl) || spawn;
  const untrusted = { ok: false, code: "untrusted-sender", error: "未授权的调用来源" };

  ipcMain.handle("shell:run", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      return await runCommand(payload || {}, spawnImpl);
    } catch (e) {
      return fail("io", `命令执行失败：${e && e.message ? e.message : String(e)}`);
    }
  });

  // 取消在跑/排队中的命令：只杀掉这次调用发起的那一条，不碰别的会话。
  ipcMain.handle("shell:cancel", (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const runId = payload && typeof payload === "object" ? payload.runId : payload;
      return cancelRun(runId);
    } catch (e) {
      return fail("io", `取消失败：${e && e.message ? e.message : String(e)}`);
    }
  });
}

module.exports = {
  registerShellIpc,
  runCommand,
  cancelRun,
  resolveWorkingDir,
  killTree,
  MAX_CAPTURE_BYTES,
  MAX_COMMAND_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
