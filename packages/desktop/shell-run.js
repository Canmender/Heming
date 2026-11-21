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
 *
 * d.180 追加「后台作业」：长命令（构建、装依赖、跑全量测试）不能靠前台 120s 超时去等，
 * 于是多了一条 `shell:run` 的 `background:true` 分支与 `shell:jobs` / `shell:job-output` /
 * `shell:job-kill` 三个通道。信任模型与前缀完全一致：同一套可写根校验、同一个 fail-closed
 * 来源检查；区别只在「结果怎么取」——后台作业的输出先缓在内存里，由渲染层按需增量拉取。
 */

const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { normalizeRoots } = require("./file-fs.js");
const { isInsideRoot, checkAbsoluteInside, assertNoSymlinkAncestor } = require("./path-guard.js");

/* ─────────────────────────── 命令输出解码（d.228） ─────────────────────────── */

/**
 * 命令输出的解码。
 *
 * Windows 控制台的默认代码页是 936（GBK）：`cmd` 的内建命令（dir / type / tree）、
 * 以及大量没有改过输出编码的老工具，吐出来的就是 GBK 字节。按 UTF-8 硬解会把中文
 * 变成一片「�」——用户看到的是「它跑了个 dir，输出全是乱码」，比报错更让人不敢用。
 *
 * 三步走：UTF-8 严解 → GBK 严解 → UTF-8 容错。前两步都要求整段合法（`fatal: true`），
 * 所以一段正常的 UTF-8 中文不会被误读成 GBK（反过来也一样：GBK 中文在 UTF-8 下
 * 几乎必然非法）。第三步只在两种编码都不成立时兜底，宁可少量乱码也不抛异常。
 *
 * 不做「按行猜编码」：同一段输出里混两种编码极罕见，而按行猜会让截断位置与真实
 * 字节错位，输出的每一行都可能对不上。
 */
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
let gbkStrict = null;
let gbkUnavailable = false;

/**
 * 命令输出里的「终端痕迹」整形（d.231）。
 *
 * 命令的输出本来是打给终端看的：`npm`/`git`/构建工具会夹 ANSI 颜色与光标控制，
 * 进度条则用 `\r` 回到行首反复改写同一行。这些字节落到工具结果里就是纯噪声：
 *
 * - 界面上显示成 `[32m` `[0m` `[2K` 这种鬼东西，用户以为输出坏了；
 * - 模型看到一堆转义序列，判断「这一步是否通过」时要先把它过滤掉，等于白烧 token；
 * - 进度条那一行被拼成 `10%\r50%\r100%` 长串，谁都读不出来。
 *
 * 这里做两件事，都是「终端本来就会做」的等价处理，不改变输出事实：
 * ① 去掉 ANSI 转义（颜色 / 光标 / 擦除 / 窗口标题）；
 * ② 含 `\r` 的行只保留最后一段（终端上它就是覆盖显示的最终样子）。
 *
 * 明确不做：合并重复行、丢掉空行、按宽度折行——那些会改动输出内容本身。
 */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
function shapeTerminalText(input) {
  if (typeof input !== "string" || input === "") return "";
  let text = input.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
  // 零散的控制序列与退格（进度条擦字符时会发）
  text = text.replace(/\u001b[@-_]/g, "").replace(/\u0008/g, "");
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      const last = parts[parts.length - 1];
      // `"…\r"`：光标回到行首后没再写，终端上留下的是前一段
      return last === "" ? (parts[parts.length - 2] ?? "") : last;
    })
    .join("\n");
}

function decodeCommandOutput(chunks) {
  const buffer = Buffer.isBuffer(chunks) ? chunks : Buffer.concat(chunks);
  if (buffer.length === 0) return "";
  // 去掉 UTF-8 BOM：PowerShell 重定向出来的文件与部分构建工具会带
  const body =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
  try {
    return shapeTerminalText(utf8Strict.decode(body));
  } catch {
    /* 不是合法 UTF-8：往下试 GBK */
  }
  if (!gbkUnavailable) {
    try {
      if (gbkStrict === null) gbkStrict = new TextDecoder("gbk", { fatal: true });
    } catch {
      // 运行时没带完整 ICU：GBK 解不了，直接退回容错解码
      gbkUnavailable = true;
      return shapeTerminalText(body.toString("utf8"));
    }
    try {
      return shapeTerminalText(gbkStrict.decode(body));
    } catch {
      /* 也不是合法 GBK：退回容错解码 */
    }
  }
  return shapeTerminalText(body.toString("utf8"));
}

