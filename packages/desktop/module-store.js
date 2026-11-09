"use strict";
/**
 * 选装模块的落盘（`<userData>/modules`）。
 *
 * 目录布局：
 * ```
 * installed.json                      # [{ id, version, name, entry, lib, packageSha256, installedAt }]
 * <id>/<version>/files/app/**         # 引擎源码
 * <id>/<version>/files/lib/**         # 随包依赖
 * .staging/<id>-<version>-<pid>/      # 安装中间态，成功后整目录 rename
 * ```
 *
 * 为什么是版本目录 + 整目录 rename：解包到一半断电不能留下半个引擎；旧版本在
 * 新版本成功切换后再删，删失败只记日志（下次安装会再清）。
 *
 * ★ 本模块不负责下载与验签：字节必须先经过 `readModulePackage()`（含首方验签与
 *   `files/**` 摘要比对），否则等于把任意代码写进可执行目录。
 */

const fs = require("node:fs");
const path = require("node:path");
const { readModulePackage } = require("./module-package");

const REGISTRY_FILE = "installed.json";
const STAGING_DIR = ".staging";

function defaultExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.dir 模块根目录（`<userData>/modules`）
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof readModulePackage} [options.readPackage] 测试注入（跳过真实验签）
 * @param {(id: string, version: string) => string} [options.versionDir] 测试注入
 * @param {(target: string) => boolean} [options.exists]
 */
function createModuleStore(options = {}) {
  const dir = options.dir;
  if (typeof dir !== "string" || !dir) throw new Error("module-store: 缺少 dir");
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  const readPackage = options.readPackage || readModulePackage;
  const exists = options.exists || defaultExists;

  const registryPath = () => path.join(dir, REGISTRY_FILE);
  const baseDir = (id) => path.join(dir, id);
  const versionDir = options.versionDir || ((id, version) => path.join(baseDir(id), version));
  const stagingDir = (id, version) =>
    path.join(dir, STAGING_DIR, `${id}-${version}-${process.pid}-${now()}`);

  function registry() {
    const raw = readJson(registryPath());
    const modules = raw && Array.isArray(raw.modules) ? raw.modules : [];
    return modules.filter((item) => item && typeof item.id === "string");
  }

  function find(id) {
    return registry().find((item) => item.id === id) || null;
  }

  /** 当前生效的模块目录；目录缺失（被手工删/装坏）按「未安装」处理。 */
  function current(id) {
    const record = find(id);
    if (!record) return null;
    const root = versionDir(id, record.version);
    const files = path.join(root, "files");
    const entry = typeof record.entry === "string" && record.entry ? record.entry : "app";
    const lib = typeof record.lib === "string" && record.lib ? record.lib : "lib";
    const appDir = path.join(files, entry);
    if (!exists(appDir)) return null;
    const libDir = path.join(files, lib);
    return {
      id,
      version: record.version,
      root,
      appDir,
      libDir: exists(libDir) ? libDir : "",
    };
  }

  function prune(id, keepVersion) {
    const root = baseDir(id);
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keepVersion) continue;
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      } catch (err) {
        log(`[modules] 旧版本清理失败（${id}/${name}）：${(err && err.message) || err}`);
      }
    }
  }

  function cleanupStaging() {
    try {
      fs.rmSync(path.join(dir, STAGING_DIR), { recursive: true, force: true });
    } catch {
      /* 清理失败不影响安装 */
    }
  }

  /**
   * 安装（或覆盖安装）一个模块包。
   *
   * @param {Buffer|ArrayBuffer|Uint8Array} bytes `module.tgz`
   * @param {object} [packageOptions] 透传给 `readModulePackage`（keysFile / expectedId / allowDevKeys）
   * @returns {{id: string, version: string, root: string, appDir: string, libDir: string}}
   */
  function install(bytes, packageOptions = {}) {
    const pkg = readPackage(bytes, packageOptions);
    const manifest = pkg.manifest;
    const id = manifest.id;
    const version = manifest.version;
    const meta = manifest.meta && typeof manifest.meta === "object" ? manifest.meta : {};
    const entry = typeof meta.entry === "string" && meta.entry ? meta.entry : "app";
    const lib = typeof meta.lib === "string" && meta.lib ? meta.lib : "lib";

    const staging = stagingDir(id, version);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      for (const item of pkg.entries) {
        if (!item.path.startsWith("files/")) continue;
        const target = path.join(staging, ...item.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, item.data);
      }
      const dest = versionDir(id, version);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (exists(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(staging, dest);
    } finally {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* 已 rename 成功时这里什么也不做 */
      }
    }

    const next = {
      modules: [
        ...registry().filter((item) => item.id !== id),
        {
          id,
          version,
          name: typeof manifest.name === "string" ? manifest.name : id,
          entry,
          lib,
          packageSha256: pkg.filesDigest,
          installedAt: new Date(now()).toISOString(),
        },
      ],
    };
    writeJsonAtomic(registryPath(), next);
    prune(id, version);
    cleanupStaging();

    const installed = current(id);
    if (!installed) throw new Error(`模块已写入但引擎目录缺失：${versionDir(id, version)}`);
    return installed;
  }

  /** 卸载：删注册表记录与版本目录（数据目录不在 modules 下，不受影响）。 */
  function remove(id) {
    const record = find(id);
    if (!record) return false;
    writeJsonAtomic(registryPath(), { modules: registry().filter((item) => item.id !== id) });
    try {
      fs.rmSync(baseDir(id), { recursive: true, force: true });
    } catch (err) {
      log(`[modules] 卸载目录删除失败（${id}）：${(err && err.message) || err}`);
    }
    return true;
  }

  return { current, find, install, registry, remove };
}

module.exports = {
  REGISTRY_FILE,
  createModuleStore,
};
