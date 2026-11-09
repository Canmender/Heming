#!/usr/bin/env node
/**
 * 构建「选装模块包」（`module.tgz`）——信息中枢引擎等**可执行**选装能力的发布产物。
 *
 * 与 `package.tgz`（界面插件 bundle）的区别：
 * - 模块是执行体（Python 包 + 依赖），不是声明式插件，安装端用独立仓库与验签路径；
 * - 清单仍走 `schemaVersion 4` 的 canonical-v1（与 `sign-plugin.mjs` /
 *   `plugin-signature.js` 逐字节一致），`distribution: "module"` + `meta.kind: "module"`
 *   标记用途，`packageSha256` 覆盖 `files/**` 全部字节；
 * - 包布局固定：根 `module.json` + `files/app/**`（引擎代码）+ `files/lib/**`（可选的依赖）。
 *
 * 用法：
 *   node scripts/build-module.mjs                       # 构建信息中枢引擎（默认参数）
 *   node scripts/build-module.mjs --install <modules>   # 构建并装到本机模块目录（自检）
 *
 * 签名私钥：默认读环境变量 `HEMING_MODULE_SIGNING_KEY`（base64url 32 字节种子），
 * 缺省回落到发布机的 `D:/Heming-release-keys/official-plugin-signing.seed.txt`。
 * 私钥不进仓库；脚本只打印公钥指纹，不打印私钥。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicKeyFromPrivate, signManifest } from "./sign-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(import.meta.url);
const { packTarGz } = requireFromRoot("../packages/desktop/plugin-tar.js");
const { readModulePackage } = requireFromRoot("../packages/desktop/module-package.js");

const DEFAULT_KEY_FILE = "D:/Heming-release-keys/official-plugin-signing.seed.txt";
/** 与 `packages/desktop/infohub-engine.js` 的 ENGINE_VERSION 保持一致（脚本会读源码核对）。 */
const DEFAULT_ID = "heming.infohub-engine";

function fail(message) {
  console.error(`[build-module] 失败：${message}`);
  process.exit(1);
}

/* ── 参数 ──────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`多余的参数：${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`参数 ${arg} 缺少值`);
    options[key] = value;
    i += 1;
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const id = args.id ?? DEFAULT_ID;
const engineSource = readFileSync(join(ROOT, "packages/desktop/infohub-engine.js"), "utf8");
const expectedVersion = /const ENGINE_VERSION = "([^"]+)"/.exec(engineSource)?.[1];
if (!expectedVersion) fail("读不到 packages/desktop/infohub-engine.js 的 ENGINE_VERSION");
const version = args.version ?? expectedVersion;
if (args.version && args.version !== expectedVersion) {
  console.warn(
    `[build-module] 警告：--version ${args.version} 与桌面端期望的 ${expectedVersion} 不一致，应用不会自动安装它`,
  );
}

const appRoot = resolve(ROOT, args.app ?? "packages/infohub");
const libRoot = resolve(ROOT, args.lib ?? ".tmp-engine-lib");
const outFile = resolve(
  ROOT,
  args.out ?? join("module-catalog", id, version, "module.tgz"),
);
const installDir = args.install ? resolve(ROOT, args.install) : "";
const publisherId = args.publisher ?? "heming";

/* ── 收集文件 ──────────────────────────────────────────────────────────── */

const SKIP_DIRS = new Set(["__pycache__", ".git", "node_modules"]);
const SKIP_EXT = /\.(pyc|pyo|tmp)$/i;

function walk(dir, prefix, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isSymbolicLink()) fail(`模块包内不允许符号链接：${full}`);
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, `${prefix}/${name}`, out);
      continue;
    }
    if (!info.isFile() || SKIP_EXT.test(name)) continue;
    out.push({ path: `${prefix}/${name}`, data: readFileSync(full) });
  }
  return out;
}

if (!existsSync(join(appRoot, "infohub", "bridge.py"))) {
  fail(`引擎入口不存在：${join(appRoot, "infohub", "bridge.py")}`);
}

/** 采集真正需要的包（其余是 wechatauto 元数据里声明、但只在 GUI/朋友圈场景才 import 的）。 */
const ESSENTIAL_LIB = /^(wechatauto|zstandard|uiautomation|comtypes|colorama|cryptography|cffi|pycparser|PIL|pillow|psutil|pyperclip)([-_.]|$)/i;

function isEssentialLibEntry(name) {
  return ESSENTIAL_LIB.test(name);
}

const entries = [];
// app 根只收 infohub/ 包：README/tests/pyproject 不进模块包（安装端只读运行时代码）。
walk(join(appRoot, "infohub"), "files/app/infohub", entries);
if (existsSync(libRoot) && statSync(libRoot).isDirectory()) {
  const skipped = [];
  for (const name of readdirSync(libRoot).sort()) {
    const full = join(libRoot, name);
    if (!isEssentialLibEntry(name)) {
      skipped.push(name);
      continue;
    }
    const info = statSync(full);
    if (info.isDirectory()) walk(full, `files/lib/${name}`, entries);
    else if (info.isFile()) entries.push({ path: `files/lib/${name}`, data: readFileSync(full) });
  }
  if (skipped.length > 0) {
    console.log(
      `[build-module] 已排除 ${skipped.length} 个非采集依赖（GUI/朋友圈专用）：${skipped.slice(0, 6).join("、")}` +
        `${skipped.length > 6 ? "…" : ""}`,
    );
  }
} else {
  console.warn(`[build-module] 未找到依赖目录 ${libRoot}；构建出的模块可能缺第三方包`);
}

