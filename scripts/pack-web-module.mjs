#!/usr/bin/env node
/**
 * 把宿主加载式模块（`packages/modules/<id>/dist/entry.js`）打成首方签名 `module.tgz`（d.131）。
 *
 * 用法：
 *   node scripts/pack-web-module.mjs --id staff
 *   node scripts/pack-web-module.mjs --id automations --out module-catalog/automations/1.0.0/module.tgz
 *   node scripts/pack-web-module.mjs --id staff --install "$env:APPDATA/heming/modules"
 *
 * 产出布局（与 module-package.js 一致）：根 module.json + files/web/**。
 * 签名沿用 `sign-plugin.mjs` 的 canonical-v1；web.entry/contributions 已进入签名文本。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicKeyFromPrivate, signManifest } from "./sign-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(import.meta.url);
const { packTarGz } = requireFromRoot("../packages/desktop/plugin-tar.js");
const { readModulePackage } = requireFromRoot("../packages/desktop/module-package.js");

const DEFAULT_KEY_FILE = "D:/Heming-release-keys/official-plugin-signing.seed.txt";
const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function fail(message) {
  console.error(`[pack-web-module] 失败：${message}`);
  process.exit(1);
}

const id = option("id");
if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail("用法：--id <module-id>");
const moduleRoot = resolve(ROOT, "packages/modules", id);
const manifestPath = join(moduleRoot, "module.json");
const distRoot = join(moduleRoot, "dist");
if (!existsSync(manifestPath)) fail(`缺少 ${manifestPath}`);
if (!existsSync(join(distRoot, "entry.js"))) fail(`缺少 ${distRoot}/entry.js，请先运行 build-web-module.mjs --id ${id}`);

const source = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = option("version") ?? source.version;
if (!version) fail("module.json 缺少 version");
if (source.id !== id) fail(`module.json id=${source.id} 与目录 ${id} 不一致`);
const webSource = source.web && typeof source.web === "object" ? source.web : null;
if (!webSource || typeof webSource.entry !== "string") fail("module.json 缺少 web.entry");
const contributions = Array.isArray(webSource.contributions) ? webSource.contributions : [];
const entryRel = webSource.entry.replace(/^files\/web\//, "");
if (!/^[A-Za-z0-9._/-]+\.js$/.test(entryRel) || entryRel.includes("..")) fail("web.entry 非法");
if (!existsSync(join(distRoot, entryRel))) fail(`web.entry 构建产物不存在：dist/${entryRel}`);

/* ── 收集 files/web/**（single-file 构建 + 未来的 relative assets） ── */
function walk(dir, prefix, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isSymbolicLink()) fail(`不允许符号链接：${full}`);
    if (st.isDirectory()) walk(full, `${prefix}/${name}`, out);
    else if (st.isFile()) out.push({ path: `${prefix}/${name}`, data: readFileSync(full) });
  }
  return out;
}
const files = walk(distRoot, "files/web", []);

// 可选：把本机 Python 引擎一起装进同一个插件包（信息插件）。
// 引擎目录布局与 build-module.mjs 一致：packages/infohub/infohub → files/app/infohub，
// 依赖只收采集必需的那批（GUI 专用的不进包）。
const engineApp = option("engine-app");
const engineLib = option("engine-lib");
const hasEngine = Boolean(engineApp);
if (hasEngine) {
  const appRoot = resolve(ROOT, engineApp);
  const packageDir = join(appRoot, "infohub");
  if (!existsSync(packageDir)) fail(`引擎入口不存在：${packageDir}`);
  walk(packageDir, "files/app/infohub", files);
  if (engineLib) {
    const libRoot = resolve(ROOT, engineLib);
    if (existsSync(libRoot)) {
      const ESSENTIAL_LIB = /^(wechatauto|zstandard|uiautomation|comtypes|colorama|cryptography|cffi|pycparser|PIL|pillow|psutil|pyperclip)([-_.]|$)/i;
      for (const name of readdirSync(libRoot).sort()) {
        if (!ESSENTIAL_LIB.test(name)) continue;
        const full = join(libRoot, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, `files/lib/${name}`, files);
        else if (st.isFile()) files.push({ path: `files/lib/${name}`, data: readFileSync(full) });
      }
    } else {
      console.warn(`[pack-web-module] 引擎依赖目录不存在：${libRoot}`);
    }
  }
}
files.length === 0 && fail("dist 为空");

