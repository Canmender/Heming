#!/usr/bin/env node
/**
 * 把「聊天记录」插件源码 staging 成可打包的包根 `dist/package/`。
 *
 * 为什么需要 build：插件自带本机引擎（d.125），引擎要随包携带 infohub 核心与纯 Python
 * 依赖。这些是**构建产物**（来自 packages/infohub 源码与 .tmp-engine-lib 依赖），不入版本库
 * （dist/ 已被根 .gitignore 忽略）。源码工程里只留手写部分：plugin.json / files 页面三件套 /
 * engine/bridge.py（薄封装）。
 *
 * 产物布局（与宿主 plugin-engine.js 的入口/依赖约定一致）：
 *   dist/package/plugin.json
 *   dist/package/files/{index.html,app.js,style.css}      页面
 *   dist/package/files/engine/bridge.py                   引擎入口（手写薄封装）
 *   dist/package/files/engine/infohub/**                  vendored 核心（去 GUI/缓存）
 *   dist/package/files/engine/lib/**                      vendored 采集依赖（裁剪后）
 *
 * 用法：
 *   node plugin-kit/plugins/infohub-page/build.mjs
 *   node scripts/pack-plugin.mjs plugin-kit/plugins/infohub-page/dist/package
 *
 * 打包前会用内置 Python 对**实际 staging 出的文件集**做一次导入自检（含薄封装本身），
 * 裁剪漏包会在这一关暴露，而不是装到用户机上才崩。
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const APP_ROOT = resolve(ROOT, "packages/infohub");
const LIB_ROOT = resolve(ROOT, ".tmp-engine-lib");
const BUNDLED_PYTHON = resolve(ROOT, "packages/desktop/runtime/mcp-env/Scripts/python.exe");
const STAGE = resolve(HERE, "dist/package");
const ENGINE_DIR = join(STAGE, "files/engine");

/** 与宿主安装配额一致（scripts/pack-plugin.mjs / packages/desktop/plugin-tar.js）。 */
const LIMITS = { maxTotalBytes: 64 * 1024 * 1024, maxFiles: 4000, maxFileBytes: 16 * 1024 * 1024 };
/** 采集真正需要的包（与 scripts/build-module.mjs 同一份裁剪口径）。 */
const ESSENTIAL_LIB = /^(wechatauto|zstandard|uiautomation|comtypes|colorama|cryptography|cffi|pycparser|PIL|pillow|psutil|pyperclip)([-_.]|$)/i;
const SKIP_DIRS = new Set(["__pycache__", ".git", "node_modules"]);
const SKIP_EXT = /\.(pyc|pyo|tmp)$/i;

function fail(message) {
  console.error(`[infohub-page build] 失败：${message}`);
  process.exit(1);
}

if (!existsSync(join(APP_ROOT, "infohub/bridge.py"))) fail(`找不到 infohub 源码：${APP_ROOT}`);
if (!existsSync(LIB_ROOT) || !statSync(LIB_ROOT).isDirectory()) {
  fail(`找不到采集依赖目录 ${LIB_ROOT}（先准备 .tmp-engine-lib，见 scripts/build-module.mjs 说明）`);
}

/* ── 清空并重建 staging 目录（纯构建产物，可安全重建） ─────────────────────── */
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(ENGINE_DIR, { recursive: true });

/* ── 手写部分：清单 + 页面三件套 + 引擎薄封装 ─────────────────────────────── */
copyFileSync(join(HERE, "plugin.json"), join(STAGE, "plugin.json"));
for (const name of ["index.html", "app.js", "style.css"]) {
  copyFileSync(join(HERE, "files", name), join(STAGE, "files", name));
}
copyFileSync(join(HERE, "engine/bridge.py"), join(ENGINE_DIR, "bridge.py"));

/* ── vendoring：递归收集普通文件（拒符号链接、去缓存/GUI） ─────────────────── */
const entries = [];
function walk(dir, relBase, { skipUi = false } = {}) {
  for (const name of readdirSync(dir).sort()) {
    if (skipUi && name === "ui" && relBase.endsWith("infohub")) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isSymbolicLink()) fail(`不允许符号链接：${full}`);
    const rel = `${relBase}/${name}`;
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, rel, { skipUi });
    } else if (info.isFile() && !SKIP_EXT.test(name)) {
      entries.push({ rel, full });
    }
  }
}

walk(join(APP_ROOT, "infohub"), "files/engine/infohub", { skipUi: true });
const skippedLib = [];
for (const name of readdirSync(LIB_ROOT).sort()) {
  if (!ESSENTIAL_LIB.test(name)) {
    skippedLib.push(name);
    continue;
  }
  const full = join(LIB_ROOT, name);
  if (statSync(full).isDirectory()) walk(full, `files/engine/lib/${name}`);
  else entries.push({ rel: `files/engine/lib/${name}`, full });
}
// 薄封装与页面也计入配额统计
for (const rel of ["plugin.json", "files/index.html", "files/app.js", "files/style.css", "files/engine/bridge.py"]) {
  entries.push({ rel, full: join(STAGE, rel) });
}

let total = 0;
for (const entry of entries) {
  const size = statSync(entry.full).size;
  if (size > LIMITS.maxFileBytes) fail(`单文件超过 16MB：${entry.rel}（${size} 字节）`);
  total += size;
}
if (entries.length > LIMITS.maxFiles) fail(`文件数超过上限：${entries.length} > ${LIMITS.maxFiles}`);
if (total > LIMITS.maxTotalBytes) fail(`解包总量超过 64MB：${total} 字节`);

for (const entry of entries) {
  if (entry.full.startsWith(STAGE)) continue; // 已在 staging 里的手写文件
  const dest = join(STAGE, ...entry.rel.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(entry.full, dest);
}
if (skippedLib.length > 0) {
  console.log(`[infohub-page build] 已排除 ${skippedLib.length} 个非采集依赖：${skippedLib.slice(0, 6).join("、")}${skippedLib.length > 6 ? "…" : ""}`);
}

/* ── 导入自检：按实际 staging 出的文件集，用内置解释器跑一遍 ───────────────── */
if (existsSync(BUNDLED_PYTHON)) {
  const libDir = join(ENGINE_DIR, "lib");
  const probe = spawnSync(
    BUNDLED_PYTHON,
    [
      "-c",
      "import infohub.bridge, infohub.sync, infohub.sources.wechat; " +
        "from wechatauto import WeChatDB; import bridge; print('imports ok')",
    ],
    {
      cwd: ENGINE_DIR,
      env: {
        ...process.env,
        PYTHONPATH: [ENGINE_DIR, libDir].join(delimiter),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      encoding: "utf8",
    },
  );
  if (probe.status !== 0) {
    fail(`依赖导入自检失败（staging 后的文件集）：${(probe.stderr || probe.stdout || "").trim().slice(0, 1200)}`);
  }
  console.log("[infohub-page build] 导入自检通过：infohub.bridge / sync / sources.wechat / WeChatDB / 薄封装 bridge");
} else {
  console.log("[infohub-page build] 未找到内置 Python，跳过导入自检");
}

console.log(
  `[infohub-page build] staging 完成：${STAGE}\n` +
    `  ${entries.length} 个文件 / 解包前 ${(total / 1024 / 1024).toFixed(2)} MB\n` +
    `  下一步：node scripts/pack-plugin.mjs plugin-kit/plugins/infohub-page/dist/package`,
);