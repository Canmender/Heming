#!/usr/bin/env node
/**
 * 插件清单校验器（v5 权威校验；v4 bundle 走安装口径；v1–v4 声明式只做兼容性提示）。
 *
 * 为什么单独做一个脚本：`parsePluginManifestV5` 是 web 安装预览与 market 生成器
 * 共用的唯一权威校验器，但作者在本地写完 `plugin.json` 时也应该能离线跑一遍，
 * 而不是装一次才知道哪一行错了。CI 也可以用它挡坏包。
 *
 * 用法：
 *   node scripts/plugin-lint.mjs plugin-kit/plugins/infohub-collector/plugin.json
 *   node scripts/plugin-lint.mjs plugin-kit/plugins/infohub-collector   # 目录（找目录下的 plugin.json）
 *   node scripts/plugin-lint.mjs --dir plugin-kit/plugins --skip dist,release   # 递归校验目录下所有 plugin.json
 *   node scripts/plugin-lint.mjs --dir plugin-kit/examples --skip _invalid
 *   node scripts/plugin-lint.mjs plugin-kit/plugins/pet-widget/plugin.json --source
 *   node scripts/plugin-lint.mjs --json a.json                 # 机器可读输出（CI 用）
 *   node scripts/plugin-lint.mjs --dir plugin-kit/plugins --strict        # warning 也算失败（CI 可选）
 *
 * 批量递归时**始终**跳过 `node_modules` 与点目录；`--skip` 按目录 basename 再跳过
 * 指定的名字（默认命令里对示例目录用 `--skip _invalid`：故意非法的样例不参与批量校验）。
 *
 * v4 的 `distribution: "bundle"` 是界面插件（仅首方签名）：这里的校验直接加载主进程
 * `packages/desktop/plugin-package.js` 的 `validateBundleManifest(raw, { dev: true })`
 * （打包前模式：缺 `packageSha256` 不算错，格式给了仍严格校验），与安装端同一份规则。
 * 拿不到主进程模块时降级为「跳过 bundle 深度校验」并给出提示（退出码仍按 v5 结果算）。
 * `--source` 用于界面插件的**源码工程**（清单与 `files/` 不同目录，产物在 `dist/package`）：
 * 只校验清单本身，entry/`files/`/packageSha256 的磁盘比对交给 build + pack 后的产物。
 *
 * 退出码：0 = 全部通过（可能有 warning）；1 = 有错误（--strict 时 warning 也算）；
 *        2 = 用法 / 环境问题。
 * 输出一律中文，带字段路径（与安装预览同一套文案）。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "packages", "shared", "dist", "index.js");
const desktopPackagePath = join(root, "packages", "desktop", "plugin-package.js");

if (!existsSync(distEntry)) {
  console.error("找不到 packages/shared/dist/index.js。先跑 `pnpm --filter @heming/shared build`。");
  process.exit(2);
}

const { parsePluginManifestV5, PluginManifestInvalidError, PLUGIN_SCHEMA_VERSION_V5 } = await import(
  `file://${distEntry.replace(/\\/g, "/")}`
);

/* ───────────────────────── 参数 ───────────────────────── */

function usage() {
  console.error(
    [
      "用法：node scripts/plugin-lint.mjs <plugin.json...> | <目录...> | --dir <目录>",
      "       [--skip <名字[,名字]>] [--strict] [--source] [--json]",
      "",
      "  --dir     递归校验目录下所有 plugin.json（相对路径按仓库根解析）",
      "  --skip    递归时按目录 basename 跳过（始终跳过 node_modules 与点目录）",
      "  --strict  warning 也算失败（CI 可选）",
      "  --source  源码工程模式：bundle 包根内容（entry/files/packageSha256）不在原地校验",
      "  --json    输出机器可读 JSON（含 strict 与跳过的目录名）",
    ].join("\n"),
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
let asJson = false;
let strict = false;
let sourceMode = false;
let dirArg = null;
const skipNames = new Set();
const positionals = [];

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--json") {
    asJson = true;
    continue;
  }
  if (arg === "--strict") {
    strict = true;
    continue;
  }
  if (arg === "--source") {
    sourceMode = true;
    continue;
  }
  if (arg === "--dir") {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) usage();
    dirArg = value;
    index += 1;
    continue;
  }
  if (arg.startsWith("--dir=")) {
    dirArg = arg.slice("--dir=".length);
    if (!dirArg) usage();
    continue;
  }
  if (arg === "--skip") {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) usage();
    for (const item of value.split(",")) {
      const name = item.trim();
      if (name) skipNames.add(name);
    }
    index += 1;
    continue;
  }
  if (arg.startsWith("--skip=")) {
    for (const item of arg.slice("--skip=".length).split(",")) {
      const name = item.trim();
      if (name) skipNames.add(name);
    }
    continue;
  }
  if (arg.startsWith("-")) usage();
  positionals.push(arg);
}

