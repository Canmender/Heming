#!/usr/bin/env node
/**
 * 和鸣一条命令发版。
 *
 * 过去发版是照着 `docs/VERSION-MANAGEMENT.md` 的「发布顺序」和 `docs/deploy.md` §2/§6/§9
 * 手工敲一串命令：build → test → bump → changelog → 打包 → 备份 → 部署 → 上传更新源。
 * 手工编排踩过的坑（每一条都在文档里留了记录）：
 *   - r31 内嵌旧前端：`build-desktop.mjs` 不会替你跑 `build-desktop-web.mjs`，
 *     包成功、版本号对、内容却是上一版；
 *   - 同一轮里先打包后打云端 tar：`build-desktop-web.mjs` 会就地重写
 *     `packages/web/dist`（注入 VITE_API_BASE），上云的就是写死 IP 的那份；
 *   - 漏 `latest.yml`：客户端永远提示「已是最新」，界面上与正常无差别；
 *   - 备份只留在服务器上：2026-10-22 实例重置把库和卷备份一起清了。
 * 这些顺序与前置条件在这里固化为一条命令；**任何一步失败立即停止**，不做「先传了再说」。
 *
 * 为什么是 Node ESM 而不是 bash：本机 Git Bash(MSYS) 会把 `/opt/x` 这类参数自动转成
 * `E:/...`，`publish-update.sh` 已经因此加过 `MSYS_NO_PATHCONV=1`；再用 bash 编排只会
 * 把同一类问题放大。Node 里 spawn 不经过 MSYS 转换。
 *
 * 安全边界（重要）：
 *   - 默认只做「门禁 + 生成 changelog 模块 + 打印证据清单」，不打包、不连服务器、不传文件；
 *   - 打包要 `--desktop`，部署要 `--deploy`，上传更新源要 `--publish`，三个开关互相独立；
 *   - 部署**强制先备份**（`deploy-bare.py backup`），备份不成功就不会走到 upload/install；
 *   - `--dry-run` 只打印十步计划（命令 / 工作目录 / 会写哪些文件），零副作用。
 *
 * 用法见 `node scripts/release.mjs --help`。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseDir } from "./release-dir.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_PKG = join(ROOT, "packages", "desktop", "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CHANGELOG_TS = join(ROOT, "packages", "web", "src", "generated", "changelog.ts");

const SELF = "node scripts/release.mjs";

/* ------------------------------------------------------------------ *
 * 十步定义
 * ------------------------------------------------------------------ */

const STEP_IDS = [
  "preflight",
  "build",
  "tests",
  "bump",
  "changelog-check",
  "changelog",
  "desktop",
  "deploy",
  "publish",
  "evidence",
];

/** 各步默认超时（0 = 不设）。`--timeout` 会整体覆盖。 */
const STEP_TIMEOUTS = {
  preflight: 120_000,
  build: 3_600_000,
  testPackage: 900_000,
  bump: 120_000,
  changelog: 120_000,
  desktop: 7_200_000,
  deployStage: 1_800_000,
  publish: 1_800_000,
};

/** deploy.md §2 的排除表（裸段名，不能带 `./` 前缀）。 */
const TAR_EXCLUDES = [
  "node_modules",
  ".git",
  ".superpowers",
  ".worktrees",
  /*
   * `.agents/` 是 IDE/代理会话留的 git worktree（每份都是整个仓库副本，含 node_modules
   * 与历史产物），既不是云端要的产物，也不该出现在部署快照里——d.137 实测它把部署包
   * 从 5MB 级撑到 73MB，还把过期的插件/文案副本带上云。
   */
  ".agents",
  "data",
  "release",
  ".claude",
  ".tmp",
  ".workbuddy",
  "packages/desktop/runtime",
  "packages/desktop/web-dist",
  /*
   * 云端只用两样东西：`packages/web/dist`（静态页）与 `packages/{server,shared}/dist`（node 进程）。
   * 桌面侧资源、vendor 源码与引擎构建缓存都不需要上云——它们曾把部署包从 5MB 量级撑到
   * 183MB（`packages/desktop/resources/magpie` 的 magpie-core.exe ×2 就占约 144MB），
   * 每次上传与 `keep` 都白花磁盘与时间。加「只在本地用」的大目录时，先把裸段名加到这里，
   * 再由 `TAR_FORBIDDEN` 兜底核对。
   *
   * `plugins-catalog` 只在本地暂存、由人工同步到云端 `/opt/heming/plugins`（d.137 唯一路径
   * 约定），云端进程只读 `HEMING_PLUGIN_DIR`，部署快照里再放一份就是「伪仓库」，只会让
   * 人分不清哪份才是权威的。
   *
   * `plugin-kit` **不能整目录排除**：`pnpm-workspace.yaml` 把
   * `plugin-kit/plugins/pet-widget` 列为 workspace 项目，云端 `install-app.sh` 的
   * `pnpm install --frozen-lockfile` 会校验全部 workspace 清单——缺了这个目录，
   * 安装会以 `ERR_PNPM_OUTDATED_LOCKFILE` 失败（d.122 首次部署实测）。所以只排它的构建产物。
   */
  "plugins-catalog",
  "*.log",
  "packages/desktop/resources",
  "packages/infohub",
  /*
   * 自绘安装器（d.138）的构建产物：`packages/setup/payload/inner-setup.exe`（357MB）与
   * `packages/desktop/update-helper/setup.exe`（409MB）都是 electron-builder 打出的整包副本。
   * d.140 第一次带着它们打部署包，体积从 d.137 的 34MB 涨到 790MB，被第 8 步的 300MB 红线拦下。
   * 云端只要 web/server/shared 的 dist，这两处纯属本机安装器原料。
   */
  "packages/setup/build",
  "packages/setup/payload",
  "packages/desktop/update-helper",
  ".tmp-module-dl",
  "plugin-kit/plugins/pet-widget/dist",
  "plugin-kit/plugins/workflow-kit/dist",
  "vendor",
  ".tmp-engine-lib",
  ".tmp-engine-wheels",
  ".ui-check-tmp",
  "@hemingdesktop",
];

/** deploy.md §2 的两条校验：不该有的必须为 0，必须有的至少 1。 */
const TAR_FORBIDDEN = /node_modules|\.superpowers|@hemingdesktop|(^|\/)release\/|\.tmp|\.workbuddy|\.ui-check-tmp|\.agents|(^|\/)plugins-catalog\/|\.log$|packages\/desktop\/(runtime|web-dist|resources)|(^|\/)packages\/(setup\/(build|payload)|desktop\/update-helper)\//;
const TAR_REQUIRED = [
  "packages/web/dist/index.html",
  "packages/server/dist/",
  "packages/shared/dist/index.js",
];

/**
 * tar 可执行文件：Windows 上优先用系统自带 bsdtar（`System32\tar.exe`）。
 *
 * 为什么不能直接写 `tar`：本机 PATH 里可能排着 MSYS/Git 的 GNU tar（在 bash 类
 * shell 里跑发布链时尤其常见），GNU tar 会把 `C:\...` 当成「远端主机 C」并报
 * `Cannot connect to C:`；系统 bsdtar 既认 Windows 绝对路径，`--exclude` 裸段名
 * 语义也与 deploy.md §2 的排除表一致（已实测嵌套 node_modules 被正确排除）。
 */
const TAR_BIN =
  process.platform === "win32" &&
  existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"))
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

/* ------------------------------------------------------------------ *
 * 小工具：输出、格式化、错误
 * ------------------------------------------------------------------ */

const print = (text = "") => process.stdout.write(`${text}\n`);
const errPrint = (text = "") => process.stderr.write(`${text}\n`);

class UsageError extends Error {}
class StepError extends Error {
  /** @param {string} message @param {{hint?: string, tail?: string[]}} extra */
  constructor(message, extra = {}) {
    super(message);
    this.hint = extra.hint ?? "";
    this.tail = extra.tail ?? null;
  }
}

/** 中英文混排按 2 列宽估算，终端里表头才对齐（纯装饰）。 */
function dispWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += /[^\x00-\xff]/.test(ch) ? 2 : 1;
  return width;
}

