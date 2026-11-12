"use strict";
/**
 * 选装 Python 引擎包的下载（主进程）。
 *
 * 只服务信息中枢引擎的补下载（web 模块体系已下线）：`infohub-engine.js` 在
 * `<userData>/modules` 里没找到目标版本时，按 id@version 从更新源取 `module.tgz`。
 *
 * 只负责「把字节拿下来」，验签与解包在 `module-package.js` / `module-store.js`。
 * 支持三种来源，便于发布与本机自检共用同一条路：
 * - `http(s)://`：更新源静态目录；
 * - `file://`：本机自检/离线安装；
 * - 绝对路径：开发态直接读仓库里的产物。
 *
 * 边界：大小上限先看 `content-length`、再按实际累计字节兜底（服务端可能不报长度）；
 * 下载中断/超限一律抛错，不返回半个包。
 */

const fs = require("node:fs");
const { fileURLToPath } = require("node:url");

const DEFAULT_MAX_BYTES = 80 * 1024 * 1024;

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * @param {object} options
 * @param {string} options.url `http(s)://` / `file://` / 绝对路径
 * @param {(progress: {received: number, total: number}) => void} [options.onProgress]
 * @param {number} [options.maxBytes]
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @returns {Promise<Buffer>}
 */
async function downloadModule({ url, onProgress, maxBytes = DEFAULT_MAX_BYTES, fetchImpl = fetch }) {
  if (typeof url !== "string" || !url.trim()) throw new Error("缺少模块包地址");
  const target = url.trim();

  if (target.startsWith("file://")) {
    return readLocal(fileURLToPath(target), maxBytes, onProgress);
  }
  if (/^[A-Za-z]:[\\/]|^\//.test(target)) {
    return readLocal(target, maxBytes, onProgress);
  }
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`不支持的模块包地址：${target.slice(0, 120)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(target, { redirect: "follow", signal: controller.signal });
  } catch (err) {
    throw new Error(`连接模块源失败：${(err && err.message) || err}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response || !response.ok) {
    throw new Error(`模块包下载失败（HTTP ${response ? response.status : "?"}）：${target}`);
  }

  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`模块包过大（${declared} 字节 > ${maxBytes}）`);
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`模块包过大（${bytes.length} 字节 > ${maxBytes}）`);
    onProgress?.({ received: bytes.length, total: bytes.length });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = toBuffer(value);
    received += chunk.length;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* 已断开 */
      }
      throw new Error(`模块包过大（已下载 ${received} 字节 > ${maxBytes}）`);
    }
    chunks.push(chunk);
    onProgress?.({ received, total: Number.isFinite(declared) ? declared : 0 });
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new Error("模块包下载结果为空");
  return bytes;
}

function readLocal(file, maxBytes, onProgress) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`读取本地模块包失败：${(err && err.message) || err}`);
  }
  if (bytes.length === 0) throw new Error("本地模块包是空的");
  if (bytes.length > maxBytes) throw new Error(`模块包过大（${bytes.length} 字节 > ${maxBytes}）`);
  onProgress?.({ received: bytes.length, total: bytes.length });
  return bytes;
}

/** 模块包地址：`<base>/<id>/<version>/module.tgz`。 */
function moduleUrl(base, id, version) {
  return `${String(base).replace(/[\\/]+$/, "")}/${id}/${version}/module.tgz`;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  downloadModule,
  moduleUrl,
};