/** 采集上限：超过就杀进程并回 too-large（比「截断后当成功」更安全：调用方会知道它没跑完）。 */
const MAX_CAPTURE_BYTES = 512 * 1024;

/** 命令长度上限（与 web 侧 `SHELL_MAX_COMMAND_CHARS` 同一口径，主进程不信任渲染层的校验）。 */
const MAX_COMMAND_CHARS = 2000;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;

/* ─────────────────────────── 后台作业常量（d.180） ─────────────────────────── */

/** 已完成作业的保留上限：只留最近 20 个，避免长会话里 jobs 表无限增长（每个最多 1MB 输出）。 */
const MAX_BACKGROUND_JOBS = 20;

/** 单个作业的未读输出上限：超出后丢最旧字节并累计 dropped（后台作业不能像前台那样「超了就杀」）。 */
const MAX_JOB_BYTES = 512 * 1024;

/** 作业硬上限 30 分钟：到点杀进程树并标记结束，避免忘记收尾的作业在后台跑一整天。 */
const MAX_JOB_MS = 30 * 60 * 1000;

/** `shell:job-output` 的最长等待：渲染层可以等到作业结束，但一次调用最多挂 30s。 */
const MAX_JOB_WAIT_MS = 30_000;

/** `shell:job-preview` 单次预览的上限：够看清最后几行报错，又不至于把 512KB 全搬过去。 */
const MAX_JOB_PREVIEW_BYTES = 16 * 1024;

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

/**
 * 由**用户点「停止」**触发的取消（d.230）。
 *
 * 为什么单独记：`onAbort` 同时服务两种来源——用户主动取消、渲染层断开（窗口关闭/崩溃）。
 * 两者的收场文案必须不同：断连时说「渲染层已断开」是事实，用户主动停还这么说就是在甩锅。
 */
const userCancelled = new Set();
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
    userCancelled.add(id);
    abort();
    return { ok: true };
  }
  // 还没开始（在队列里或在校验目录）：记下来，等它真正要 spawn 时立刻放弃。
  // 上限满了淘汰最早的一条，而不是拒绝记录后还谎报 ok:true——否则一旦攒够
  // 一批永不落地的陈旧取消（重复点停、结束后才取消、目录校验失败早退），
  // 后续真正「spawn 前取消」会被静默丢弃，HITL 中止保证就没了。
  if (pendingCancel.size >= MAX_PENDING_CANCEL) {
    const oldest = pendingCancel.values().next().value;
    if (oldest !== undefined) pendingCancel.delete(oldest);
  }
  pendingCancel.add(id);
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
 * 校验命令文本（前台与后台共用）。
 *
 * 为什么抽出来：后台作业只是「换一种等待方式」，不能因为不等结果就让非法命令
 * 绕过主进程的校验——渲染层的校验永远只算提示，主进程必须再判一次。
 *
 * @param {object} params
 * @returns {{ok:true,command:string}|{ok:false,code:string,error:string}}
 */
function normalizeCommand(params) {
  const command = typeof (params && params.command) === "string" ? params.command.trim() : "";
  if (!command) return fail("invalid-command", "命令不能为空");
  if (command.includes("\0")) return fail("invalid-command", "命令里含非法字符（NUL）");
  if (command.length > MAX_COMMAND_CHARS) {
    return fail("invalid-command", `命令过长（${command.length} 字符，上限 ${MAX_COMMAND_CHARS}）`);
  }
  return { ok: true, command };
}

/**
 * 取本次调用的 runId：渲染层会给（用于 `shell:cancel` 定向取消），缺省时自己造一个。
 *
 * 为什么后台也要它：`pendingCancel` 的「校验目录期间被取消」语义对后台同样成立——
 * 后台没有串行队列，取消窗口只有 resolveWorkingDir 的那几毫秒，但存在就得处理。
 *
 * @param {object} params
 * @returns {string}
 */