function padEndDisp(text, width) {
  const value = String(text);
  return value + " ".repeat(Math.max(0, width - dispWidth(value)));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return "—";
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Windows 上崩溃退出码常是 0xC0000409（栈溢出 / 快速失败），Node 报成 3221226505。
 * 直接给十进制没人认得出来，十六进制才对得上「本机偶发 0xC0000409」这条经验。
 */
function formatExitCode(code) {
  if (code === 0) return "0";
  if (code > 0x7fffffff) return `0x${(code >>> 0).toString(16).toUpperCase()}`;
  return String(code);
}

function isWindowsFatalCrash(code) {
  return code > 0x7fffffff && (code >>> 0) === 0xc0000409;
}

function shellQuote(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function todayString() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function timestampString() {
  const now = new Date();
  return `${todayString()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ *
 * 命令行参数
 * ------------------------------------------------------------------ */

const DEFAULT_OPTS = {
  dryRun: false,
  help: false,
  quiet: false,
  allowDirty: false,
  bump: null,
  desktop: false,
  deploy: false,
  deployTar: null,
  publish: false,
  releaseDir: null,
  releaseR: null,
  skipTests: false,
  only: null,
  skip: new Set(),
  testCmd: null,
  retryDelay: 3000,
  timeout: 0,
  verifyBundle: true,
};

const USAGE_LINES = [
  `用法：${SELF} [开关]`,
  "",
  "常见组合：",
  `  ${SELF}                              门禁 + 生成 changelog 模块 + 证据清单（不打包、不部署、不上传）`,
  `  ${SELF} --bump=fix                   门禁通过后自动 bump 版本位，再校验 CHANGELOG 顶部条目`,
  `  ${SELF} --desktop                    额外打包安装包（输出到 release/rNN，自动递增）`,
  `  ${SELF} --desktop --deploy           额外部署云端（强制先 backup，备份不通过整轮中止）`,
  `  ${SELF} --desktop --publish          额外把安装包 + latest.yml 发到更新源`,
  `  ${SELF} --dry-run                    只打印十步计划（命令 / 工作目录 / 会写哪些文件），零副作用`,
].join("\n");

const HELP_TEXT = `${USAGE_LINES}

开关（危险动作默认全关）：
  --dry-run                 只打印十步计划与只读预检结果，不执行任何写操作、不连服务器
  --bump <fix|feature|breaking|build>
                            门禁通过后调用 scripts/bump-version.mjs auto <类型>；
                            版本号只增不减，其余位原样保留（不归零）
  --allow-dirty             允许工作区有未提交改动。默认拒绝——「产物 == 提交代码」是唯一闸门
  --desktop                 打包 Windows 安装包：pnpm -w run dist:desktop
                            （内部先跑 build-desktop-web.mjs，再 build-desktop.mjs --win nsis）
  --deploy                  部署云端：强制 backup → （必要时打 tar）→ upload → install → smoke。
                            任一步非 0 立即停止；backup 不通过绝不会走到 install
  --deploy-tar <path>       配合 --deploy：使用已打好的部署包，不再现场打 tar
  --publish                 把安装包 + latest.yml + .blockmap 发到更新源：
                            win32 走 node scripts/publish-update.mjs（不依赖 Git Bash）；
                            其它平台走 bash scripts/publish-update.sh（需要 HEMING_SSH_PWD）
  --release-dir <path>      指定打包与发布的产物目录（等价 HEMING_RELEASE_DIR；相对路径按仓库根解析）
  --release-r <NN>          shorthand：产物落到 <默认 release 目录>/rNN
  --skip-tests              跳过逐包测试（只跳过测试，不跳过 build；谨慎使用）
  --only <id,id>            只跑指定步骤（调试/验证用）。id 见下方十步，也可写序号 1-10
  --skip <id,id>            跳过指定步骤
  --timeout <ms>            覆盖所有步骤的超时（0 = 不设；默认构建 60min、单包测试 15min、
                            打包 120min、部署/发布阶段 30min）
  --retry-delay <ms>        单包测试失败后重试前的等待（默认 3000）
  --test-cmd <shell>        【调试】替换逐包测试命令，可用占位符 {package} {dir}；
                            用于验证「单包重试」分支（本身不改变发布语义）
  --no-verify-bundle        跳过「安装包内嵌 web 产物含版本串 / 与 web-dist 同名」核对
  --quiet                   不转发子进程输出（失败时仍会打印最后 40 行）
  -h, --help                打印本帮助

十步顺序（任何一步失败立即停止）：
   1. 工作区与工具链预检        git status 脏则拒绝 / Node>=24 / pnpm / 版本号 / deploy 脚本版本
   2. 门禁构建                  pnpm -r build
   3. 逐包测试                  pnpm --filter <包> test（逐包串行，单包失败重试一次）
   4. bump 版本（可选）         node scripts/bump-version.mjs auto <类型>
   5. 校验 CHANGELOG           顶部条目版本号必须等于当前 hemingVersion
   6. 生成变更日志模块          node scripts/build-changelog.mjs → packages/web/src/generated/changelog.ts
   7. 打包安装包（可选）        pnpm -w run dist:desktop → <release dir>/；核对 latest.yml 与内嵌产物
   8. 备份 + 部署（可选）       deploy-bare.py backup → upload → install → smoke
   9. 发布更新源（可选）        publish-update.mjs（win32）/ publish-update.sh：--dry-run 预览后真传，
                                校验远端大小与 sha512
  10. 证据清单                 每步退出码 / 耗时 / 产物路径与大小 / 需要人工填写的校验项

环境变量：
  HEMING_RELEASE_DIR   同 --release-dir
  HEMING_WEB_URL       打进安装包的 API 地址（沿用 scripts/build-desktop-web.mjs 的约定）
  HEMING_SSH_PWD       --publish 必填（服务器 root 密码，不落盘）
  HEMING_PYTHON        --deploy 用的 Python（默认探测 WorkBuddy 环境，再回落 python/python3）

退出码：0 = 全部通过；1 = 某一步失败（失败步骤与后续手动步骤已打印）；2 = 用法错误
`;

/**
 * 解析 argv。支持 `--k=v` 与 `--k v` 两种写法。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = { ...DEFAULT_OPTS, skip: new Set() };

  const takeValue = (name, inline, index) => {
    if (inline !== undefined) {
      if (inline === "") throw new UsageError(`--${name} 需要一个非空值`);
      return { value: inline, index };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} 需要一个值`);
    return { value: next, index: index + 1 };
  };

  const parseStepList = (raw, flag) => {
    const list = String(raw)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!list.length) throw new UsageError(`--${flag} 需要一个步骤 id 列表`);
    return list.map((item) => {
      if (/^\d+$/.test(item)) {
        const index = Number(item) - 1;
        if (!STEP_IDS[index]) throw new UsageError(`--${flag} 的序号 ${item} 超出 1-${STEP_IDS.length}`);
        return STEP_IDS[index];
      }
      if (!STEP_IDS.includes(item)) {
        throw new UsageError(`未知步骤 "${item}"；可用：${STEP_IDS.join(", ")}`);
      }
      return item;
    });
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === "-h") {
      opts.help = true;
      continue;
    }
    if (!raw.startsWith("--")) throw new UsageError(`多余的参数：${raw}（开关都以 -- 开头）`);

    const body = raw.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    switch (name) {
      case "help":
        opts.help = true;
        break;
      case "dry-run":
        opts.dryRun = true;
        break;
      case "quiet":
        opts.quiet = true;
        break;
      case "allow-dirty":
        opts.allowDirty = true;
        break;
      case "desktop":
        opts.desktop = true;
        break;
      case "deploy":
        opts.deploy = true;
        break;
      case "publish":
        opts.publish = true;
        break;
      case "skip-tests":
        opts.skipTests = true;
        break;
      case "no-verify-bundle":
        opts.verifyBundle = false;
        break;
      case "bump": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        const kind = taken.value;
        if (!["fix", "feature", "breaking", "build"].includes(kind)) {
          throw new UsageError(`--bump 的值必须是 fix / feature / breaking / build，收到 "${kind}"`);
        }
        opts.bump = kind;
        break;
      }
      case "deploy-tar": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        opts.deployTar = taken.value;
        break;
      }
      case "release-dir": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        opts.releaseDir = taken.value;
        break;
      }
      case "release-r": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        if (!/^\d+$/.test(taken.value)) throw new UsageError(`--release-r 需要数字，收到 "${taken.value}"`);
        opts.releaseR = Number(taken.value);
        break;
      }
      case "only":
      case "skip": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        const ids = parseStepList(taken.value, name);
        if (name === "only") opts.only = new Set(ids);
        else for (const id of ids) opts.skip.add(id);
        break;
      }
      case "test-cmd": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        opts.testCmd = taken.value;
        break;
      }
      case "retry-delay": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        if (!/^\d+$/.test(taken.value)) throw new UsageError(`--retry-delay 需要毫秒数，收到 "${taken.value}"`);
        opts.retryDelay = Number(taken.value);
        break;
      }
      case "timeout": {
        const taken = takeValue(name, inline, i);
        i = taken.index;
        if (!/^\d+$/.test(taken.value)) throw new UsageError(`--timeout 需要毫秒数，收到 "${taken.value}"`);
        opts.timeout = Number(taken.value);
        break;
      }
      default:
        throw new UsageError(`未知开关 --${name}（--help 看全部开关）`);
    }
  }

  if (opts.deployTar && !opts.deploy) {
    throw new UsageError("--deploy-tar 只有配合 --deploy 才有意义（单独给不会上传任何东西）");
  }
  if (opts.releaseDir && opts.releaseR) {
    throw new UsageError("--release-dir 与 --release-r 只能给一个");
  }
  if (opts.only) {
    for (const id of opts.skip) {
      if (opts.only.has(id)) throw new UsageError(`步骤 ${id} 同时在 --only 与 --skip 里`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * 子进程执行
 * ------------------------------------------------------------------ */

/** 结束整棵进程树：Windows 上 shell 子进程的孙子（pnpm → vite）不会被 child.kill 带走。 */
function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退了 */
    }
  }
}

/**
 * 跑一条命令：实时转发输出、保留最后 40 行（失败时打印）、支持超时。
 * @returns {Promise<{code:number, signal:string|null, timedOut:boolean, durationMs:number, output:string, tail40:string[]}>}
 */
function runCommand({ cmd, cwd = ROOT, env = {}, timeoutMs = 0, quiet = false }) {
  const started = Date.now();
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, {
        cwd,
        shell: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      done({
        code: -1,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - started,
        output: `启动失败：${error.message}`,
        tail40: [`启动失败：${error.message}`],
      });
      return;
    }

    /** @type {string[]} 全量输出（截断，仅供文本检索） */
    const outputLines = [];
    /** @type {string[]} 最后 40 行 */
    const tail = [];
    let pending = "";
    let timedOut = false;

    const pushLine = (text, stream) => {
      if (outputLines.length < 4000) outputLines.push(text);
      tail.push(stream === "err" ? `[stderr] ${text}` : text);
      if (tail.length > 40) tail.shift();
      if (quiet) return;
      if (stream === "err") errPrint(text);
      else print(text);
    };

    const onChunk = (chunk, stream) => {
      pending += chunk.toString("utf8");
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/\r$/, "");
        if (line !== "" || stream === "err") pushLine(line, stream);
      }
    };

    child.stdout.on("data", (chunk) => onChunk(chunk, "out"));
    child.stderr.on("data", (chunk) => onChunk(chunk, "err"));

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (!quiet) print(`\n[release] 超时 ${formatDuration(timeoutMs)}，正在终止：${cmd}`);
        killTree(child);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pending.trim()) pushLine(pending.trim(), "out");
      done({
        code: typeof code === "number" ? code : -1,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        output: outputLines.join("\n"),
        tail40: tail.slice(),
      });
    };

    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (error) => {
      pushLine(`启动失败：${error.message}`, "err");
      finish(-1, null);
    });
  });
}

/** 带上下文的一层包装：记录最后一条命令（失败时打印用），默认继承 --quiet。 */
async function run(ctx, spec) {
  const { cmd, cwd = ROOT, env = {}, timeoutMs = 0, quiet = ctx.opts.quiet } = spec;
  ctx.lastCommand = { cmd, cwd };
  if (!quiet) print(`\n$ ${cmd}`);
  return runCommand({ cmd, cwd, env, timeoutMs, quiet });
}

/** 只读短命令：吃输出、不打印。 */
async function capture(ctx, cmd, { cwd = ROOT, timeoutMs = 120_000 } = {}) {
  const result = await runCommand({ cmd, cwd, timeoutMs, quiet: true });
  return result;
}

function sha256File(file) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", fail);
    stream.on("end", () => done(hash.digest("hex")));
  });
}

/** sha512 → base64：electron-builder 的 latest.yml 用的就是这个编码。 */
function sha512Base64File(file) {
  return new Promise((done, fail) => {
    const hash = createHash("sha512");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", fail);
    stream.on("end", () => done(hash.digest("base64")));
  });
}

/* ------------------------------------------------------------------ *
 * 仓库信息（全部只读）
 * ------------------------------------------------------------------ */

function loadVersion() {
  const pkg = JSON.parse(readFileSync(DESKTOP_PKG, "utf8"));
  return pkg.hemingVersion ?? pkg.version;
}