/* ───────────────────────── 收集清单 ───────────────────────── */

const files = [];
const skipped = new Set();

function collect(target) {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const name = entry.name;
    const full = join(target, name);
    if (entry.isDirectory()) {
      // 始终跳过依赖与点目录；其余按 --skip 的 basename 名单跳过。
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (skipNames.has(name)) {
        skipped.add(name);
        continue;
      }
      collect(full);
    } else if (name === "plugin.json") {
      files.push(full);
    }
  }
}

if (dirArg) {
  const target = isAbsolute(dirArg) ? dirArg : join(root, dirArg);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.error(`目录不存在：${dirArg}`);
    process.exit(2);
  }
  collect(target);
} else {
  if (positionals.length === 0) usage();
  for (const arg of positionals) {
    const target = resolve(process.cwd(), arg);
    if (!existsSync(target)) {
      console.error(`路径不存在：${arg}`);
      process.exit(2);
    }
    if (statSync(target).isDirectory()) {
      const manifest = join(target, "plugin.json");
      if (!existsSync(manifest)) {
        console.error(`目录里没有 plugin.json：${arg}\n如果要递归校验目录下的插件，请用 --dir <目录>。`);
        process.exit(2);
      }
      files.push(manifest);
    } else {
      files.push(target);
    }
  }
}

if (files.length === 0) {
  const where = dirArg ? `目录 ${dirArg} 下` : "给定路径里";
  console.error(`${where}没有找到任何 plugin.json${skipNames.size > 0 ? "（跳过的目录不计）" : ""}。`);
  process.exit(2);
}

/* ───────────────────────── v4 bundle 的安装口径校验 ───────────────────────── */

const requireFromHere = createRequire(import.meta.url);
let bundleModule;
let bundleModuleProblem = "";

/** 懒加载主进程的 bundle 校验模块；加载失败时返回 null（降级为提示，不报错）。 */
function loadBundleModule() {
  if (bundleModule !== undefined) return bundleModule;
  bundleModule = null;
  if (!existsSync(desktopPackagePath)) {
    bundleModuleProblem = "找不到 packages/desktop/plugin-package.js";
    return null;
  }
  try {
    const loaded = requireFromHere(desktopPackagePath);
    if (!loaded || typeof loaded.validateBundleManifest !== "function" || typeof loaded.computeFilesDigest !== "function") {
      bundleModuleProblem = "plugin-package.js 没有导出 validateBundleManifest / computeFilesDigest";
      return null;
    }
    bundleModule = loaded;
  } catch (err) {
    bundleModuleProblem = `加载 plugin-package.js 失败：${(err && err.message) || err}`;
  }
  return bundleModule;
}

/** 读取插件目录下 `files/**`（供 packageSha256 与磁盘内容比对用）。 */
function collectFilesEntries(dir) {
  const filesRoot = join(dir, "files");
  if (!existsSync(filesRoot) || !statSync(filesRoot).isDirectory()) return null;
  const out = [];
  const walk = (current, base) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = base ? `${base}/${name}` : name;
      const info = statSync(full);
      if (info.isDirectory()) walk(full, rel);
      else if (info.isFile()) out.push({ path: `files/${rel}`, data: readFileSync(full) });
    }
  };
  walk(filesRoot, "");
  return out;
}