function deriveRunId(params) {
  return typeof (params && params.runId) === "string" && params.runId.trim()
    ? params.runId.trim()
    : `local-${Date.now().toString(36)}-${localSeq++}`;
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
  const checked = normalizeCommand(params);
  if (!checked.ok) return checked;
  const command = checked.command;

  const runId = deriveRunId(params);

  const rawTimeout = params && params.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
      ? Math.min(Math.max(Math.floor(rawTimeout), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const dir = await resolveWorkingDir(roots, params && params.cwd);
  if (!dir.ok) {
    // 这条命令永远不会 spawn；它没有消费掉的预取消要清掉，
    // 否则会变成永久占位、挤占 MAX_PENDING_CANCEL（d.412 回归）。
    pendingCancel.delete(runId);
    return dir;
  }

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
          userCancelled.delete(runId);
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
          // 先取原因再收口：finish 会清掉 userCancelled。
          const byUser = userCancelled.has(runId);
          killTree(child);
          finish(
            fail(
              "aborted",
              byUser
                ? "命令已被取消：已请求终止整个进程树（含它启动的子进程）"
                : "渲染层已断开，命令被中止",
            ),
          );
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
            stdout: decodeCommandOutput(out),
            stderr: decodeCommandOutput(err),
            truncated,
            durationMs: Date.now() - startedAt,
            cwd: dir.cwd.replace(/\\/g, "/"),
            ...(signal ? { signal } : {}),
          });
        });
      }),
  );
}

/* ─────────────────────────── 后台命令作业（d.180） ─────────────────────────── */

/**
 * 后台作业表：jobId → job（字段见契约 typedef）。
 *
 * 为什么放在模块级：一个作业的生命周期跨越多条 IPC（启动 / 轮询 / 杀掉），
 * 渲染层只在启动时拿到 jobId，之后每次调用都靠它回表；没有这张表，
 * 后台作业就只能靠「一条 invoke 一直挂着」，那又退化成前台调用了。
 */
const jobs = new Map();

let jobSeq = 0;

/**
 * 生成 jobId。
 *
 * 为什么不复用 runId：前台 runId 由渲染层给、可以重复；作业表的键必须由主进程发，
 * 且不能与历史 job 撞车（否则轮询会读到别人的输出）。
 */
function makeJobId() {
  jobSeq += 1;
  return `job-${Date.now().toString(36)}-${jobSeq.toString(36)}`;
}

/** 当前未读缓冲里某条流的字节数（chunk 数很少，线性求和足够）。 */
function bufferedBytes(job, stream) {
  let total = 0;
  for (const buf of job[stream]) total += buf.length;
  return total;
}

/**
 * 把未读缓冲裁到 MAX_JOB_BYTES 以内。
 *
 * 为什么丢「最旧」而不是「拒绝新数据」：后台作业没人等结果，拒绝新数据会让用户
 * 永远看不到最后（也是最关心的报错）；丢开头只是损失历史，并在 dropped 里如实记账。
 * stdout/stderr 是两条管道、没有可靠的全局先后，所以每轮先丢当前更大的那条流的最旧
 * chunk（必要时 subarray 部分丢弃），保证总内存一定收敛到上限。
 */
function trimJobBuffer(job) {
  while (job.captured > MAX_JOB_BYTES) {
    const outBytes = bufferedBytes(job, "stdout");
    const errBytes = bufferedBytes(job, "stderr");
    const stream = outBytes >= errBytes ? "stdout" : "stderr";
    const list = job[stream];
    if (list.length === 0) break;
    const overflow = job.captured - MAX_JOB_BYTES;
    const first = list[0];
    const drop = Math.min(first.length, overflow);
    if (drop >= first.length) list.shift();
    else list[0] = first.subarray(drop);
    job.captured -= drop;
    job.dropped += drop;
    job.truncated = true;
  }
}

/**
 * 收一块输出：追加进未读缓冲、记账、按上限裁剪。
 *
 * 「未读缓冲」是后台作业增量的核心：读走的部分直接从数组里拿掉并清零 captured，
 * 所以 `shell:job-output` 天然只返回「自上次读取以来」的字节——不需要额外维护读游标，
 * 也不会因为重复读把同一段输出再回放一遍。
 */
function appendJobChunk(job, stream, data) {
  if (!job.running) return;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (buf.length === 0) return;
  job[stream].push(buf);
  job.produced += buf.length;
  job.captured += buf.length;
  trimJobBuffer(job);
}

/** 唤醒所有正在等「作业结束」的调用（readJobOutput 的 waitMs 分支）。 */
function wakeJobWaiters(job) {
  for (const wake of Array.from(job.waiters)) {
    try {
      wake();
    } catch {
      /* 单个等待者出错不影响其它人 */
    }
  }
}