/** 5 段版本 → 预测 bump 后的版本（--dry-run 展示用，不写盘）。 */
function predictBump(kind, version) {
  const match = /^([dmc])\.(\d+)\.(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(String(version));
  if (!match) return null;
  const parts = {
    channel: match[1],
    feature: Number(match[2]),
    breaking: Number(match[3]),
    revision: Number(match[4]),
    build: Number(match[5]),
  };
  if (kind === "feature") parts.feature += 1;
  else if (kind === "breaking") parts.breaking += 1;
  else if (kind === "build") parts.build += 1;
  else parts.revision += 1;
  return `${parts.channel}.${parts.feature}.${parts.breaking}.${parts.revision}.${parts.build}`;
}

/** 本轮跑完 bump 之后会是的版本。 */
function prospectiveVersion(ctx) {
  return ctx.opts.bump ? (predictBump(ctx.opts.bump, ctx.version) ?? ctx.version) : ctx.version;
}

/** 带 test 脚本的 workspace 包（pnpm-workspace.yaml 只有 packages/*）。 */
function discoverPackages() {
  const base = join(ROOT, "packages");
  if (!existsSync(base)) return [];
  const packages = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(base, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg.name || !pkg.scripts?.test) continue;
      packages.push({ dir: entry.name, name: pkg.name, testScript: pkg.scripts.test });
    } catch {
      /* 坏 package.json 交给 pnpm 报错 */
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** 默认 release 目录（不创建）+ 自动递增的 rNN。 */
function nextReleaseDir(ctx) {
  if (ctx.opts.releaseDir) return resolve(ROOT, ctx.opts.releaseDir);
  const base = resolveReleaseDir({ create: false });
  if (ctx.opts.releaseR !== null && ctx.opts.releaseR !== undefined) {
    return join(base, `r${ctx.opts.releaseR}`);
  }
  let max = 0;
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      const match = /^r(\d+)$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return join(base, `r${max + 1}`);
}

function findInstallers(dir, version) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".exe") && name.includes(version))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/**
 * 第 9 步用哪个目录：
 * - 本轮打过包 → 用同一个 ctx.releaseDir（打包与发布必须同目录）；
 * - 显式给了 --release-r/--release-dir → 按那个；
 * - 都没有 → 默认产物目录（不是「下一个 rNN」：发布时不该凭空指向一个还没出包的目录）。
 */
function resolvePublishDir(ctx) {
  if (ctx.releaseDir) return ctx.releaseDir;
  if (ctx.opts.releaseDir) return resolve(ROOT, ctx.opts.releaseDir);
  if (ctx.opts.releaseR !== null && ctx.opts.releaseR !== undefined) {
    return join(resolveReleaseDir({ create: false }), `r${ctx.opts.releaseR}`);
  }
  return resolveReleaseDir({ create: false });
}

/** deploy-bare.py 在 worktree 里通常不存在（`.superpowers/` 在 gitignore 里），往上找主检出。 */
function locateDeployScript() {
  let dir = ROOT;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, ".superpowers", "deploy-bare.py");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readDeployVersion(scriptPath) {
  try {
    const match = /^VERSION\s*=\s*"([^"]+)"/m.exec(readFileSync(scriptPath, "utf8"));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Python 探测：HEMING_PYTHON > WorkBuddy 环境 > python > python3。 */
function locatePython() {
  const candidates = [
    process.env.HEMING_PYTHON,
    "C:/Users/ADMIN/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "python";
}

function backupDirs(deployScript) {
  const dirs = [];
  if (deployScript) {
    const repoRoot = resolve(dirname(deployScript), "..");
    dirs.push(join(repoRoot, ".tmp", "backups"));
    dirs.push(join(dirname(deployScript), ".tmp", "backups")); // 历史落点
  }
  dirs.push(join(ROOT, ".tmp", "backups"));
  return [...new Set(dirs)];
}

function freshBackups(dirs, sinceMs) {
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        const info = statSync(file);
        if (!info.isFile() || info.size <= 0) continue;
        if (info.mtimeMs >= sinceMs - 5000) found.push({ path: file, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function artifact(label, path, extra = {}) {
  let size = null;
  let mtimeMs = null;
  try {
    const info = statSync(path);
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    /* 不存在 */
  }
  return { label, path, size, mtimeMs, ...extra };
}

/* ------------------------------------------------------------------ *
 * 十步：plan（dry-run 打印）与 run（真执行）
 * ------------------------------------------------------------------ */

const STEPS = [
  {
    id: "preflight",
    n: 1,
    title: "工作区与工具链预检",
    hint: "工作区脏 → 先 commit 或 stash；确认就是要发这棵树时加 --allow-dirty（会写进证据）。缺 pnpm / Node 版本过低 → 先修工具链，别绕过。",
    skipReason: () => null,
    plan: planPreflight,
    run: runPreflight,
  },
  {
    id: "build",
    n: 2,
    title: "门禁构建",
    hint: "看上面的报错定位是哪个包（shared 先于 server/web）。单独跑 `pnpm -r build` 通过后再重跑本脚本。",
    skipReason: () => null,
    plan: planBuild,
    run: runBuild,
  },
  {
    id: "tests",
    n: 3,
    title: "逐包测试（单包失败重试一次）",
    hint: "该包重试后仍失败，按真实失败处理。若退出码是 0xC0000409（Windows 快速失败/栈溢出），先单独重跑该包确认是否偶发；连续两次同名失败不要放行。",
    skipReason: (ctx) => (ctx.opts.skipTests ? "已指定 --skip-tests" : null),
    plan: planTests,
    run: runTests,
  },
  {
    id: "bump",
    n: 4,
    title: "bump 版本（可选）",
    hint: "bump-version.mjs 只接受比当前大的版本，且数字只增不减。若想重出同一版，用 --bump=build。",
    skipReason: (ctx) => (ctx.opts.bump ? null : "未指定 --bump（版本保持不变）"),
    plan: planBump,
    run: runBump,
  },
  {
    id: "changelog-check",
    n: 5,
    title: "校验 CHANGELOG 顶部条目",
    hint: "在 CHANGELOG.md 顶部加一条 `## <当前版本>（YYYY-MM-DD）— 一句话标题` 再重跑；版本已 bump 过就**去掉 --bump**（再 bump 会又进一位）。",
    skipReason: () => null,
    plan: planChangelogCheck,
    run: runChangelogCheck,
  },
  {
    id: "changelog",
    n: 6,
    title: "生成变更日志模块",
    hint: "多为 CHANGELOG 标题格式不符（`## d.x.y.z（YYYY-MM-DD）— 标题`）。改完只重跑第 6 步：`--only=changelog`。",
    skipReason: () => null,
    plan: planChangelog,
    run: runChangelog,
  },
  {
    id: "desktop",
    n: 7,
    title: "打包安装包（可选）",
    hint: "读 build-desktop-web / build-desktop 的报错。已知三类：NODE_OPTIONS 删除 shim、electron 缓存未继承、EBUSY（换 --release-r）。内嵌产物核对失败见 deploy.md §9 坑 4。",
    skipReason: (ctx) => (ctx.opts.desktop ? null : "未指定 --desktop（不打包安装包）"),
    plan: planDesktop,
    run: runDesktop,
  },
  {
    id: "deploy",
    n: 8,
    title: "备份 + 部署云端（可选）",
    hint: "部署已在本脚本中止，不会再往下走。先看是哪一阶段失败：backup 失败就手工跑 `python -u .superpowers/deploy-bare.py backup` 查 SSH/paramiko/服务状态；upload 之后失败，按 docs/deploy.md §3 分步重跑（各阶段幂等）。",
    skipReason: (ctx) => (ctx.opts.deploy ? null : "未指定 --deploy（默认永不部署）"),
    plan: planDeploy,
    run: runDeploy,
  },
  {
    id: "publish",
    n: 9,
    title: "发布更新源（可选）",
    hint: "上传可能已发生：先手工核对远端 /opt/heming/updates 的 latest.yml 与安装包大小，再决定是否重跑（脚本幂等）。需要 `export HEMING_SSH_PWD=...`。",
    skipReason: (ctx) => (ctx.opts.publish ? null : "未指定 --publish（不发布到更新源）"),
    plan: planPublish,
    run: runPublish,
  },
  {
    id: "evidence",
    n: 10,
    title: "证据清单",
    hint: "手工校验项没填就别关掉这一轮：线上 /api/health、bundle 版本串、sha512 对照是脚本替不了的。",
    skipReason: () => null,
    plan: planEvidence,
    run: runEvidence,
  },
];

/* ------------------------------ 1. 预检 ------------------------------ */

/** 只读预检：dry-run 里显示「真跑会不会被脏工作区拦住」。 */
function readDirtySync() {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.trim() !== "").length;
  } catch {
    return null;
  }
}

function planPreflight(ctx) {
  const preview = [`当前 hemingVersion = ${ctx.version}`];
  const dirty = readDirtySync();
  if (dirty === null) {
    preview.push("git status 读不到（不在 git 仓库？真跑会拒绝）");
  } else if (dirty === 0) {
    preview.push("工作区干净");
  } else {
    preview.push(
      `工作区有 ${dirty} 项未提交改动：真跑会拒绝` +
        (ctx.opts.allowDirty ? "（但已给 --allow-dirty，会放行并写进证据）" : "（--allow-dirty 可放行）"),
    );
  }
  const deployScript = locateDeployScript();
  if (deployScript) {
    const deployVersion = readDeployVersion(deployScript);
    const target = prospectiveVersion(ctx);
    preview.push(
      `deploy-bare.py 的 VERSION = ${deployVersion ?? "(读不到)"}` +
        (deployVersion === target
          ? `（与本轮目标版本 ${target} 一致）`
          : `（与本轮目标版本 ${target} 不一致：--deploy 会在预检就拒绝）`),
    );
  } else {
    preview.push("找不到 .superpowers/deploy-bare.py（只用 --deploy 时才需要）");
  }
  return {
    commands: [
      {
        cmd: "git status --porcelain",
        cwd: ROOT,
        writes: "（无，只读）",
        note: ctx.opts.allowDirty ? "--allow-dirty 已开：有改动也放行" : "非空则拒绝（除非 --allow-dirty）",
      },
      { cmd: "pnpm --version", cwd: ROOT, writes: "（无，只读）", note: "缺 pnpm 直接停" },
    ],
    preview,
  };
}

async function runPreflight(ctx) {
  const notes = [];
  const artifacts = [];

  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= 24)) {
    throw new StepError(`Node ${process.versions.node} 过低：根 package.json 要求 engines.node >= 24`, {
      hint: "换 Node 24 再发版（electron 与 node:sqlite 都按 24 准备）。",
    });
  }
  notes.push(`Node ${process.versions.node}`);

  const pnpm = await capture(ctx, "pnpm --version");
  if (pnpm.code !== 0) {
    throw new StepError("pnpm 不可用", {
      hint: "本机没装 pnpm 或不在 PATH：`corepack enable pnpm` 或按 docs/deploy.md §10 的版本装 10.x。",
      tail: pnpm.tail40,
    });
  }
  notes.push(`pnpm ${pnpm.output.trim().split(/\r?\n/).pop()}`);

  const git = await capture(ctx, "git status --porcelain");
  if (git.code !== 0) {
    throw new StepError("git status 失败：不像是一个 git 工作树", {
      hint: "发版必须能证明「产物 == 提交代码」。在仓库（或 worktree）里跑本脚本。",
      tail: git.tail40,
    });
  }
  const dirty = git.output.split(/\r?\n/).filter((line) => line.trim() !== "");
  ctx.dirtyCount = dirty.length;
  if (dirty.length > 0) {
    if (!ctx.opts.allowDirty) {
      const sample = dirty.slice(0, 8).map((line) => `  ${line}`).join("\n");
      throw new StepError(`工作区有 ${dirty.length} 项未提交改动，拒绝发版`, {
        hint: "先 commit 或 stash；确认就是要发这棵工作树时加 --allow-dirty（会在证据里记明）。",
        tail: sample.split("\n"),
      });
    }
    notes.push(`工作区脏：${dirty.length} 项（--allow-dirty 放行，证据里会注明）`);
  } else {
    notes.push("工作区干净");
  }

  // UTF-8 BOM 守卫（2026-11-02 实踩）：`deploy/nginx-heming.conf` 若带 BOM，
  // 远端 nginx 会在第一行报 `unknown directive "﻿#"`，install-app.sh 随即恢复默认站点，
  // 表现为「部署做到一半失败、站点回退到旧配置」。这类不可见字符在编辑器里看不出来，
  // 只能在发版前用字节判：前 3 字节是 EF BB BF 就拒绝。
  const deployTextFiles = [
    "deploy/nginx-heming.conf",
    "deploy/install-app.sh",
    "deploy/heming-api.service",
    "deploy/provision.sh",
  ];
  for (const rel of deployTextFiles) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const head = readFileSync(abs).subarray(0, 3);
    if (head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      throw new StepError(`部署文件带 UTF-8 BOM：${rel}`, {
        hint: "用不带 BOM 的 UTF-8 重写该文件（PowerShell 5 的 Out-File 默认会加 BOM）。nginx 会在第一行报 unknown directive。",
      });
    }
  }
  notes.push("部署文件无 BOM");

  // 发版依赖的脚本/文件必须在（缺了后面几步会以更难懂的方式失败）
  const required = [
    "package.json",
    "CHANGELOG.md",
    "scripts/bump-version.mjs",
    "scripts/build-changelog.mjs",
    "scripts/build-desktop-web.mjs",
    "scripts/build-desktop.mjs",
    "scripts/publish-update.sh",
    "scripts/publish-update.mjs",
  ];
  const missing = required.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length) {
    throw new StepError(`仓库缺文件：${missing.join("，")}`, {
      hint: "确认在仓库根跑，且没有删掉发布脚本。",
    });
  }

  const deployScript = locateDeployScript();
  if (deployScript) {
    const deployVersion = readDeployVersion(deployScript);
    const target = prospectiveVersion(ctx);
    ctx.deployScript = deployScript;
    ctx.deployScriptVersion = deployVersion;

    // 早失败：deploy-bare.py 的 VERSION 决定远端 tar 名，install-app.sh 又拿它比对包内
    // hemingVersion。不一致时等到第 8 步才炸，会白跑一轮构建 + 打包（约一小时）。
    if (ctx.opts.deploy && deployVersion !== target) {
      throw new StepError(
        `deploy-bare.py 的 VERSION=${deployVersion}，本轮要部署 ${target}`,
        {
          hint:
            `把 .superpowers/deploy-bare.py 的 VERSION 改成 "${target}" 再发版（该文件不入库、也不在 ` +
            "scripts/ 范围里，只能手工改）；否则 install-app.sh 会因「包内版本与参数不一致」拒绝部署。" +
            "也可以本轮不带 --deploy，部署那一步手工做。",
        },
      );
    }

    if (deployVersion && deployVersion !== target) {
      notes.push(
        `⚠ deploy-bare.py 的 VERSION=${deployVersion} 与本轮目标 ${target} 不一致：` +
          (ctx.opts.deploy ? "--deploy 会在预检就拒绝" : "本轮不部署，仅提示"),
      );
    } else {
      notes.push(`deploy-bare.py VERSION=${deployVersion}（与本轮目标 ${target} 一致）`);
    }
    const scriptRepo = resolve(dirname(deployScript), "..");
    if (scriptRepo !== ROOT) {
      notes.push(
        `⚠ deploy-bare.py 在 ${scriptRepo}（不是当前 worktree）：它上传的 deploy/ 脚本取自那里，` +
          "worktree 里改了 deploy/ 不会被带上",
      );
    }
  } else {
    notes.push("未找到 .superpowers/deploy-bare.py（--deploy 时才需要）");
  }

  artifacts.push(artifact("packages/desktop/package.json", DESKTOP_PKG));
  return { exitCode: 0, notes, artifacts };
}

