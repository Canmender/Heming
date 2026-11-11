"use strict";
/**
 * 模块包安装器（d.133）：把「从更新源下载官方签名模块包 → 验签/解包 → 落盘」收成一处。
 *
 * 背景：插件区此前点「安装」只改本地 `heming.modules.v1` 开关，模块包根本没下载——
 * 界面显示已安装、运行时却加载不到。现在网页只负责发命令，下载/验签在主进程完成。
 *
 * 安全边界：只接受更新源 feed + 合法 id/version；验签、包结构、大小上限都在
 * `module-package.js` / `module-store.js` 里，本文件不解析模块代码。
 */

const { downloadModule, moduleUrl } = require("./module-download");

const DEFAULT_FEED = "http://47.92.39.184/updates/modules";
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * @param {object} options
 * @param {{ install: Function, registry: Function, remove: Function }} options.store module-store
 * @param {string} [options.feed]
 * @param {typeof downloadModule} [options.download]
 * @param {string} [options.keysFile]
 * @param {boolean} [options.allowDevKeys]
 * @param {(line: string) => void} [options.log]
 * @param {(payload: object) => void} [options.broadcast]
 */
function createModuleInstaller(options = {}) {
  const store = options.store;
  if (!store || typeof store.install !== "function") throw new Error("缺少 module-store");
  const feed = (options.feed || DEFAULT_FEED).replace(/\/+$/, "");
  const download = options.download || downloadModule;
  const keysFile = options.keysFile;
  const allowDevKeys = options.allowDevKeys === true;
  const log = options.log || (() => {});
  const broadcast = options.broadcast || (() => {});
  const pending = new Map();

  function packageOptions(expectedId) {
    return {
      expectedId,
      ...(keysFile ? { keysFile } : {}),
      ...(allowDevKeys ? { allowDevKeys: true } : {}),
    };
  }

  /**
   * 下载并安装一个模块包。并发同一 id 复用同一个 Promise。
   * @param {string} id
   * @param {string} version
   */
  async function install(id, version) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`模块 id 不合法：${String(id)}`);
    if (typeof version !== "string" || !VERSION_RE.test(version)) {
      throw new Error(`模块版本不合法：${String(version)}`);
    }
    const key = `${id}@${version}`;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const url = moduleUrl(feed, id, version);
      log(`[modules] 下载 ${key}：${url}`);
      broadcast({ stage: "download", id, version, received: 0, total: 0 });
      const bytes = await download({
        url,
        onProgress: ({ received, total }) => broadcast({ stage: "download", id, version, received, total }),
      });
      broadcast({ stage: "install", id, version, received: bytes.length, total: bytes.length });
      const installed = store.install(bytes, packageOptions(id));
      broadcast({ stage: "done", id, version, received: bytes.length, total: bytes.length });
      log(`[modules] 已安装 ${key}`);
      return installed;
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  }

  function remove(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`模块 id 不合法：${String(id)}`);
    return store.remove(id);
  }

  function list() {
    return store.registry();
  }

  return { install, remove, list, feed };
}

module.exports = { DEFAULT_FEED, createModuleInstaller };