/**
 * 等作业结束，最多 waitMs 毫秒。
 *
 * 为什么是「登记一个唤醒函数 + 定时器」而不是每作业一个常驻 Promise：
 * 每次 `shell:job-output` 都可能带自己的 waitMs，登记/摘除最省状态，
 * 也不会出现等待者泄漏（超时分支必须自己清理）。
 */
function waitForJobFinish(job, waitMs) {
  if (!job.running) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const wake = () => {
      job.waiters.delete(wake);
      if (timer) clearTimeout(timer);
      resolve();
    };
    job.waiters.add(wake);
    // 这个定时器不能 unref：等待方正依赖它把 Promise 叫醒，unref 后若无别的句柄，
    // Node 会直接退出，等待永远不落定。
    timer = setTimeout(wake, waitMs);
  });
}

/**
 * 收尾一个作业：置结束状态、清硬上限定时器、唤醒等待者、按需淘汰旧作业。
 *
 * 为什么幂等：`close`、`error`、30 分钟硬超时三条路径都可能先到，谁先到谁收尾，
 * 后来者直接返回——否则 exitCode/finishedAt 会被后到的信号覆盖。
 */
function finishJob(job, exitCode, signal) {
  if (!job.running) return;
  job.running = false;
  job.finishedAt = Date.now();
  job.exitCode = typeof exitCode === "number" ? exitCode : null;
  if (signal) job.signal = signal;
  job.child = null;
  if (job.lifespan) {
    clearTimeout(job.lifespan);
    job.lifespan = null;
  }
  wakeJobWaiters(job);
  evictFinishedJobs();
}

/**
 * 淘汰已完成作业：按 finishedAt 从旧到新删，只留最近 MAX_BACKGROUND_JOBS 个。
 *
 * 为什么不动在跑的：跑着的作业正在被轮询，删掉会让用户突然拿到 unknown-job。
 */
function evictFinishedJobs() {
  const finished = [];
  for (const job of jobs.values()) if (!job.running) finished.push(job);
  if (finished.length <= MAX_BACKGROUND_JOBS) return;
  finished.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  for (let i = 0; i < finished.length - MAX_BACKGROUND_JOBS; i += 1) {
    jobs.delete(finished[i].id);
  }
}

/**
 * 启动一条后台作业并立刻返回。
 *
 * 为什么**不进 `enqueue` 串行队列**：串行队列是给前台命令用的——前台一次一条，
 * 是为了超时语义清楚、输出不交错；后台作业恰恰要在用户继续用应用时跑，如果也排进
 * 同一个队列，一条 10 分钟的构建会把之后所有前台命令堵死。更关键的是：enqueue 的
 * Promise 要等到 close 才 settle，前台 `shell:run` 就会等后台作业结束才返回，
 * 「后台」就变成了「更慢的前台」。所以这里 spawn 完立即 resolve，
 * 生命周期完全交给 jobs 表与三个作业通道。
 *
 * 校验与前台完全一致（命令文本、可写根、pendingCancel）：后台不是绕过校验的后门。
 *
 * @param {object} params 与 runCommand 同形（command/cwd/roots/runId）
 * @param {Function} [spawnImpl] 测试注入
 * @returns {Promise<object>} 成功 {ok:true,jobId,pid,cwd}；失败与前台同 code
 */
