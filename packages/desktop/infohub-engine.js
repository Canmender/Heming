"use strict";
/**
 * 信息中枢引擎（选装 Python 包）的安装与定位。
 *
 * ★ 对 module-store / module-download / module-package 的依赖是有意的：
 *   web 模块体系（页面经 app:// 加载的宿主式模块）已整体下线，module-installer.js
 *   随之删除；但这三个文件是「选装 Python 引擎」的装机链，沙箱插件的
 *   permissions.infohub 全靠它把引擎补下载到 `<userData>/modules` 后拉起。
 *
 * ## 为什么引擎包不随安装包分发
 * Python 引擎是选装能力：安装包只带共享运行时，不预装引擎包。第一次启用
 * 「信息中枢」时按需从更新源下载官签名包，落到 `<userData>/modules` 后自动启动。
 * 这样安装包不背引擎、引擎可独立升级，用户也不需要任何配置界面。
 *
 * ## 边界
 * - 只认官方签名的包（`module-package.js` 首方验签 + `files/**` 摘要）；
 * - 下载地址由 id/版本拼出，默认更新源；`HEMING_MODULE_FEED` 可指向本地目录做自检；
 * - 并发安装共用同一个 Promise，避免两个窗口同时点「安装」各下一份。
 */

const path = require("node:path");
const { createModuleStore } = require("./module-store");
const { downloadModule, moduleUrl } = require("./module-download");

/**
 * 引擎所在模块包的 id。
 *
 * 引擎已并入「信息中枢」引擎包（同一个包同时带 `files/app`+`files/lib`），
 * 所以这里必须等于引擎包 id：包 id 统一加 `heming.` 前缀后也要跟着改。
 * 已装用户的旧目录/记录由 `module-store.js` 的 `migrateLegacyIds()` 在启动时迁到新 id。
 */
const ENGINE_ID = "heming.infohub";
/**
 * 应用期望的引擎版本；升级引擎时改这里（引擎包自己的 version 必须一致）。
 *
 * 必须与更新源上 `heming.infohub` 引擎包的 `version` 一致：`ensure()` 按这个版本从
 * 更新源补下载，对不上就会去要一个下载源里不存在的版本。发布侧由 Lead 统一维护。
 */
const ENGINE_VERSION = "1.1.0";
const DEFAULT_FEED = process.env.HEMING_MODULE_FEED || "http://47.92.39.184/updates/modules";

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * @param {object} options
 * @param {string} options.dir 模块根目录（`<userData>/modules`）
 * @param {string} [options.base] 模块源（http(s):// / file:// / 绝对路径）
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @param {boolean} [options.allowDevKeys] 未打包时为 true（已在 main.js 里设过环境变量）
 * @param {string} [options.keysFile] 首方公钥表（仅测试/自检注入）
 * @param {(line: string) => void} [options.log]
 * @param {(progress: object) => void} [options.broadcast] 下载/安装进度
 */
function createInfohubEngine(options = {}) {
  const dir = options.dir;
  if (typeof dir !== "string" || !dir) throw new Error("infohub-engine: 缺少 dir");
  const base = typeof options.base === "string" && options.base ? options.base : DEFAULT_FEED;
  const log = options.log || (() => {});
  const broadcast = options.broadcast || (() => {});
  const store = createModuleStore({ dir, log });

  /** 进行中的安装：并发调用共用同一份。 */
  let pending = null;

  function dirs() {
    const current = store.current(ENGINE_ID);
    return current
      ? { packageDir: current.appDir, libraryDir: current.libDir, version: current.version }
      : { packageDir: "", libraryDir: "", version: "" };
  }

  function info() {
    const current = store.current(ENGINE_ID);
    return {
      id: ENGINE_ID,
      expectedVersion: ENGINE_VERSION,
      installed: Boolean(current),
      version: current ? current.version : "",
      base,
    };
  }

  function normalizeVersion(value) {
    return typeof value === "string" && VERSION_RE.test(value) ? value : ENGINE_VERSION;
  }

  /**
   * 确保指定版本的引擎已安装；已安装则直接返回。
   * @param {string} [version] 应用期望的版本（缺省 `ENGINE_VERSION`）
   */
  async function ensure(version) {
    const target = normalizeVersion(version);
    const current = store.current(ENGINE_ID);
    // 只装了 Web UI、没装引擎的旧记录不算就绪：补下载同一插件包（含 app/ 引擎）。
    if (current && current.version === target && current.appDir) {
      return { ...info(), updated: false };
    }
    if (pending) return pending;

    pending = (async () => {
      const url = moduleUrl(base, ENGINE_ID, target);
      log(`[infohub] 下载引擎模块 ${target}：${url}`);
      broadcast({ stage: "download", version: target, received: 0, total: 0 });
      const bytes = await downloadModule({
        url,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        onProgress: ({ received, total }) =>
          broadcast({ stage: "download", version: target, received, total }),
      });
      broadcast({ stage: "install", version: target, received: bytes.length, total: bytes.length });
      const installed = store.install(bytes, {
        expectedId: ENGINE_ID,
        ...(options.allowDevKeys !== undefined ? { allowDevKeys: options.allowDevKeys === true } : {}),
        ...(options.keysFile ? { keysFile: options.keysFile } : {}),
      });
      broadcast({
        stage: "done",
        version: installed.version,
        received: bytes.length,
        total: bytes.length,
      });
      log(`[infohub] 引擎模块已安装：${installed.version}`);
      return { ...info(), updated: true };
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  function remove() {
    return store.remove(ENGINE_ID);
  }

  return { dirs, ensure, info, remove };
}

module.exports = {
  DEFAULT_FEED,
  ENGINE_ID,
  ENGINE_VERSION,
  createInfohubEngine,
};
