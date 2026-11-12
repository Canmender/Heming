"use strict";
/**
 * 下载与哈希校验。
 *
 * 只用 node:http / node:https，不引第三方库：
 * - 安装器是最先运行的那一个程序，依赖越少越不容易在用户机器上出意外；
 * - 需要的功能很少：GET、跟随 302、流式落盘、边下边算 sha512。
 *
 * 为什么要边下边算：内层安装包 300MB 上下，落盘后再读一遍要多花一秒多；
 * 而且失败时能立刻判定「服务器上的文件和 latest.yml 对不上」。
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { SetupError, CODES } = require("./errors");

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60000;
const CONNECT_TIMEOUT_MS = 20000;
const USER_AGENT = "HemingSetup/1.0 (Windows)";

/**
 * 打开一个 URL 的响应流，自动跟随重定向。
 * @param {string} url
 * @param {{signal?: AbortSignal, redirectsLeft?: number, timeoutMs?: number}} [options]
 * @returns {Promise<import("node:http").IncomingMessage>}
 */
function openStream(url, options = {}) {
  const { signal, redirectsLeft = MAX_REDIRECTS, timeoutMs = CONNECT_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new SetupError(CODES.NETWORK, "服务器地址无效", error));
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(
      parsed,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          Connection: "keep-alive",
        },
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new SetupError(CODES.NETWORK, "服务器重定向次数过多", `重定向到 ${response.headers.location}`));
            return;
          }
          const next = new URL(response.headers.location, parsed).toString();
          resolve(openStream(next, { signal, redirectsLeft: redirectsLeft - 1, timeoutMs }));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(
            new SetupError(
              CODES.NETWORK,
              `服务器返回了 ${status}，安装包可能还没上传完整`,
              `GET ${url} -> ${status}`,
            ),
          );
          return;
        }
        resolve(response);
      },
    );
    request.on("timeout", () => request.destroy(new Error("连接超时")));
    request.on("error", (error) => {
      // 用户点「取消」时 signal 会 abort，此时要把错误标成 AbortError，
      // 否则上层会把它当成网络故障，取消就变成了报错。
      if (signal && signal.aborted) {
        const abortError = new Error("cancelled");
        abortError.name = "AbortError";
        reject(abortError);
        return;
      }
      reject(new SetupError(CODES.NETWORK, "连不上更新服务器", error));
    });
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error("cancelled"));
      }
      signal.addEventListener("abort", () => request.destroy(new Error("cancelled")), { once: true });
    }
  });
}

/**
 * 取一个小的文本资源（latest.yml 一般不到 1KB）。
 * @param {string} url
 * @param {{signal?: AbortSignal, maxBytes?: number}} [options]
 * @returns {Promise<string>}
 */
async function fetchText(url, options = {}) {
  const { signal, maxBytes = 1024 * 1024 } = options;
  const response = await openStream(url, { signal });
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        reject(new SetupError(CODES.FEED_INVALID, "更新信息异常（体积过大）", `${url} 超过 ${maxBytes} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", (error) => reject(new SetupError(CODES.NETWORK, "读取更新信息失败", error)));
  });
}

/**
 * 流式下载到 dest，同时算 sha512。
 *
 * @param {string} url
 * @param {string} dest 目标文件路径（父目录会自动创建）
 * @param {{
 *   signal?: AbortSignal,
 *   expectedSize?: number|null,
 *   idleTimeoutMs?: number,
 *   onProgress?: (info: {received: number, total: number|null}) => void,
 * }} [options]
 * @returns {Promise<{filePath: string, bytes: number, sha512: string, total: number|null}>}
 */
async function downloadFile(url, dest, options = {}) {
  const { signal, expectedSize = null, idleTimeoutMs = IDLE_TIMEOUT_MS, onProgress } = options;
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const response = await openStream(url, { signal });
  const total = numberOrNull(response.headers["content-length"]) ?? numberOrNull(expectedSize);
  const hash = crypto.createHash("sha512");
  const out = fs.createWriteStream(dest);
  let received = 0;
  let lastEmit = 0;
  let idleTimer = null;

  const cleanup = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    out.destroy();
    await fsp.rm(dest, { force: true }).catch(() => {});
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      response.destroy(new Error("idle"));
    }, idleTimeoutMs);
  };
  armIdle();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      await cleanup();
      if (error && error.message === "cancelled") {
        reject(new SetupError(CODES.CANCELLED, "已取消下载", null));
      } else if (error && error.message === "idle") {
        reject(new SetupError(CODES.DOWNLOAD_STALLED, "下载卡住了（长时间没有数据）", url));
      } else {
        reject(new SetupError(CODES.DOWNLOAD_FAILED, "下载安装包时出错", error));
      }
    };

    if (signal) {
      if (signal.aborted) {
        fail(new Error("cancelled"));
        return;
      }
      signal.addEventListener("abort", () => response.destroy(new Error("cancelled")), { once: true });
    }

    response.on("data", (chunk) => {
      armIdle();
      received += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) {
        response.pause();
        out.once("drain", () => response.resume());
      }
      const now = Date.now();
      if (onProgress && (now - lastEmit > 200 || received === total)) {
        lastEmit = now;
        onProgress({ received, total });
      }
    });
    response.on("error", fail);
    // 写盘失败（最典型是磁盘满）也得走 fail：否则 stream 的 error 事件没人接，
    // 会变成未捕获异常，界面上只剩「安装程序提前停下了」。
    out.on("error", (error) => {
      if (error && error.code === "ENOSPC") {
        fail(new SetupError(CODES.NO_SPACE, "磁盘空间不够", "下载安装包时磁盘写满了"));
        return;
      }
      fail(error);
    });
    response.on("end", () => {
      if (idleTimer) clearTimeout(idleTimer);
      out.end(() => {
        if (settled) return;
        settled = true;
        // 长度对不上先报错：比 sha512 不匹配的提示更具体（服务端文件被截断 / 代理缓存不完整）
        if (total !== null && received !== total) {
          cleanup().then(() =>
            reject(
              new SetupError(
                CODES.DOWNLOAD_FAILED,
                "安装包没有下载完整",
                `期望 ${total} 字节，实际 ${received} 字节`,
              ),
            ),
          );
          return;
        }
        resolve({ filePath: dest, bytes: received, sha512: hash.digest("base64"), total });
      });
    });
  });
}

/**
 * 算一个已存在文件的 sha512（base64）。
 * 用于校验内嵌 / 就地取用的安装包，以及给日志留证据。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha512File(filePath) {
  const hash = crypto.createHash("sha512");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("base64");
}

/**
 * 比较两个 sha512（大小写无关；latest.yml 里是 base64）。
 * @param {string} expected
 * @param {string} actual
 */
function sha512Equals(expected, actual) {
  if (!expected || !actual) return false;
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  fetchText,
  downloadFile,
  sha512File,
  sha512Equals,
  MAX_REDIRECTS,
  IDLE_TIMEOUT_MS,
};