for (const entry of entries) {
  if (entry.data.length > 32 * 1024 * 1024) fail(`单文件超过 32MB：${entry.path}`);
}
if (entries.length === 0) fail("没有收集到任何文件");

/* ── 用内置解释器做一次导入自检（按**实际打包的文件**，有运行时才做） ───── */

const bundledPython = join(ROOT, "packages/desktop/runtime/mcp-env/Scripts/python.exe");
if (existsSync(bundledPython)) {
  // 必须落到临时目录再导入：直接指向源依赖目录会掩盖「裁剪时漏掉某个包」。
  const probeDir = mkdtempSync(join(tmpdir(), "heming-module-probe-"));
  try {
    for (const entry of entries) {
      if (!entry.path.startsWith("files/lib/")) continue;
      const target = join(probeDir, ...entry.path.slice("files/lib/".length).split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }
    const probe = spawnSync(
      bundledPython,
      [
        "-c",
        "import infohub.bridge, infohub.sync, infohub.sources.wechat; " +
          "from wechatauto import WeChatDB; print('imports ok')",
      ],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          PYTHONPATH: [appRoot, probeDir].join(delimiter),
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
        encoding: "utf8",
      },
    );
    if (probe.status !== 0) {
      fail(
        `依赖导入自检失败（打包后的文件集）：${(probe.stderr || probe.stdout || "").trim().slice(0, 800)}`,
      );
    }
    console.log("[build-module] 导入自检通过：infohub.bridge / sync / sources.wechat / WeChatDB");
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
} else {
  console.log("[build-module] 未找到内置 Python，跳过导入自检");
}

/* ── 清单 + 签名 ───────────────────────────────────────────────────────── */

const privateKey =
  (process.env.HEMING_MODULE_SIGNING_KEY ?? "").trim() ||
  (existsSync(DEFAULT_KEY_FILE) ? readFileSync(DEFAULT_KEY_FILE, "utf8").trim() : "");
if (!privateKey) {
  fail(
    "缺少签名私钥：设 HEMING_MODULE_SIGNING_KEY，或把 base64url 种子放到 " +
      DEFAULT_KEY_FILE,
  );
}

const packageSha256 = filesDigest(entries);
const manifest = {
  schemaVersion: 4,
  id,
  name: args.name ?? "信息中枢引擎",
  version,
  description: "本机 QQ / 微信信息归档引擎（选装模块，安装后自动启动）",
  author: "Heming",
  publisher: { id: publisherId, publicKey: publicKeyFromPrivate(privateKey) },
  distribution: "module",
  meta: { kind: "module", entry: "app", lib: "lib" },
  packageSha256,
  // 模块不参与界面插件的能力声明，但 canonical-v1 会把这些字段规范化进签名文本；
  // 显式写成空集合，避免发布工具的默认值与本脚本漂移。
  permissions: {},
  contributions: {},
};

const signed = signManifest(manifest, privateKey);
const packedManifest = { ...manifest, signature: signed.signature };
const manifestBytes = Buffer.from(`${JSON.stringify(packedManifest, null, 2)}\n`, "utf8");

/* ── 打包 + 用安装端口径回读校验 ───────────────────────────────────────── */

const packageBytes = packTarGz([{ path: "module.json", data: manifestBytes }, ...entries]);

const keysFile = join(ROOT, "packages/desktop/resources/official-keys.json");
let verified;
try {
  verified = readModulePackage(packageBytes, { expectedId: id, keysFile, allowDevKeys: false });
} catch (err) {
  fail(`产物未通过安装端校验：${(err && err.message) || err}`);
}

/* ── 可选：装到本机模块目录（自检用） ──────────────────────────────────── */

if (installDir) {
  const { createModuleStore } = requireFromRoot("../packages/desktop/module-store.js");
  const store = createModuleStore({ dir: installDir, log: (line) => console.log(line) });
  const installed = store.install(packageBytes, { expectedId: id, keysFile, allowDevKeys: false });
  console.log(`[build-module] 已装到本机：${installDir}（${installed.id}@${installed.version}）`);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, packageBytes);

const sha256 = createHash("sha256").update(packageBytes).digest("hex");
console.log(
  `[build-module] ${outFile}\n` +
    `  id       ${id}@${version}\n` +
    `  签名     keyId=${verified.keyId} · publisher=${publisherId}\n` +
    `  sha256   ${sha256}\n` +
    `  size     ${(packageBytes.length / 1024 / 1024).toFixed(2)} MB（${entries.length} 个文件，` +
    `解包前 ${(entries.reduce((sum, item) => sum + item.data.length, 0) / 1024 / 1024).toFixed(2)} MB）`,
);

/* ── 摘要：与 desktop `computeFilesDigest` 同一算法 ─────────────────────── */

function filesDigest(items) {
  const hash = createHash("sha256");
  const files = items
    .filter((item) => item.path.startsWith("files/"))
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const item of files) {
    hash.update(item.path);
    hash.update("\0");
    hash.update(String(item.data.length));
    hash.update("\0");
    hash.update(createHash("sha256").update(item.data).digest());
    hash.update("\n");
  }
  return hash.digest("hex");
}