/* ------------------------------ 2. 构建 ------------------------------ */

function planBuild() {
  return {
    commands: [
      {
        cmd: "pnpm -r build",
        cwd: ROOT,
        writes: "packages/{shared,server,web}/dist/**、packages/web/dist/index.html 等",
        note: "云端口径：不注入 VITE_API_BASE（同源相对路径）",
      },
    ],
    preview: ["顺序由 pnpm 拓扑决定：shared → server/web"],
  };
}

async function runBuild(ctx) {
  const result = await run(ctx, {
    cmd: "pnpm -r build",
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.build,
  });
  if (result.code !== 0) {
    throw new StepError(`门禁构建失败：pnpm -r build 退出码 ${formatExitCode(result.code)}`, {
      tail: result.tail40,
    });
  }

  const required = [
    "packages/web/dist/index.html",
    "packages/server/dist/index.js",
    "packages/shared/dist/index.js",
  ];
  const artifacts = required.map((rel) => artifact(rel, join(ROOT, rel)));
  const missing = artifacts.filter((item) => item.size === null);
  if (missing.length) {
    throw new StepError(`构建「成功」但产物缺失：${missing.map((m) => m.label).join("，")}`, {
      hint: "空站点/缺 dist 不报错，只会线上白屏——比缺文件更难查。先看该包的 build 脚本。",
    });
  }
  return { exitCode: 0, notes: [`产物 ${artifacts.length} 项齐全`], artifacts };
}

/* ------------------------------ 3. 逐包测试 ------------------------------ */

function planTests(ctx) {
  if (ctx.opts.skipTests) return { commands: [], preview: ["--skip-tests 已开：第 3 步跳过"] };
  const packages = discoverPackages();
  if (ctx.opts.testCmd) {
    return {
      commands: [
        {
          cmd: ctx.opts.testCmd.replaceAll("{package}", "<包名>").replaceAll("{dir}", "<packages/目录>"),
          cwd: ROOT,
          writes: "（无；测试临时文件）",
          note: "【调试】--test-cmd 覆盖了真实测试命令",
        },
      ],
      preview: [`将对 ${packages.length} 个包执行该命令（每包最多 2 次）`],
    };
  }
  return {
    commands: packages.map((pkg) => ({
      cmd: `pnpm --filter ${pkg.name} test`,
      cwd: ROOT,
      writes: "（无；测试临时文件）",
      note: "失败后等 retry-delay 再试一次",
    })),
    preview: [`包：${packages.map((pkg) => pkg.name).join("、")}（串行，单包失败重试一次）`],
  };
}

function testCommandFor(ctx, pkg) {
  if (!ctx.opts.testCmd) return `pnpm --filter ${pkg.name} test`;
  return ctx.opts.testCmd
    .replaceAll("{package}", pkg.name)
    .replaceAll("{filter}", pkg.name)
    .replaceAll("{dir}", join("packages", pkg.dir));
}

async function runTests(ctx) {
  const packages = discoverPackages();
  if (!packages.length) {
    throw new StepError("没有找到带 test 脚本的 workspace 包", {
      hint: "检查 packages/*/package.json 的 scripts.test；或本轮确实没有测试时加 --skip-tests。",
    });
  }

  const timeoutMs = ctx.opts.timeout || STEP_TIMEOUTS.testPackage;
  const results = [];
  let retried = 0;

  for (let index = 0; index < packages.length; index += 1) {
    const pkg = packages[index];
    const cmd = testCommandFor(ctx, pkg);
    print(`\n▶ 逐包测试 ${index + 1}/${packages.length}：${pkg.name}`);

    const attempts = [];
    let last = null;
    let passed = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2) {
        print(
          `  ↻ ${pkg.name} 第一次失败（退出码 ${formatExitCode(last.code)}），` +
            `${ctx.opts.retryDelay}ms 后重试一次`,
        );
        await sleep(ctx.opts.retryDelay);
      }
      const result = await run(ctx, { cmd, cwd: ROOT, timeoutMs });
      attempts.push({
        attempt,
        code: result.code,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      });
      last = result;
      if (result.code === 0) {
        passed = true;
        break;
      }
    }

    if (!passed) {
      const crashHint = isWindowsFatalCrash(last.code)
        ? "（0xC0000409 = Windows 快速失败，本机偶发；但连续两次同名失败按真实失败处理）"
        : "";
      throw new StepError(
        `包 ${pkg.name} 测试连续 2 次失败（退出码 ${formatExitCode(last.code)}）${crashHint}`,
        { tail: last.tail40 },
      );
    }

    if (attempts.length > 1) retried += 1;
    results.push({
      name: pkg.name,
      attempts,
      durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0),
    });
    const used = attempts.length > 1 ? `，重试后通过（第 ${attempts.length} 次）` : "";
    print(`  ✓ ${pkg.name} 通过${used}`);
  }

  ctx.testSummary = { total: packages.length, retried };
  return {
    exitCode: 0,
    notes: [
      `${results.length}/${packages.length} 个包通过` + (retried ? `，其中 ${retried} 个包重试过一次` : "，无重试"),
    ],
    artifacts: [],
    data: results,
  };
}

/* ------------------------------ 4. bump 版本 ------------------------------ */

function planBump(ctx) {
  if (!ctx.opts.bump) return { commands: [], preview: ["未指定 --bump：版本号保持不变"] };
  const predicted = predictBump(ctx.opts.bump, ctx.version);
  return {
    commands: [
      {
        cmd: `node scripts/bump-version.mjs auto ${ctx.opts.bump}`,
        cwd: ROOT,
        writes:
          "package.json、packages/{desktop,web,server,shared}/package.json、README.md（当前版本行）",
        note: "数字只增不减；其余位原样保留",
      },
    ],
    preview: [
      `预计 ${ctx.version} → ${predicted ?? "(版本格式不识别)"}`,
      `一轮跑完的姿势：先把 CHANGELOG 顶部条目写成 ## ${predicted ?? "<目标版本>"}（${todayString()}）— 标题，再带 --bump 跑；否则第 5 步会停`,
    ],
  };
}