/* ── 摘要（与 desktop computeFilesDigest 同一算法） ── */
function filesDigest(items) {
  const hash = createHash("sha256");
  const sorted = items.filter((i) => i.path.startsWith("files/")).slice().sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const item of sorted) {
    hash.update(item.path);
    hash.update("\0");
    hash.update(String(item.data.length));
    hash.update("\0");
    hash.update(createHash("sha256").update(item.data).digest());
    hash.update("\n");
  }
  return hash.digest("hex");
}
const packageSha256 = filesDigest(files);

/* ── 签名私钥 ── */
function readPrivateKey() {
  const env = process.env.HEMING_MODULE_SIGNING_KEY;
  if (env) return env.trim();
  if (existsSync(DEFAULT_KEY_FILE)) return readFileSync(DEFAULT_KEY_FILE, "utf8").trim();
  fail(`缺少签名私钥：设 HEMING_MODULE_SIGNING_KEY，或把种子放到 ${DEFAULT_KEY_FILE}`);
}
const privateKey = readPrivateKey();
const publicKey = publicKeyFromPrivate(privateKey);

const manifest = {
  schemaVersion: 4,
  id,
  name: source.name ?? id,
  version,
  description: source.description ?? "",
  author: source.author ?? "和鸣",
  publisher: { id: "heming", publicKey },
  distribution: "module",
  meta: { kind: "module", ...(hasEngine ? { entry: "app", lib: "lib" } : {}) },
  web: { entry: webSource.entry, contributions },
  packageSha256,
  // canonical-v1 会规范化这些字段；显式空集合避免与发布工具默认值漂移。
  permissions: {},
  contributions: {},
};
const signed = signManifest(manifest, privateKey);
const packedManifest = { ...manifest, signature: signed.signature };
const manifestBytes = Buffer.from(`${JSON.stringify(packedManifest, null, 2)}\n`, "utf8");
const packageBytes = packTarGz([{ path: "module.json", data: manifestBytes }, ...files]);

/* ── 用安装端口径回读校验 ── */
const keysFile = join(ROOT, "packages/desktop/resources/official-keys.json");
let verified;
try {
  verified = readModulePackage(packageBytes, { expectedId: id, keysFile, allowDevKeys: false });
} catch (err) {
  fail(`产物未通过安装端校验：${(err && err.message) || err}`);
}
if (!verified.web || verified.web.entry !== webSource.entry) fail("回读后 web 入口不一致");

/* ── 输出 / 可选安装 ── */
const outFile = resolve(ROOT, option("out") ?? join("module-catalog", id, version, "module.tgz"));
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, packageBytes);

const installDir = option("install");
if (installDir) {
  const { createModuleStore } = requireFromRoot("../packages/desktop/module-store.js");
  const store = createModuleStore({ dir: resolve(installDir), log: (line) => console.log(line) });
  const installed = store.install(packageBytes, { expectedId: id, keysFile, allowDevKeys: false });
  console.log(`[pack-web-module] 已装到本机：${resolve(installDir)}（${installed.id}@${installed.version}）`);
}

const sha256 = createHash("sha256").update(packageBytes).digest("hex");
console.log(
  `[pack-web-module] ${relative(ROOT, outFile)}\n` +
    `  id       ${id}@${version}\n` +
    `  签名     keyId=${verified.keyId}\n` +
    `  sha256   ${sha256}\n` +
    `  size     ${(packageBytes.length / 1024).toFixed(1)} KB（${files.length} 个文件）`,
);
