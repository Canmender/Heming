"use strict";
/**
 * 选装模块包（`module.tgz`）的读取与验签。
 *
 * ## 为什么不是界面插件包
 * 界面插件（`package.tgz`）跑在 sandbox 里、只有页面与桌面小组件，20MB 解包上限
 * 也是按这个体量定的。信息中枢这类模块是**本机引擎**（Python 源码 + 预编译的
 * Python 依赖），由主进程当子进程拉起，信任级别不同、体积也可能更大。
 * 两者共用同一套「首方 Ed25519 签名 + `files/**` 内容摘要」，但配额、落盘位置与
 * 生命周期分开——把可执行引擎混进插件安装链路，等于把「插件不执行代码」的红线
 * 悄悄改成一句空话。
 *
 * ## 包结构（唯一合法布局）
 * ```
 * module.json          清单（含 publisher / signature / packageSha256）
 * files/app/**         Python 包（`infohub` 在 app/ 下）
 * files/lib/**         随包分发的 site-packages
 * ```
 * 清单用 `schemaVersion: 4`：桌面端对 v4 走 canonical-v1，与 `scripts/sign-plugin.mjs`
 * 的签名文本逐字节一致；v5 的 canonical-v2 会额外签 `engines/meta/distribution`，
 * 当前发布脚本没有实现那一版，混用会得到「签名有效但验不过」。
 *
 * ## 信任锚与失败关闭
 * 公钥只来自 `resources/official-keys.json`；清单里的 `publisher.publicKey` 不参与
 * 验签。签名、摘要、结构任何一项对不上都抛错，调用方必须拒绝安装。
 */

const { unpackTarGz, LIMITS } = require("./plugin-tar");
const { verifyOfficialSignature } = require("./plugin-signature");
const { computeFilesDigest } = require("./plugin-package");

const MANIFEST_PATH = "module.json";
const FILE_ROOT = "files/";

/** 引擎包比界面插件大：Python 依赖是预编译轮子，但仍要有硬上限。 */
const MODULE_LIMITS = Object.freeze({
  ...LIMITS,
  maxTotalBytes: 80 * 1024 * 1024,
  maxFiles: 4000,
  maxFileBytes: 32 * 1024 * 1024,
});

const MAX_MANIFEST_BYTES = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** id / 版本直接参与落盘路径，字符集必须收窄（与插件目录同口径）。 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

class ModulePackageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModulePackageError";
  }
}

function dataOf(entry) {
  if (Buffer.isBuffer(entry.data)) return entry.data;
  if (entry.data instanceof ArrayBuffer) return Buffer.from(entry.data);
  return Buffer.from(String(entry.data ?? ""), "utf8");
}

/**
 * 读取并校验一个模块包。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} bytes 整个 `module.tgz`
 * @param {object} [options]
 * @param {string} [options.keysFile] 测试/换钥用公钥表；生产走默认路径
 * @param {boolean} [options.allowDevKeys] 仅在未打包的开发态为 true
 * @param {string} [options.expectedId] 期望的模块 id（防止装错包）
 * @returns {{manifest: object, entries: Array<{path: string, data: Buffer}>, filesDigest: string, keyId: string}}
 */
function readModulePackage(bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0) throw new ModulePackageError("模块包是空的");

  let unpacked;
  try {
    unpacked = unpackTarGz(buffer, MODULE_LIMITS);
  } catch (err) {
    throw new ModulePackageError(`模块包不是合法的 tar.gz：${(err && err.message) || err}`);
  }

  let manifestEntry = null;
  const fileEntries = [];
  for (const entry of unpacked) {
    const path = entry && entry.path;
    if (path === MANIFEST_PATH) {
      if (manifestEntry) throw new ModulePackageError("模块包根出现了重复的 module.json");
      manifestEntry = entry;
      continue;
    }
    if (typeof path === "string" && path.startsWith(FILE_ROOT)) {
      fileEntries.push({ path, data: dataOf(entry) });
      continue;
    }
    throw new ModulePackageError(`模块包含非法路径：${String(path)}（只允许根 module.json 与 files/**）`);
  }

  if (!manifestEntry) throw new ModulePackageError("模块包根缺少 module.json");
  const manifestBytes = dataOf(manifestEntry);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new ModulePackageError(`module.json 超过 ${MAX_MANIFEST_BYTES} 字节`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    throw new ModulePackageError(`module.json 不是合法 JSON：${(err && err.message) || err}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ModulePackageError("module.json 必须是对象");
  }

  if (manifest.schemaVersion !== 4) {
    throw new ModulePackageError(`模块清单只支持 schemaVersion 4（收到 ${String(manifest.schemaVersion)}）`);
  }
  if (manifest.distribution !== "module") {
    throw new ModulePackageError("module.json 的 distribution 必须是 \"module\"");
  }
  const meta = manifest.meta && typeof manifest.meta === "object" ? manifest.meta : {};
  if (meta.kind !== "module") {
    throw new ModulePackageError("module.json 缺少 meta.kind = \"module\"");
  }
  // entry/lib 是 files/ 下的**单层目录名**。canonical-v1 不覆盖 meta，必须自己卡死，
  // 否则改一个 `../..` 就能把启动目录指到版本目录之外。
  for (const key of ["entry", "lib"]) {
    const value = meta[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value) || value === "." || value === "..") {
      throw new ModulePackageError(`meta.${key} 必须是 files/ 下的单层目录名`);
    }
  }
  if (typeof manifest.id !== "string" || !ID_RE.test(manifest.id)) {
    throw new ModulePackageError(`module.json 的 id 不合法：${String(manifest.id)}`);
  }
  if (options.expectedId && manifest.id !== options.expectedId) {
    throw new ModulePackageError(`模块包 id 不匹配：期望 ${options.expectedId}，实际 ${manifest.id}`);
  }
  if (typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) {
    throw new ModulePackageError(`module.json 的 version 不合法：${String(manifest.version)}`);
  }

  const signature = verifyOfficialSignature(manifest, {
    ...(options.keysFile ? { keysFile: options.keysFile } : {}),
    ...(options.allowDevKeys !== undefined ? { allowDevKeys: options.allowDevKeys === true } : {}),
  });
  if (!signature.ok) {
    throw new ModulePackageError(`模块包未通过首方签名，已拒绝安装：${signature.reason}`);
  }

  if (typeof manifest.packageSha256 !== "string" || !SHA256_RE.test(manifest.packageSha256)) {
    throw new ModulePackageError("module.json 缺少合法的 packageSha256");
  }
  if (fileEntries.length === 0) throw new ModulePackageError("模块包 files/ 是空的");

  const filesDigest = computeFilesDigest(fileEntries);
  if (manifest.packageSha256 !== filesDigest) {
    throw new ModulePackageError(
      `packageSha256 与模块包内容不一致（清单 ${String(manifest.packageSha256).slice(0, 16)}…，实际 ${filesDigest.slice(0, 16)}…）：files/** 可能被替换，已拒绝安装`,
    );
  }

  return { manifest, entries: fileEntries, filesDigest, keyId: signature.keyId };
}

module.exports = {
  FILE_ROOT,
  MANIFEST_PATH,
  MODULE_LIMITS,
  ModulePackageError,
  readModulePackage,
};