async function runBump(ctx) {
  const before = ctx.version;
  const result = await run(ctx, {
    cmd: `node scripts/bump-version.mjs auto ${ctx.opts.bump}`,
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.bump,
  });
  if (result.code !== 0) {
    throw new StepError(`bump 失败：退出码 ${formatExitCode(result.code)}`, { tail: result.tail40 });
  }

  const after = loadVersion();
  ctx.versionBefore = before;
  ctx.version = after;

  const notes = [`版本 ${before} → ${after}（${ctx.opts.bump}）`];
  const top = readTopChangelogEntry();
  const topVersion = top ? /^##\s+(\S+)/.exec(top.heading)?.[1] : null;
  if (topVersion === after) {
    notes.push("CHANGELOG 顶部已是新版本，第 5 步可直接通过");
  } else {
    notes.push(
      `CHANGELOG 顶部仍是 ${topVersion ?? "(无可识别标题)"}：补一条 ## ${after}（${todayString()}）— 标题 后，**去掉 --bump** 重跑`,
    );
  }

  const artifacts = [
    artifact("package.json", join(ROOT, "package.json")),
    artifact("packages/desktop/package.json", DESKTOP_PKG),
    artifact("packages/web/package.json", join(ROOT, "packages", "web", "package.json")),
    artifact("packages/server/package.json", join(ROOT, "packages", "server", "package.json")),
    artifact("packages/shared/package.json", join(ROOT, "packages", "shared", "package.json")),
    artifact("README.md", join(ROOT, "README.md")),
  ];
  return {
    exitCode: 0,
    notes,
    artifacts,
  };
}

/* ------------------------------ 5. CHANGELOG 校验 ------------------------------ */

function planChangelogCheck(ctx) {
  return {
    commands: [],
    preview: [
      `要求 CHANGELOG.md 顶部条目为：## ${ctx.version}（YYYY-MM-DD）— 一句话标题`,
      "静态检查，不写文件；不通过则第 6 步不会执行",
    ],
  };
}

function readTopChangelogEntry() {
  const text = readFileSync(CHANGELOG, "utf8");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^##\s+/.test(line));
  if (index < 0) return null;
  return { heading: lines[index].trim(), lineNumber: index + 1 };
}

async function runChangelogCheck(ctx) {
  if (!existsSync(CHANGELOG)) {
    throw new StepError("找不到 CHANGELOG.md", { hint: "仓库根应当有它；别在错误的目录跑。" });
  }
  const top = readTopChangelogEntry();
  if (!top) {
    throw new StepError("CHANGELOG.md 里没有二级标题（## ...）", {
      hint: `在顶部加：## ${ctx.version}（${todayString()}）— 一句话标题`,
    });
  }
  const match = /^##\s+(\S+)（(\d{4}-\d{2}-\d{2})）\s*—\s*(.+)$/.exec(top.heading);
  if (!match) {
    throw new StepError(`CHANGELOG 顶部条目格式不对：${top.heading}`, {
      hint: "格式固定为 `## d.x.y.z（YYYY-MM-DD）— 一句话标题`（全角括号 + 破折号）。build-changelog.mjs 也认这个版式。",
      tail: [top.heading],
    });
  }
  const [, version, date, title] = match;
  if (version !== ctx.version) {
    throw new StepError(`CHANGELOG 顶部是 ${version}，当前 hemingVersion 是 ${ctx.version}`, {
      hint:
        ctx.opts.bump
          ? `刚 bump 到 ${ctx.version}：在顶部补一条 ## ${ctx.version}（${todayString()}）— 标题，然后**去掉 --bump** 重跑（版本已 bump 过，再 bump 会又进一位）。`
          : `要么补一条 ## ${ctx.version}（…）的新条目，要么确认版本号是不是漏 bump 了。`,
      tail: [`CHANGELOG.md:${top.lineNumber}  ${top.heading}`],
    });
  }
  if (!title.trim()) {
    throw new StepError("CHANGELOG 顶部条目缺少标题", {
      hint: "`—` 后面写一句话说明这一版做了什么（设置区「更新日志」卡会原样展示）。",
    });
  }

  const notes = [`顶部条目 ${version}（${date}）— ${title}`];
  if (date !== todayString()) {
    notes.push(`⚠ 条目日期 ${date} 不是今天（${todayString()}）：确认不是复制了旧标题`);
  }
  return { exitCode: 0, notes, artifacts: [artifact("CHANGELOG.md", CHANGELOG)] };
}

/* ------------------------------ 6. 生成 changelog 模块 ------------------------------ */

function planChangelog() {
  return {
    commands: [
      {
        cmd: "node scripts/build-changelog.mjs",
        cwd: ROOT,
        writes: "packages/web/src/generated/changelog.ts",
        note: "忘了跑会被 changelog-sync.test.js 抓出来",
      },
    ],
    preview: [],
  };
}

async function runChangelog(ctx) {
  const result = await run(ctx, {
    cmd: "node scripts/build-changelog.mjs",
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.changelog,
  });
  if (result.code !== 0) {
    throw new StepError(`build-changelog 失败：退出码 ${formatExitCode(result.code)}`, {
      tail: result.tail40,
    });
  }
  if (!existsSync(CHANGELOG_TS)) {
    throw new StepError(`生成脚本返回 0，但 ${CHANGELOG_TS} 不存在`, {
      hint: "看 build-changelog.mjs 的目标路径是否被改过。",
    });
  }
  const generated = readFileSync(CHANGELOG_TS, "utf8");
  if (!generated.includes(`"${ctx.version}"`)) {
    throw new StepError(`生成的 changelog.ts 里没有当前版本 ${ctx.version}`, {
      hint: "说明 CHANGELOG 顶部条目没被解析进去：检查标题版式与 --bump 后的版本号。",
    });
  }
  const unchanged = /无变化/.test(result.output);
  return {
    exitCode: 0,
    notes: [
      unchanged
        ? `packages/web/src/generated/changelog.ts 无变化（内容已与 CHANGELOG 一致，未写盘，含 ${ctx.version}）`
        : `已写入 packages/web/src/generated/changelog.ts（含 ${ctx.version}）`,
    ],
    artifacts: [artifact("packages/web/src/generated/changelog.ts", CHANGELOG_TS)],
  };
}

/* ------------------------------ 7. 打包安装包 ------------------------------ */

function planDesktop(ctx) {
  if (!ctx.opts.desktop) {
    return { commands: [], preview: ["未指定 --desktop：不打包安装包"] };
  }
  const releaseDir = nextReleaseDir(ctx);
  const preview = [
    `产物目录：${releaseDir}${existsSync(releaseDir) ? "（已存在）" : "（不存在，第 7 步才创建）"}`,
    "环境：HEMING_RELEASE_DIR 指向上面这个目录；NODE_OPTIONS 清空（绕开会话级删除 shim）",
  ];
  const existing = findInstallers(releaseDir, ctx.version);
  preview.push(
    existing.length
      ? `该目录已有同版本安装包 ${basename(existing[0])}（本次会重新生成，旧文件不自动删除）`
      : "该目录还没有同版本安装包",
  );
  return {
    commands: [
      {
        cmd: "pnpm -w run dist:desktop",
        cwd: ROOT,
        writes:
          "packages/web/dist/**（注入 VITE_API_BASE 后就地重写）、packages/desktop/web-dist/**、" +
          "packages/desktop/runtime/.pyc 校验、<release dir>/{win-unpacked,latest.yml,*.exe,*.blockmap}",
        note: "= build-desktop-web.mjs（注入地址 + 拷 web-dist）→ build-desktop.mjs --win nsis",
      },
    ],
    preview,
  };
}

async function runDesktop(ctx) {
  const releaseDir = nextReleaseDir(ctx);
  mkdirSync(releaseDir, { recursive: true });
  ctx.releaseDir = releaseDir;

  const env = {
    HEMING_RELEASE_DIR: releaseDir,
    // 会话级 node-safe-delete-shim 会拦「单轮删除超过 50 个文件」，
    // electron-builder 清 win-unpacked 必然触发（见 VERSION-MANAGEMENT「环境坑」1）。
    NODE_OPTIONS: "",
  };
  for (const [name, sub] of [
    ["ELECTRON_CACHE", "electron"],
    ["ELECTRON_BUILDER_CACHE", "electron-builder"],
  ]) {
    const cacheDir = join(ROOT, ".tmp", "cache", sub);
    if (existsSync(cacheDir)) env[name] = cacheDir;
  }

  const result = await run(ctx, {
    cmd: "pnpm -w run dist:desktop",
    cwd: ROOT,
    env,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.desktop,
  });
  if (result.code !== 0) {
    throw new StepError(`打包失败：退出码 ${formatExitCode(result.code)}`, { tail: result.tail40 });
  }
  ctx.desktopBuilt = true;

  // —— 产物核对（deploy.md §9 的坑 1 与坑 4）——
  const notes = [];
  const artifacts = [];
  const installers = findInstallers(releaseDir, ctx.version);
  if (!installers.length) {
    throw new StepError(`打包返回 0，但 ${releaseDir} 里没有含 ${ctx.version} 的 .exe`, {
      hint: "检查 build.nsis.artifactName 是否用了 ${env.HEMING_APP_VERSION}，以及是否打到了别的目录。",
    });
  }
  const installer = installers[0];
  artifacts.push(artifact("安装包", installer));

  const latestYml = join(releaseDir, "latest.yml");
  if (!existsSync(latestYml)) {
    throw new StepError("产物目录里没有 latest.yml", {
      hint: "客户端靠它判断有没有新版本——缺了会永远提示「已是最新」，界面上与正常无差别。确认 build-desktop.mjs 的 --publish always 没被覆盖。",
    });
  }
  artifacts.push(artifact("latest.yml", latestYml));

  const blockmap = `${installer}.blockmap`;
  if (existsSync(blockmap)) artifacts.push(artifact("差分索引", blockmap));
  else notes.push("⚠ 没找到 .blockmap（差分更新会退化成整包下载）");

  // latest.yml 的 sha512 与本地安装包对照（base64）。脚本能替人做的部分先做掉。
  const ymlText = readFileSync(latestYml, "utf8");
  const ymlSha = /^\s*sha512:\s*(\S+)\s*$/m.exec(ymlText)?.[1] ?? null;
  const ymlSize = Number(/^\s*size:\s*(\d+)\s*$/m.exec(ymlText)?.[1] ?? Number.NaN);
  const actualSha = await sha512Base64File(installer);
  ctx.installerSha512 = actualSha;
  if (ymlSha && ymlSha !== actualSha) {
    throw new StepError("latest.yml 的 sha512 与安装包实测不符", {
      hint: "别上传：客户端会因校验失败拒绝更新。重新出包或修正 latest.yml。",
    });
  }
  if (Number.isFinite(ymlSize) && ymlSize !== statSync(installer).size) {
    throw new StepError(
      `latest.yml 的 size=${ymlSize} 与安装包实测 ${statSync(installer).size} 不符`,
      { hint: "latest.yml 写的是别的文件；检查 artifactName 与输出目录是否混用了旧产物。" },
    );
  }
  notes.push(ymlSha ? "latest.yml 的 sha512/size 与安装包一致" : "⚠ latest.yml 没有 sha512 行，无法自校验");

  // 内嵌 web 产物核对（r31 事故：包成功、版本号对、内容是上一版）
  if (ctx.opts.verifyBundle) {
    const embeddedDir = join(releaseDir, "win-unpacked", "resources", "web", "assets");
    const webDistDir = join(ROOT, "packages", "desktop", "web-dist", "assets");
    if (!existsSync(embeddedDir)) {
      notes.push(`⚠ 找不到内嵌产物目录 ${embeddedDir}（打包布局变了？内嵌核对已跳过）`);
    } else {
      const embeddedJs = readdirSync(embeddedDir).filter((name) => name.endsWith(".js"));
      const webDistJs = existsSync(webDistDir)
        ? readdirSync(webDistDir).filter((name) => name.endsWith(".js"))
        : [];
      const versionHit = embeddedJs.some((name) =>
        readFileSync(join(embeddedDir, name), "utf8").includes(ctx.version),
      );
      if (!versionHit) {
        throw new StepError(`安装包内嵌的 web 产物里没有版本串 ${ctx.version}`, {
          hint: "包里的界面是旧的（d.29 的 r31 就这么作废的）。确认走的是 `pnpm -w run dist:desktop`（先 build-desktop-web 再打包），不是单独 build-desktop.mjs。",
        });
      }
      const onlyEmbedded = embeddedJs.filter((name) => !webDistJs.includes(name));
      if (webDistJs.length && onlyEmbedded.length) {
        throw new StepError(
          `内嵌产物与 packages/desktop/web-dist 不同名：${onlyEmbedded.slice(0, 3).join("，")}`,
          { hint: "内嵌的不是本轮 web-dist；重跑 --only=desktop 前先确认 build-desktop-web 成功。" },
        );
      }
      notes.push(`内嵌产物含版本串 ${ctx.version}，且与 web-dist 同名（${embeddedJs.length} 个 js）`);
      artifacts.push(artifact("内嵌主界面产物", join(embeddedDir, embeddedJs[0])));
    }
  } else {
    notes.push("已按 --no-verify-bundle 跳过内嵌产物核对");
  }

  // deploy.md §2 ★：build-desktop-web 会就地重写 packages/web/dist（注入 VITE_API_BASE）。
  // 只打包不部署时这里必须提醒——否则下次手工打云端 tar 会带上写死 IP 的产物。
  notes.push(
    ctx.opts.deploy
      ? "packages/web/dist 现已变成注入 VITE_API_BASE 的桌面版；第 8 步打 tar 前会自动恢复云端口径"
      : "⚠ packages/web/dist 已被就地重写为注入 VITE_API_BASE 的桌面版：手工上云前务必重跑 `pnpm --filter @heming/web build`",
  );

  return { exitCode: 0, notes, artifacts };
}

