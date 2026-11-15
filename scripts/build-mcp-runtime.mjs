#!/usr/bin/env node
/**
 * 构建内置 MCP 运行时（打包前必跑一次，产物进安装包）。
 *
 * ## 这一版在修什么
 *
 * d.147.4.93.11 及以前，`packages/desktop/runtime/mcp-env` 是一个**裸 venv**：
 * 里面只有 `Lib/site-packages`，既没有标准库也没有 `python312.dll`，
 * `pyvenv.cfg` 的 `home` 指向构建机上 uv 的托管 Python
 * （`C:\Users\ADMIN\AppData\Roaming\uv\python\cpython-3.12-…`）。
 *
 * 结果就是：安装包里有 364MB「内置运行时」，但在用户机器上**根本起不来**——
 * `import os` 都失败。之前之所以没人发现，是因为
 * `bundled-runtime.js` 认的 id 是 `windows-desktop` / `scrapling`，
 * 而渲染层传下来的是 `mcp-windows-desktop` / `mcp-scrapling`，一次都没匹配上，
 * 于是永远退回 `uvx`，在开发机上（装了 uv）照样能用。
 *
 * 这一版改成**自包含**形态：
 *
 * ```
 * runtime/
 *   python/                 python-build-standalone 的完整解释器（可重定位）
 *     python.exe  DLLs/  Lib/  python312.dll …
 *   bin/uv.exe  bin/uvx.exe  可选：给 Registry 的 pypi 包用，系统能力不需要
 * ```
 *
 * 依赖直接装进 `runtime/python` 自己（不再有 venv），所以整棵树可以整体搬到
 * 任意路径、任意机器上运行——安装目录换盘、装到 `Program Files` 都不影响。
 *
 * ## 用法
 *
 *   node scripts/build-mcp-runtime.mjs            # 缺什么补什么
 *   node scripts/build-mcp-runtime.mjs --force    # 重建解释器并重装依赖
 *   node scripts/build-mcp-runtime.mjs --check    # 只校验自包含，不下载不安装（打包守门）
 *   node scripts/build-mcp-runtime.mjs --no-uv    # 不内置 uv（pypi 本地包会退回系统 uvx）
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const RUNTIME = join(DESKTOP, "runtime");
/** 自包含解释器目录（整棵 python-build-standalone 树）。 */
const PYTHON_DIR = join(RUNTIME, "python");
const PYTHON = join(PYTHON_DIR, "python.exe");
const SITE_PACKAGES = join(PYTHON_DIR, "Lib", "site-packages");
const BIN_DIR = join(RUNTIME, "bin");
const REQUIREMENTS = join(DESKTOP, "runtime-requirements.txt");
/** 旧版的裸 venv 目录，构建成功后清掉（占 382MB 且已无用）。 */
const LEGACY_ENV = join(RUNTIME, "mcp-env");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const force = args.has("--force");
const withUv = !args.has("--no-uv");

const PYTHON_SERIES = "3.12";

function log(message) {
  console.log(`[build-mcp-runtime] ${message}`);
}

function fail(reason, next) {
  console.error(`\n[build-mcp-runtime] ✗ ${reason}`);
  if (next) console.error(`[build-mcp-runtime] 下一步：${next}`);
  process.exit(1);
}

function megabytes(target) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        try {
          total += statSync(child).size;
        } catch {
          /* 单个文件统计失败忽略 */
        }
      }
    }
  };
  if (!existsSync(target)) return 0;
  walk(target);
  return Math.round(total / 1048576);
}

/** 找 uv：先看 PATH，再看几个常见安装位置（本机就是 D:\Python314\Scripts）。 */
function findUv() {
  const candidates = [];
  try {
    const where = spawnSync(process.platform === "win32" ? "where" : "which", ["uv"], {
      encoding: "utf8",
      shell: false,
    });
    if (where.status === 0) {
      for (const line of String(where.stdout).split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
    }
  } catch {
    /* where/which 不可用就只看固定位置 */
  }
  candidates.push(
    join(homedir(), ".local", "bin", "uv.exe"),
    join(homedir(), ".local", "bin", "uv"),
    join(homedir(), ".cargo", "bin", "uv.exe"),
    "D:\\Python314\\Scripts\\uv.exe",
    "C:\\Python314\\Scripts\\uv.exe",
  );
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

/**
 * 源解释器：优先用 uv 的托管 Python（python-build-standalone，可重定位）。
 *
 * 不用系统 Python：`py -3.12` 那种安装是注册表 + 布局绑定的，
 * 拷进包里换台机器就可能缺 `python3.dll` 或 `Lib\venv` 之类的路径假设。
 */
function sourcePython(uv) {
  const result = spawnSync(uv, ["python", "find", PYTHON_SERIES], { encoding: "utf8" });
  if (result.status !== 0) {
    const install = spawnSync(uv, ["python", "install", PYTHON_SERIES], { stdio: "inherit" });
    if (install.status !== 0) fail("uv 装不上 Python", `先手动跑 ${uv} python install ${PYTHON_SERIES}`);
    return sourcePython(uv);
  }
  const found = String(result.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!found) fail("uv python find 没有输出路径", "检查 uv 是否可用");
  // uv 的目录名是 symlink（cpython-3.12-windows-x86_64-none → cpython-3.12.13-…），
  // 必须解到真实目录再拷，否则从包里复制的还是链接。
  const exe = realpathSync(found);
  return dirname(exe);
}

function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) fail(`命令失败（退出码 ${result.status}）`, "看上面的原始输出");
}