async function startBackground(params, spawnImpl = spawn) {
  const roots = normalizeRoots(params && params.roots);
  const checked = normalizeCommand(params);
  if (!checked.ok) return checked;
  const command = checked.command;
  const runId = deriveRunId(params);

  const dir = await resolveWorkingDir(roots, params && params.cwd);
  if (!dir.ok) {
    // 同前台：命令不会 spawn，清掉未消费的预取消，避免永久占位（d.412 回归）。
    pendingCancel.delete(runId);
    return dir;
  }

  if (pendingCancel.delete(runId)) return fail("aborted", "命令在执行前被取消");

  const cwd = dir.cwd.replace(/\\/g, "/");
  let child = null;
  try {
    child = spawnImpl(command, {
      cwd: dir.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
  } catch (e) {
    return fail("spawn-failed", `无法启动命令解释器：${e && e.message ? e.message : String(e)}`);
  }

  const job = {
    id: makeJobId(),
    command,
    cwd,
    child,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    running: true,
    stdout: [],
    stderr: [],
    captured: 0,
    produced: 0,
    dropped: 0,
    truncated: false,
    timedOut: false,
    // 契约里的 timer 预留给「每作业超时」；当前硬超时由 lifespan 承担，这里保持形状一致。
    timer: null,
    lifespan: null,
    waiters: new Set(),
  };
  jobs.set(job.id, job);

  // 30 分钟硬上限。unref 掉：不让一个 30 分钟的定时器拖住测试/退出；
  // 作业还在跑时子进程句柄本来就会让事件循环活着，不存在「unref 后提前退出」。
  job.lifespan = setTimeout(() => {
    job.timedOut = true;
    killTree(job.child);
    finishJob(job, null, "SIGKILL");
  }, MAX_JOB_MS);
  if (typeof job.lifespan.unref === "function") job.lifespan.unref();

  const collect = (stream) => (data) => appendJobChunk(job, stream, data);
  if (child.stdout) child.stdout.on("data", collect("stdout"));
  if (child.stderr) child.stderr.on("data", collect("stderr"));
  child.on("error", (e) => {
    job.error = e && e.message ? e.message : String(e);
    finishJob(job, null, null);
  });
  child.on("close", (code, signal) => finishJob(job, code, signal));

  return { ok: true, jobId: job.id, pid: child && child.pid, cwd };
}

/**
 * 增量读取一个作业的输出。
 *
 * 为什么「读一次就把缓冲交出去并清空」：后台作业没有唯一的结果回调（用户可能轮询很多次），
 * 未读缓冲是最直接的增量实现——读走即消费，下一次只拿到新产生的字节，也不需要单独的
 * 读游标字段。代价是同一段输出不会重复返回，调用方要自己拼接完整日志。
 *
 * waitMs 的语义：作业还在跑时可以等它结束，但一次最多等 MAX_JOB_WAIT_MS；
 * 超时就把当前增量先返回，渲染层下一轮再拉，这样 IPC 不会无限挂住。
 *
 * @param {string} jobId
 * @param {number} [waitMs] 0..MAX_JOB_WAIT_MS
 * @returns {Promise<object>}
 */
async function readJobOutput(jobId, waitMs) {
  const id = typeof jobId === "string" ? jobId.trim() : "";
  const job = jobs.get(id);
  if (!job) return fail("unknown-job", "没有这个作业（可能已被清理）");

  const rawWait = typeof waitMs === "number" && Number.isFinite(waitMs) ? waitMs : 0;
  const bounded = Math.min(Math.max(Math.floor(rawWait), 0), MAX_JOB_WAIT_MS);
  if (bounded > 0 && job.running) await waitForJobFinish(job, bounded);

  const stdoutChunks = job.stdout;
  const stderrChunks = job.stderr;
  job.stdout = [];
  job.stderr = [];
  job.captured = 0;

  return {
    ok: true,
    jobId: job.id,
    running: job.running,
    exitCode: job.exitCode,
    stdout: decodeCommandOutput(stdoutChunks),
    stderr: decodeCommandOutput(stderrChunks),
    truncated: job.truncated,
    droppedBytes: job.dropped,
  };
}

/**
 * 取一组 Buffer 的末尾 maxBytes 字节（同时告诉调用方有没有被截）。
 *
 * 作业缓冲是按块追加的数组，末尾可能落在某一块的中间，所以要逐块算偏移再 slice。
 */
function tailOf(chunks, maxBytes) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const keep = Math.min(total, maxBytes);
  const start = total - keep;
  let seen = 0;
  const kept = [];
  for (const chunk of chunks) {
    const end = seen + chunk.length;
    if (end > start) kept.push(start > seen ? chunk.subarray(start - seen) : chunk);
    seen = end;
  }
  return { text: decodeCommandOutput(kept), cut: keep < total };
}

/** 预览长度：缺省 16KB，夹在 512B..16KB。 */
function clampPreviewBytes(value) {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : MAX_JOB_PREVIEW_BYTES;
  return Math.min(Math.max(num, 512), MAX_JOB_PREVIEW_BYTES);
}

/**
 * 预览一个作业**最近**的输出（d.203）。
 *
 * 为什么界面不能直接用 `readJobOutput`：那是**增量读、读走即消费**——用户在界面上点一次
 * 「看输出」，模型之后的 `command_output` 就少了这一段，两边互相抢。所以单开一条只读快照
 * 通道：不移动读游标、不清未读缓冲，只把每条流末尾 maxBytes 字节带走（`cut` 表示有没有截）。
 *
 * @param {string} jobId
 * @param {number} [maxBytes] 512..MAX_JOB_PREVIEW_BYTES
 * @returns {object}
 */
function previewJobOutput(jobId, maxBytes) {
  const id = typeof jobId === "string" ? jobId.trim() : "";
  const job = jobs.get(id);
  if (!job) return fail("unknown-job", "没有这个作业（可能已被清理）");
  const limit = clampPreviewBytes(maxBytes);
  const out = tailOf(job.stdout, limit);
  const err = tailOf(job.stderr, limit);
  return {
    ok: true,
    jobId: job.id,
    running: job.running,
    exitCode: job.exitCode,
    stdout: out.text,
    stderr: err.text,
    cut: out.cut || err.cut,
    produced: job.produced,
    dropped: job.dropped,
  };
}

/**
 * 列出作业（所有在跑的 + 最近 MAX_BACKGROUND_JOBS 个已完成的，按登记顺序）。
 *
 * bytes 用「累计产出」而不是「当前未读字节」：列表关心这条命令一共产了多少输出，
 * 未读字节只影响下一次读取能拿到多少。
 */
function listJobs() {
  return Array.from(jobs.values()).map((job) => ({
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    running: job.running,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    bytes: job.produced,
    dropped: job.dropped,
  }));
}

/**
 * 杀掉一个后台作业（与前台超时/取消共用同一套 `killTree`，Windows 上是 taskkill /t /f）。
 *
 * 为什么只认 jobId 不认 pid：pid 一旦来自渲染层就等于「任意进程终止」权限；
 * 必须由主进程按自己登记过的 id 查表。返回值里的 killed 只表示「本次调用发出了停止」，
 * 不代表已经 close——taskkill 与 close 在 Windows 上是异步竞态，调用方要以
 * `shell:job-output` 的 running 字段为准。
 *
 * @param {string} jobId
 * @returns {object}
 */
function killJob(jobId) {
  const id = typeof jobId === "string" ? jobId.trim() : "";
  const job = jobs.get(id);
  if (!job) return fail("unknown-job", "没有这个作业（可能已被清理）");
  if (!job.running) return { ok: true, jobId: job.id, killed: false, alreadyFinished: true };
  killTree(job.child);
  return { ok: true, jobId: job.id, killed: true, alreadyFinished: false };
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
      const body = payload && typeof payload === "object" ? payload : {};
      // 后台分支：同一个入口、同一套校验，只是「不等结果」而不是「换一个信任模型」。
      if (body.background === true) return await startBackground(body, spawnImpl);
      return await runCommand(body, spawnImpl);
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

  // 后台作业列表：只读快照，不包含输出正文（输出统一走 shell:job-output）。
  ipcMain.handle("shell:jobs", (event) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      return { ok: true, jobs: listJobs() };
    } catch (e) {
      return fail("io", `读取作业列表失败：${e && e.message ? e.message : String(e)}`);
    }
  });

  // 增量读输出：带 waitMs 时在作业结束时提前返回，不必让渲染层 busy-poll。
  ipcMain.handle("shell:job-output", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      return await readJobOutput(body.jobId, body.waitMs);
    } catch (e) {
      return fail("io", `读取作业输出失败：${e && e.message ? e.message : String(e)}`);
    }
  });

  // 预览最近输出（只读快照）：界面看日志不能消费掉模型要读的增量。
  ipcMain.handle("shell:job-preview", (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      return previewJobOutput(body.jobId, body.maxBytes);
    } catch (e) {
      return fail("io", `预览作业输出失败：${e && e.message ? e.message : String(e)}`);
    }
  });

  // 杀掉一个作业：只认本进程登记过的 jobId（不接受 pid）。
  ipcMain.handle("shell:job-kill", (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      return killJob(body.jobId);
    } catch (e) {
      return fail("io", `终止作业失败：${e && e.message ? e.message : String(e)}`);
    }
  });
}

module.exports = {
  registerShellIpc,
  runCommand,
  cancelRun,
  resolveWorkingDir,
  killTree,
  startBackground,
  readJobOutput,
  previewJobOutput,
  killJob,
  listJobs,
  MAX_CAPTURE_BYTES,
  MAX_COMMAND_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_BACKGROUND_JOBS,
  MAX_JOB_BYTES,
  MAX_JOB_MS,
  MAX_JOB_WAIT_MS,
  MAX_JOB_PREVIEW_BYTES,
  decodeCommandOutput,
  shapeTerminalText,
};