/* ------------------------------ 8. 备份 + 部署 ------------------------------ */

function planDeploy(ctx) {
  if (!ctx.opts.deploy) {
    return { commands: [], preview: ["未指定 --deploy：不部署（默认永不部署）"] };
  }
  const script = locateDeployScript();
  const python = locatePython();
  const shownScript = script ?? ".superpowers/deploy-bare.py";
  const call = (stage) => `${shellQuote(python)} -u ${shellQuote(shownScript)} ${stage}`;
  const tar = ctx.opts.deployTar ? resolve(process.cwd(), ctx.opts.deployTar) : join(tmpdir(), `heming-${ctx.version}.tar.gz`);
  const preview = [
    `部署脚本：${script ?? "(未找到 .superpowers/deploy-bare.py)"}`,
    `Python：${python}`,
    `备份目录：${backupDirs(script).join("、")}`,
    `部署包：${tar}${ctx.opts.deployTar ? "（复用已有）" : "（第 8 步现场打）"}`,
    "顺序：backup（强制，失败即停）→ 打/校验 tar → upload → install → smoke",
  ];
  return {
    commands: [
      {
        cmd: call("backup"),
        cwd: ROOT,
        writes: "服务器 /root/heming-data-<日期>.tar.gz，并 SFTP 拷回本机 .tmp/backups/",
        note: "备份不通过 → 整轮中止，install 不会被调用",
      },
      {
        cmd: `${TAR_BIN} ${TAR_EXCLUDES.map((item) => `--exclude ${item}`).join(" ")} -czf ${shellQuote(tar)} .`,
        cwd: ROOT,
        writes: `${tar}（仓库外，避免把自身卷进归档）`,
        note: "随后 tar -tzf 校验：不该有的必须 0、必须有的至少 1",
      },
      {
        cmd: call(`upload ${shellQuote(tar)}`),
        cwd: ROOT,
        writes: "服务器 /root/heming-<版本>.tar.gz、/root/{provision,install-app}.sh",
        note: "SFTP；远端文件名由 deploy-bare.py 的 VERSION 常量决定",
      },
      {
        cmd: call("install"),
        cwd: ROOT,
        writes: "服务器 /opt/heming/app、/opt/heming/keep、nginx 站点、systemd 单元",
        note: "云端零构建；末尾轮询 /api/health",
      },
      {
        cmd: call("smoke"),
        cwd: ROOT,
        writes: "（无）",
        note: '要求输出含 "ok":true',
      },
    ],
    preview,
  };
}

async function runDeploy(ctx) {
  /* —— 前置检查：任何一条不满足都不碰服务器 —— */
  const script = locateDeployScript();
  if (!script) {
    throw new StepError("找不到 .superpowers/deploy-bare.py", {
      hint: "该文件在主检出 D:/Heming/.superpowers/ 下且不入库；从 worktree 跑时会向上查找主检出。确认它存在，或手工按 docs/deploy.md §2–§3 部署。",
    });
  }
  ctx.deployScript = script;
  const scriptVersion = readDeployVersion(script);
  if (!scriptVersion) {
    throw new StepError(`读不到 ${script} 的 VERSION 常量`, { hint: "脚本头部应当是 VERSION = \"d.x.y.z\"。" });
  }
  if (scriptVersion !== ctx.version) {
    throw new StepError(
      `deploy-bare.py 的 VERSION=${scriptVersion} 与当前 ${ctx.version} 不一致`,
      {
        hint:
          "它决定远端 tar 名与 install 参数（/root/heming-<VERSION>.tar.gz）。" +
          "不一致时上传的包与 install 找的包对不上，必须先改那个常量或用对应版本部署。",
      },
    );
  }

  const python = locatePython();
  const pyVersion = await capture(ctx, `${shellQuote(python)} --version`);
  if (pyVersion.code !== 0) {
    throw new StepError(`Python 不可用：${python}`, {
      hint: "deploy-bare.py 依赖 paramiko。用 HEMING_PYTHON 指定解释器，或先装依赖（见 .superpowers/deploy-bare.py 头部）。",
      tail: pyVersion.tail40,
    });
  }

  const artifacts = [];
  const notes = [];
  const notesWarn = [];
  const scriptRepo = resolve(dirname(script), "..");
  if (scriptRepo !== ROOT) {
    notesWarn.push(`deploy-bare.py 在 ${scriptRepo}，它上传的 deploy/ 脚本取自那里（不是当前 worktree）`);
  }

  /* —— 8a. 备份（强制）—— */
  const backupStarted = Date.now();
  print("\n[8a] 备份（强制；不通过就不会有 install）");
  const backup = await run(ctx, {
    cmd: `${shellQuote(python)} -u ${shellQuote(script)} backup`,
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.deployStage,
  });
  if (backup.code !== 0) {
    throw new StepError(`备份失败（退出码 ${formatExitCode(backup.code)}），整轮中止`, {
      hint:
        "备份不通过就不许 install——这是脚本强制的红线。手工跑 `python -u .superpowers/deploy-bare.py backup` 查 SSH 凭据 / paramiko / 服务状态；确认库里数据安全后再重试。",
      tail: backup.tail40,
    });
  }
  const backups = freshBackups(backupDirs(script), backupStarted);
  if (!backups.length) {
    throw new StepError("备份命令返回 0，但本机 .tmp/backups/ 里没有本次新生成的备份文件", {
      hint:
        "备份只留在服务器上等于没备份（2026-10-22 实例重置把库和卷备份一起清了）。检查 deploy-bare.py 的 SFTP 取回那一步与本机落点。",
    });
  }
  const latestBackup = backups[0];
  artifacts.push(artifact("本机备份", latestBackup.path));
  notes.push(`备份已落本机：${latestBackup.path}（${formatBytes(latestBackup.size)}）`);

  /* —— 8b. 部署包：复用或现场打 —— */
  let tarPath;
  if (ctx.opts.deployTar) {
    tarPath = resolve(process.cwd(), ctx.opts.deployTar);
    if (!existsSync(tarPath)) {
      throw new StepError(`--deploy-tar 指向的文件不存在：${tarPath}`, { hint: "给绝对路径最稳。" });
    }
    const size = statSync(tarPath).size;
    if (size <= 0) throw new StepError(`--deploy-tar 是空文件：${tarPath}`);
    notes.push(`复用部署包 ${basename(tarPath)}（${formatBytes(size)}）`);
  } else {
    // 顺序陷阱（deploy.md §2 ★）：--desktop 会就地重写 packages/web/dist（注入 VITE_API_BASE）。
    // 若本轮打过包，上云前必须把 web 产物恢复成云端口径，否则线上就是写死绝对地址的那份。
    if (ctx.desktopBuilt) {
      print("\n[8b-1] 本轮打过安装包 → 先恢复云端口径的 web 产物（不注入 VITE_API_BASE）");
      const rebuild = await run(ctx, {
        cmd: "pnpm --filter @heming/web build",
        cwd: ROOT,
        timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.build,
      });
      if (rebuild.code !== 0) {
        throw new StepError("恢复云端口径 web 产物失败，已中止（不会上传注入版产物）", {
          tail: rebuild.tail40,
        });
      }
      notes.push("上云前已重跑 web 构建恢复云端口径（避免把注入 VITE_API_BASE 的产物发上云）");
    }

    tarPath = join(tmpdir(), `heming-${ctx.version}.tar.gz`);
    print(`\n[8b-2] 打部署包 → ${tarPath}`);
    const excludeArgs = TAR_EXCLUDES.map((item) => `--exclude ${item}`).join(" ");
    const tarResult = await run(ctx, {
      cmd: `${TAR_BIN} ${excludeArgs} -czf ${shellQuote(tarPath)} .`,
      cwd: ROOT,
      timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.deployStage,
    });
    if (tarResult.code !== 0) {
      throw new StepError(`打部署包失败（退出码 ${formatExitCode(tarResult.code)}）`, {
        hint: "GNU tar 的 --exclude 只认裸段名；产物必须写到树外，否则会报 `file changed as we read it`。",
        tail: tarResult.tail40,
      });
    }
    const size = statSync(tarPath).size;
    if (size <= 0) throw new StepError("打出来的部署包是空文件");
    if (size > 300 * 1024 * 1024) {
      throw new StepError(`部署包 ${formatBytes(size)} 过大：排除表大概率漏了（预期 5MB 量级）`, {
        hint: "先把 tar -tzf 清单里的 node_modules / release / @hemingdesktop 找出来，别急着上传。",
      });
    }
    if (size > 50 * 1024 * 1024) notesWarn.push(`部署包 ${formatBytes(size)} 偏大（预期 5MB 量级），核对排除表`);

    const list = await capture(ctx, `${TAR_BIN} -tzf ${shellQuote(tarPath)}`, {
      timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.deployStage,
    });
    if (list.code !== 0) throw new StepError("tar -tzf 读取失败", { tail: list.tail40 });
    const entries = list.output.split(/\r?\n/).filter(Boolean);
    const forbidden = entries.filter((line) => TAR_FORBIDDEN.test(line));
    if (forbidden.length) {
      throw new StepError(`部署包里混进了 ${forbidden.length} 项不该上传的内容`, {
        hint: "排除表必须用裸段名（--exclude node_modules），不能写 ./node_modules。",
        tail: forbidden.slice(0, 10),
      });
    }
    const missing = TAR_REQUIRED.filter((needle) => !entries.some((line) => line.includes(needle)));
    if (missing.length) {
      throw new StepError(`部署包缺少必须上传的产物：${missing.join("，")}`, {
        hint: "空站点/缺 dist 不报错，只会线上白屏。先跑 pnpm -r build 再重打。",
      });
    }
    notes.push(`部署包 ${formatBytes(size)}，清单校验通过（${entries.length} 项，不该有的 0 项）`);
    ctx.tarSha256 = await sha256File(tarPath);
  }
  ctx.tarPath = tarPath;
  artifacts.push(artifact("部署包", tarPath));

  /* —— 8c. 上传 —— */
  print("\n[8c] 上传");
  const upload = await run(ctx, {
    cmd: `${shellQuote(python)} -u ${shellQuote(script)} upload ${shellQuote(tarPath)}`,
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.deployStage,
  });
  if (upload.code !== 0) {
    throw new StepError(`上传失败（退出码 ${formatExitCode(upload.code)}）`, {
      hint: "服务器上可能已有半份文件；重跑 upload 是幂等的。别连击 22 端口（云盾会封源 IP）。",
      tail: upload.tail40,
    });
  }

  /* —— 8d. install —— */
  print("\n[8d] 安装（云端零构建）");
  const install = await run(ctx, {
    cmd: `${shellQuote(python)} -u ${shellQuote(script)} install`,
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.deployStage,
  });
  if (install.code !== 0) {
    throw new StepError(`安装失败（退出码 ${formatExitCode(install.code)}）`, {
      hint: "回滚靠 /opt/heming/keep 里的旧包重放（docs/deploy.md §5）。先看 install.log 里的 INSTALL DONE 前最后几行。",
      tail: install.tail40,
    });
  }

  /* —— 8e. smoke —— */
  print("\n[8e] 冒烟（服务/健康检查/资源）");
  const smoke = await run(ctx, {
    cmd: `${shellQuote(python)} -u ${shellQuote(script)} smoke`,
    cwd: ROOT,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.deployStage,
  });
  if (smoke.code !== 0) {
    throw new StepError(`冒烟失败（退出码 ${formatExitCode(smoke.code)}）`, { tail: smoke.tail40 });
  }
  if (!smoke.output.includes('"ok":true')) {
    throw new StepError('冒烟命令返回 0，但输出里没有 {"ok":true}', {
      hint: "服务没起来或 /api/health 没通：journalctl -u heming-api -n 30 --no-pager。",
      tail: smoke.tail40,
    });
  }
  notes.push("install + smoke 通过（服务器本机 /api/health 为 {\"ok\":true}）");

  return { exitCode: 0, notes, warnings: notesWarn, artifacts };
}