// —— 守门模式：只校验，不动盘 ——
if (checkOnly) {
  const problems = [];
  if (!existsSync(PYTHON)) problems.push(`缺解释器 ${PYTHON}`);
  for (const pkg of ["windows_mcp", "scrapling", "mcp"]) {
    if (!existsSync(join(SITE_PACKAGES, pkg))) problems.push(`缺依赖 ${pkg}`);
  }
  // 自包含的核心判据：包内不能出现指向构建机的 pyvenv.cfg / 指向外部的 home。
  if (existsSync(join(PYTHON_DIR, "pyvenv.cfg"))) {
    problems.push("runtime/python 里有 pyvenv.cfg——说明它是 venv 而不是可重定位解释器");
  }
  if (!existsSync(join(PYTHON_DIR, "python312.dll"))) problems.push("缺 python312.dll（标准库跑不起来）");
  if (!existsSync(join(PYTHON_DIR, "Lib", "os.py"))) problems.push("缺标准库 Lib/os.py");
  if (problems.length > 0) {
    fail(
      `内置运行时不自包含：\n  - ${problems.join("\n  - ")}`,
      "运行 node scripts/build-mcp-runtime.mjs 重建后再打包。",
    );
  }
  // 真跑一次导入：文件都在但 import 失败（DLL 缺失 / ABI 不匹配）并不罕见。
  const probe = spawnSync(PYTHON, ["-I", "-c", "import windows_mcp, scrapling; print('ok')"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: "", PYTHONHOME: "" },
  });
  if (probe.status !== 0 || !String(probe.stdout).includes("ok")) {
    fail(
      `内置解释器导入失败：${String(probe.stderr || probe.stdout).trim().slice(0, 400)}`,
      "运行 node scripts/build-mcp-runtime.mjs --force 重建。",
    );
  }
  log(`✓ 内置运行时自包含（python ${megabytes(PYTHON_DIR)}MB + 依赖，可随包分发）`);
  process.exit(0);
}

if (!existsSync(REQUIREMENTS)) fail(`缺依赖清单 ${REQUIREMENTS}`, "从上一版环境 uv pip freeze 生成一份");

const uv = findUv();
if (!uv) fail("找不到 uv（构建期需要它来装依赖）", `安装 uv 或把 uv.exe 放到 PATH`);

// —— 1. 解释器 ——
if (existsSync(PYTHON) && !force) {
  log(`解释器已存在，跳过复制（${megabytes(PYTHON_DIR)}MB）：${PYTHON_DIR}`);
} else {
  const source = sourcePython(uv);
  log(`源解释器：${source}`);
  rmSync(PYTHON_DIR, { recursive: true, force: true });
  mkdirSync(PYTHON_DIR, { recursive: true });
  // 保留一切：DLLs、Lib、include、libs 都是运行期需要的（include/libs 给个别包的
  // 编译期探测用，删了有包会尝试往 C:\ 写临时文件）。
  cpSync(source, PYTHON_DIR, { recursive: true });
  log(`已复制解释器：${megabytes(PYTHON_DIR)}MB`);
}

// —— 2. 依赖 ——
const markerFile = join(SITE_PACKAGES, "windows_mcp");
if (existsSync(markerFile) && !force) {
  log("依赖已安装，跳过（--force 可重装）");
} else {
  // uv 给**它托管的**解释器打了 `Lib/EXTERNALLY-MANAGED` 标记，uv pip install 见到
  // 就拒绝往解释器自身装包（提示「externally managed」）。包内这份是我们自己分发
  // 的拷贝，往它身上装依赖正是它的用途——删掉标记，按普通解释器处理。
  rmSync(join(PYTHON_DIR, "Lib", "EXTERNALLY-MANAGED"), { force: true });
  run(uv, [
    "pip",
    "install",
    "--python",
    PYTHON,
    // 双保险：万一标记文件又出现在别处（新版 uv 换了位置），这个开关也能放行。
    "--break-system-packages",
    "--no-cache",
    "-r",
    REQUIREMENTS,
  ]);
}

// —— 3. uv 自身（可选）——
if (withUv) {
  const uvExe = uv;
  const uvxExe = join(dirname(uv), "uvx.exe");
  mkdirSync(BIN_DIR, { recursive: true });
  if (!existsSync(join(BIN_DIR, "uv.exe"))) copyFileSync(uvExe, join(BIN_DIR, "uv.exe"));
  if (existsSync(uvxExe) && !existsSync(join(BIN_DIR, "uvx.exe"))) {
    copyFileSync(uvxExe, join(BIN_DIR, "uvx.exe"));
  }
  log(`已内置 uv：${megabytes(join(BIN_DIR, "uv.exe"))}MB（让 Registry 的 pypi 包零外部依赖）`);
}

// —— 4. 清掉旧 venv ——
if (existsSync(LEGACY_ENV)) {
  const size = megabytes(LEGACY_ENV);
  rmSync(LEGACY_ENV, { recursive: true, force: true });
  log(`已清理旧版裸 venv：mcp-env（${size}MB，不是自包含的）`);
}

// —— 5. 自检 ——
const probe = spawnSync(PYTHON, ["-I", "-c", "import windows_mcp, scrapling; print('ok')"], {
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: "", PYTHONHOME: "" },
});
if (probe.status !== 0 || !String(probe.stdout).includes("ok")) {
  fail(
    `安装完成但导入失败：${String(probe.stderr || probe.stdout).trim().slice(0, 400)}`,
    "检查上面的 uv pip install 输出",
  );
}
log(
  `✓ 完成：python ${megabytes(PYTHON_DIR)}MB` +
    (withUv ? ` + bin ${megabytes(BIN_DIR)}MB` : "") +
    ` · 依赖 ${readFileSync(REQUIREMENTS, "utf8").split(/\r?\n/).filter(Boolean).length} 个包`,
);