function lintBundle(raw, display, file) {
  const mod = loadBundleModule();
  if (!mod) {
    return {
      file: display,
      mode: "bundle",
      errors: [],
      warnings: [`跳过 bundle 深度校验（${bundleModuleProblem || "主进程模块不可用"}）：只做了 JSON 解析。`],
    };
  }

  let check;
  try {
    check = mod.validateBundleManifest(raw, { dev: true });
  } catch (err) {
    return { file: display, mode: "bundle", errors: [`bundle 校验器异常：${(err && err.message) || err}`], warnings: [] };
  }

  const errors = Array.isArray(check.errors) ? [...check.errors] : [];
  const warnings = [];

  if (check.ok) {
    const dir = dirname(file);
    if (sourceMode) {
      warnings.push("源码工程模式：跳过 entry/files/packageSha256 的磁盘比对（build + pack 后由产物清单校验）。");
    } else {
      // 安装端还会检查 entry 确实在包里；这里按磁盘上的包根提前暴露同一个问题。
      const entry = check.widget && typeof check.widget.entry === "string" ? check.widget.entry : "";
      if (entry) {
        const entryFile = join(dir, ...entry.split("/"));
        if (!existsSync(entryFile)) errors.push(`desktopWidgets[0].entry 指向的文件不存在：${entry}`);
      }
      if (raw.packageSha256 === undefined) {
        warnings.push(
          "打包前模式：尚未写 packageSha256（由 scripts/pack-plugin.mjs 在产物清单里写入、sign-plugin.mjs 写回源清单）；签名打包前不能安装。",
        );
      } else {
        const entries = collectFilesEntries(dir);
        if (!entries) {
          errors.push("缺少 files/ 目录（界面插件包必须包含 files/**）。");
        } else {
          const actual = mod.computeFilesDigest(entries);
          if (actual !== raw.packageSha256) {
            errors.push(
              `packageSha256 与 files/** 实际内容不一致（清单 ${String(raw.packageSha256).slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）。`,
            );
          }
        }
      }
    }
    if (!raw.signature) {
      warnings.push("尚未首方签名：安装前必须由首方私钥签名（见 docs/PLUGINS.md §10）。");
    }
  }

  return {
    file: display,
    mode: "bundle",
    errors,
    warnings,
    manifest: check.ok ? { id: String(raw.id ?? ""), version: String(raw.version ?? "") } : undefined,
    note: check.ok
      ? sourceMode
        ? "bundle 清单校验通过（源码工程模式）"
        : raw.packageSha256 === undefined
          ? "bundle 校验通过（安装口径，打包前模式）"
          : "bundle 校验通过（安装口径；签名在安装链路验证）"
      : undefined,
  };
}

/* ───────────────────────── 逐条校验 ───────────────────────── */

function lintFile(file) {
  const display = relative(root, file) || file;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    return { file: display, errors: [`不是合法 JSON：${(err && err.message) || err}`], warnings: [] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { file: display, errors: ["清单必须是 JSON 对象"], warnings: [] };
  }
  const version = raw.schemaVersion;
  if (version === 4 && raw.distribution === "bundle") return lintBundle(raw, display, file);
  if (version !== PLUGIN_SCHEMA_VERSION_V5) {
    return {
      file: display,
      errors: [],
      warnings: [
        `schemaVersion=${String(version)} 是旧版清单（v1–v4 声明式）：本脚本只做 v5 权威校验，旧包请用应用内安装预览验证。`,
      ],
    };
  }
  try {
    const parsed = parsePluginManifestV5(raw);
    return { file: display, errors: [], warnings: parsed.warnings, manifest: parsed.manifest };
  } catch (err) {
    if (err instanceof PluginManifestInvalidError) {
      return { file: display, errors: [err.message], warnings: [] };
    }
    return { file: display, errors: [`校验器异常：${(err && err.message) || err}`], warnings: [] };
  }
}

const results = files.map(lintFile);

const failed = results.filter(
  (result) => result.errors.length > 0 || (strict && result.warnings.length > 0),
);

/* ───────────────────────── 输出 ───────────────────────── */

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        strict,
        skipped: [...skipped].sort(),
        results,
      },
      null,
      2,
    ),
  );
} else {
  for (const result of results) {
    const strictFailure = strict && result.errors.length === 0 && result.warnings.length > 0;
    const status = result.errors.length > 0 || strictFailure ? "✗" : "✓";
    console.log(`${status} ${result.file}${result.manifest ? `（${result.manifest.id} ${result.manifest.version}）` : ""}`);
    if (result.note) console.log(`  · 说明：${result.note}`);
    for (const warning of result.warnings) {
      console.log(`  · ${strictFailure ? "提示（strict 计为失败）" : "提示"}：${warning}`);
    }
    for (const error of result.errors) console.log(`  · 错误：${error}`);
  }
  const skippedText = skipped.size > 0 ? `，跳过 ${skipped.size} 个目录（${[...skipped].sort().join(", ")}）` : "";
  console.log(
    `\n共 ${results.length} 个清单：通过 ${results.length - failed.length}，失败 ${failed.length}${skippedText}。`,
  );
}

process.exit(failed.length > 0 ? 1 : 0);