/* ------------------------------ 9. 发布更新源 ------------------------------ */

/**
 * 第 9 步用哪个发布入口。
 *
 * - Windows：本机没有 Git Bash，`bash scripts/publish-update.sh` 会落到 WSL，
 *   报 `0x8007054f`（找不到提供程序）——发布链因此断过，只能手工 Python 补。
 *   优先走 Node 版 `scripts/publish-update.mjs`（同样用 python+paramiko 传，
 *   语义与 shell 版一致：上传 → stat 大小 + sha512 校验 → 打印「校验通过」）。
 * - 非 Windows：`publish-update.sh` 本来就能用，保留原路径，行为零变化。
 * - Node 版缺失时才在 Windows 上回退 shell（并提示可能需要补文件）。
 */
function publishCommands() {
  const nodeScript = join(ROOT, "scripts", "publish-update.mjs");
  const useNode = process.platform === "win32" && existsSync(nodeScript);
  const base = useNode ? "node scripts/publish-update.mjs" : "bash scripts/publish-update.sh";
  return { via: useNode ? "node" : "shell", dry: `${base} --dry-run`, real: base };
}

function planPublish(ctx) {
  if (!ctx.opts.publish) {
    return { commands: [], preview: ["未指定 --publish：不发布到更新源"] };
  }
  const releaseDir = resolvePublishDir(ctx);
  const pub = publishCommands();
  const preview = [
    `产物目录：${releaseDir}`,
    process.env.HEMING_SSH_PWD
      ? "HEMING_SSH_PWD 已设置（不会打印值）"
      : pub.via === "node"
        ? "HEMING_SSH_PWD 未设置：Node 版会回落到本机 .superpowers/deploy-*.py 里的既有凭据"
        : "⚠ HEMING_SSH_PWD 未设置：真发布会拒绝（--dry-run 不受影响）",
  ];
  const installers = findInstallers(releaseDir, ctx.version);
  preview.push(installers.length ? `安装包：${basename(installers[0])}` : "⚠ 该目录没有含当前版本号的安装包");
  preview.push(`latest.yml：${existsSync(join(releaseDir, "latest.yml")) ? "存在" : "⚠ 不存在"}`);
  return {
    commands: [
      {
        cmd: pub.dry,
        cwd: ROOT,
        writes: "（无，只打印要传什么）",
        note: `${pub.via === "node" ? "Node 版发布脚本" : "shell 版发布脚本"}：然后才真传`,
      },
      {
        cmd: pub.real,
        cwd: ROOT,
        writes: "服务器 /opt/heming/updates/{latest.yml,安装包,blockmap}",
        note: "上传后校验远端大小与 sha512；win32 走 Node 版，不再依赖 Git Bash",
      },
    ],
    preview,
  };
}

async function runPublish(ctx) {
  // shell 版只认环境变量；Node 版（win32）还能回落到本机 .superpowers 里的既有凭据，
  // 所以「缺 HEMING_SSH_PWD」只对 shell 入口是硬错误。
  const pub = publishCommands();
  if (pub.via === "shell" && !process.env.HEMING_SSH_PWD) {
    throw new StepError("未设置 HEMING_SSH_PWD", {
      hint: "PowerShell：`$env:HEMING_SSH_PWD='***'`；bash：`export HEMING_SSH_PWD='***'`。密码只走环境变量，不落盘。",
    });
  }

  const releaseDir = resolvePublishDir(ctx);
  ctx.releaseDir = releaseDir;
  if (!existsSync(releaseDir)) {
    throw new StepError(`产物目录不存在：${releaseDir}`, { hint: "先跑 --desktop 出包，或用 --release-dir 指向已有产物。" });
  }
  const installers = findInstallers(releaseDir, ctx.version);
  if (!installers.length) {
    throw new StepError(`${releaseDir} 里没有含 ${ctx.version} 的安装包`, {
      hint: "打包与发布必须指同一目录（build-desktop.mjs 与 publish-update.sh 都读 HEMING_RELEASE_DIR）。",
    });
  }
  const latestYml = join(releaseDir, "latest.yml");
  if (!existsSync(latestYml)) {
    throw new StepError(`缺少 ${latestYml}`, {
      hint: "没有更新清单，客户端永远提示「已是最新」。重新打包（build-desktop.mjs 默认 --publish always）。",
    });
  }

  const env = { HEMING_RELEASE_DIR: releaseDir };
  print(`\n[9a] 发布预览（入口：${pub.via === "node" ? "node scripts/publish-update.mjs" : "bash scripts/publish-update.sh"}）`);
  const dry = await run(ctx, {
    cmd: pub.dry,
    cwd: ROOT,
    env,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.publish,
  });
  if (dry.code !== 0) {
    throw new StepError("发布预览（--dry-run）失败：还没真传", { tail: dry.tail40 });
  }

  print("\n[9b] 真传（大小与 sha512 由脚本端校验）");
  const real = await run(ctx, {
    cmd: pub.real,
    cwd: ROOT,
    env,
    timeoutMs: ctx.opts.timeout || STEP_TIMEOUTS.publish,
  });
  if (real.code !== 0) {
    throw new StepError(`上传失败（退出码 ${formatExitCode(real.code)}）`, { tail: real.tail40 });
  }
  if (!/校验通过/.test(real.output)) {
    throw new StepError("上传命令返回 0，但输出里没有「校验通过」", {
      hint: "别当成功：远端可能没文件。手工 ls -la /opt/heming/updates 核对。",
      tail: real.tail40,
    });
  }

  const artifacts = [
    artifact("安装包", installers[0]),
    artifact("latest.yml", latestYml),
  ];
  const blockmap = `${installers[0]}.blockmap`;
  if (existsSync(blockmap)) artifacts.push(artifact("差分索引", blockmap));
  return {
    exitCode: 0,
    notes: ["上传完成，远端大小与 sha512 均与本地一致（脚本内校验）"],
    artifacts,
  };
}

/* ------------------------------ 10. 证据清单 ------------------------------ */

function planEvidence() {
  return {
    commands: [],
    preview: ["汇总前 9 步的退出码 / 耗时 / 产物，并打印人工校验清单与本轮状态"],
  };
}

function statusLabel(status) {
  if (status === "ok") return "OK";
  if (status === "skipped") return "SKIP";
  if (status === "failed") return "FAIL";
  return "—";
}

function printEvidenceTable(ctx) {
  print("各步结果（第 10 步本身就是本表，不重复列出）：");
  const header = ["#", "步骤", "状态", "退出码", "耗时", "产物"];
  const rows = ctx.results.map((item) => [
    String(item.n),
    item.title,
    statusLabel(item.status),
    item.exitCode === null || item.exitCode === undefined ? "—" : formatExitCode(item.exitCode),
    item.durationMs === null || item.durationMs === undefined ? "—" : formatDuration(item.durationMs),
    item.artifacts.length ? `${item.artifacts.length} 项` : "—",
  ]);
  const widths = header.map((cell, index) =>
    Math.max(dispWidth(cell), ...rows.map((row) => dispWidth(row[index] ?? ""))),
  );
  const renderRow = (row) => row.map((cell, index) => padEndDisp(cell ?? "", widths[index])).join("  ");
  print(renderRow(header));
  print(widths.map((width) => "─".repeat(width)).join("  "));
  for (const row of rows) print(renderRow(row));
}

function printArtifacts(ctx) {
  const items = [];
  for (const result of ctx.results) {
    for (const item of result.artifacts) items.push({ ...item, step: result.n });
  }
  if (!items.length) {
    print("\n产物：无（本轮没有产生文件）");
    return;
  }
  print("\n产物（路径 + 大小）：");
  for (const item of items) {
    const size = item.size === null ? "缺失" : formatBytes(item.size);
    print(`  [${String(item.step).padStart(2)}] ${item.label}: ${item.path}  (${size})`);
  }
}

/** 人工校验清单：脚本只能打印，不能替人确认。 */
function manualChecks(version) {
  return [
    {
      title: "线上 /api/health 与首页 200",
      command: "curl -s http://47.92.39.184/api/health",
      expect: '{"ok":true}（本机脚本只能验服务器 127.0.0.1，公网这一次要人看）',
    },
    {
      title: "线上主 bundle 与本机云端产物同名同字节",
      command: "curl -s http://47.92.39.184/ | grep -o 'assets/[^\"]*\\.js'",
      expect: "文件名与 packages/web/dist/index.html 引用的那个一致；md5 一致",
    },
    {
      title: "安装包 sha512 = latest.yml（远端那份）",
      command: "sha512sum \"<安装包>\"  vs  curl -s http://47.92.39.184/updates/latest.yml",
      expect: "两处 sha512 完全一致（脚本只比了本地 exe 与本地 latest.yml）",
    },
    {
      title: "更新源 Content-Type 与断点续传",
      command: "curl -sI http://47.92.39.184/updates/latest.yml",
      expect: "200 + application/octet-stream（不是 text/html）；Range 请求返回 206",
    },
    {
      title: "装完的显示名与版本串",
      command: "Windows「应用和功能」/ 设置区底部 / 主页徽标",
      expect: `三处都是 和鸣 ${version}`,
    },
  ];
}

function printManualChecks(ctx) {
  print("\n需要人工填写（脚本替不了的部分）：");
  for (const check of manualChecks(ctx.version)) {
    print(`  [ ] ${check.title}`);
    print(`      命令/位置：${check.command}`);
    print(`      期望：${check.expect}`);
    print(`      实测：______________________________________`);
  }
}

function printMarkdownBlock(ctx) {
  const rows = [];
  rows.push(["版本", ctx.version]);
  if (ctx.versionBefore && ctx.versionBefore !== ctx.version) rows.push(["上一版", ctx.versionBefore]);
  rows.push(["时间", timestampString()]);
  if (ctx.gitBranch) rows.push(["分支/提交", `${ctx.gitBranch} @ ${ctx.gitCommit ?? "—"}`]);
  const tests = ctx.testSummary;
  const passed = ctx.results.filter((item) => item.status === "ok").length;
  const skipped = ctx.results.filter((item) => item.status === "skipped").length;
  rows.push(["门禁", `build ${ctx.buildOk ? "通过" : "未跑"}；逐包测试 ${tests ? `${tests.total}/${tests.total}` : "未跑"}${tests?.retried ? `（${tests.retried} 包重试后通过）` : ""}`]);
  if (ctx.opts.allowDirty) rows.push(["工作区", `--allow-dirty（${ctx.dirtyCount ?? "?"} 项未提交改动）`]);
  if (ctx.installerSha512) rows.push(["安装包 sha512", ctx.installerSha512]);
  if (ctx.tarSha256) rows.push(["部署包 sha256", ctx.tarSha256]);
  if (ctx.releaseDir) rows.push(["产物目录", ctx.releaseDir]);
  rows.push(["步骤（前 9 步）", `${passed} OK / ${skipped} SKIP / ${ctx.results.length} 总`]);

  print("\n可粘进 docs/HANDOFF.md §2 的 Markdown：");
  print("");
  print("```markdown");
  print("| 项 | 值 |");
  print("|---|---|");
  for (const [key, value] of rows) print(`| ${key} | ${value} |`);
  print("```");
}

async function runEvidence(ctx) {
  print("\n════════════════════ 发版证据清单 ════════════════════\n");

  // 只读取 git 信息，供证据块使用（失败不影响结论）
  const branch = await capture(ctx, "git branch --show-current");
  const commit = await capture(ctx, "git rev-parse --short HEAD");
  ctx.gitBranch = branch.code === 0 ? branch.output.trim() : null;
  ctx.gitCommit = commit.code === 0 ? commit.output.trim() : null;
  ctx.buildOk = ctx.results.some((item) => item.id === "build" && item.status === "ok");

  printEvidenceTable(ctx);
  printArtifacts(ctx);
  printManualChecks(ctx);
  printMarkdownBlock(ctx);

  const failed = ctx.results.filter((item) => item.status === "failed");
  print(
    `\n结论：${failed.length ? "有步骤失败" : "已执行步骤全部通过"}` +
      `（${ctx.results.filter((item) => item.status === "ok").length} 步 OK，` +
      `${ctx.results.filter((item) => item.status === "skipped").length} 步跳过）。` +
      "上面的人工校验项没填完，这轮就不算收尾。",
  );
  return { exitCode: 0, notes: [], artifacts: [] };
}

/* ------------------------------------------------------------------ *
 * dry-run
 * ------------------------------------------------------------------ */

function stepDisabledReason(ctx, step) {
  if (ctx.opts.only && !ctx.opts.only.has(step.id) && step.id !== "evidence") {
    return `未列入 --only=${[...ctx.opts.only].join(",")}`;
  }
  if (ctx.opts.skip.has(step.id)) return "已按 --skip 跳过";
  return step.skipReason(ctx);
}

function printDryRun(ctx) {
  print(`和鸣发版 · --dry-run（只打印计划，不执行任何写操作）`);
  print(`仓库：${ROOT}`);
  print(`版本：${ctx.version}${ctx.opts.bump ? `（--bump=${ctx.opts.bump} 后会变）` : ""}`);
  print("");
  print("危险动作默认全关：只有给了 --deploy / --publish 才会连服务器、传文件。");
  print("");

  for (const step of STEPS) {
    const reason = stepDisabledReason(ctx, step);
    print(`── 第 ${String(step.n).padStart(2)} 步 · ${step.title} ──`);
    if (reason) {
      print(`  状态：跳过（${reason}）`);
      if (step.plan && (step.id === "desktop" || step.id === "deploy" || step.id === "publish")) {
        const plan = step.plan(ctx);
        for (const line of plan.preview ?? []) print(`  提示：${line}`);
      }
      print("");
      continue;
    }

    const plan = step.plan(ctx);
    if (!plan.commands.length) {
      print("  命令：无（静态检查 / 只打印）");
    }
    for (const command of plan.commands) {
      print(`  命令：${command.cmd}`);
      print(`  目录：${command.cwd}`);
      print(`  写入：${command.writes}`);
      if (command.note) print(`  说明：${command.note}`);
      print("");
    }
    for (const line of plan.preview ?? []) print(`  预检：${line}`);
    if ((plan.preview ?? []).length) print("");
  }

  print("── 结束 ──");
  print("以上为完整十步。真正执行请去掉 --dry-run；默认仍不会部署/上传，除非给 --deploy / --publish。");
}

/* ------------------------------------------------------------------ *
 * 失败打印
 * ------------------------------------------------------------------ */

function printFailure(step, error, ctx) {
  print("");
  print("════════════════════ 发版中止 ════════════════════");
  print(`失败步骤：第 ${step.n} 步 · ${step.title}`);
  print(`原因：${error.message}`);
  if (ctx.lastCommand) {
    print(`最后一条命令：${ctx.lastCommand.cmd}`);
    print(`工作目录：${ctx.lastCommand.cwd}`);
  }
  const tail = error.tail ?? [];
  if (tail.length) {
    print("");
    print("—— 最后 40 行输出 ——");
    for (const line of tail.slice(-40)) print(`  ${line}`);
  }
  print("");
  print("—— 下一步该做什么 ——");
  print(`  ${error.hint || step.hint}`);
  const done = ctx.results.filter((item) => item.status === "ok");
  if (done.length) {
    print("");
    print(`本轮已完成：${done.map((item) => `${item.n}.${item.id}`).join(" → ")}`);
    print("已完成步骤没有回滚：重跑本脚本时，构建/打包可重入，部署阶段各步也幂等。");
  }
  if (ctx.results.some((item) => item.artifacts.length > 0)) {
    printArtifacts(ctx);
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      errPrint(`用法错误：${error.message}`);
      errPrint("");
      errPrint(USAGE_LINES);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (opts.help) {
    print(HELP_TEXT);
    return;
  }

  const ctx = {
    opts,
    version: loadVersion(),
    versionBefore: null,
    results: [],
    lastCommand: null,
    releaseDir: null,
    desktopBuilt: false,
    testSummary: null,
    dirtyCount: null,
    tarPath: null,
    deployScript: null,
  };

  if (opts.dryRun) {
    printDryRun(ctx);
    return;
  }

  print(`和鸣发版 · 版本 ${ctx.version}`);
  print(`仓库 ${ROOT}`);
  print("十步顺序：预检 → 构建 → 逐包测试 → bump → CHANGELOG → 生成日志模块 → 打包 → 部署 → 更新源 → 证据");

  for (const step of STEPS) {
    const reason = stepDisabledReason(ctx, step);
    const started = Date.now();
    print("");
    print(`━━━ 第 ${step.n}/10 步 · ${step.title}${reason ? `（跳过：${reason}）` : ""} ━━━`);

    if (reason) {
      ctx.results.push({
        id: step.id,
        n: step.n,
        title: step.title,
        status: "skipped",
        reason,
        exitCode: null,
        durationMs: Date.now() - started,
        artifacts: [],
        notes: [],
      });
      continue;
    }

    try {
      const outcome = (await step.run(ctx)) ?? {};
      ctx.results.push({
        id: step.id,
        n: step.n,
        title: step.title,
        status: outcome.skipped ? "skipped" : "ok",
        reason: outcome.skipped ?? null,
        exitCode: outcome.exitCode ?? 0,
        durationMs: Date.now() - started,
        artifacts: outcome.artifacts ?? [],
        notes: outcome.notes ?? [],
        warnings: outcome.warnings ?? [],
      });
      for (const note of outcome.notes ?? []) print(`  · ${note}`);
      for (const warning of outcome.warnings ?? []) print(`  ⚠ ${warning}`);
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      const durationMs = Date.now() - started;
      ctx.results.push({
        id: step.id,
        n: step.n,
        title: step.title,
        status: "failed",
        error: error.message,
        exitCode: error.code ?? 1,
        durationMs,
        artifacts: [],
        notes: [],
      });
      printFailure(step, error, ctx);
      process.exitCode = 1;
      return;
    }
  }

  process.exitCode = 0;
}

process.on("SIGINT", () => {
  errPrint("\n已中断（Ctrl+C）。已完成的步骤没有回滚：构建/打包可重入，部署各阶段幂等。");
  process.exit(130);
});

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  await main();
}

export { main, runCommand, runTests, discoverPackages, predictBump };
