"use strict";
const zlib = require("node:zlib");

/**
 * 界面插件包（`package.tgz`）的 tar 读写（纯函数，不依赖 electron，可直接单测）。
 *
 * 为什么自己写 tar：安装端只在主进程里解包，宿主不能因为「装一个桌宠插件」引入
 * 一个几百 KB 的解压依赖；tar 是 512 字节定长头的简单格式，读与写各百来行，
 * 而且**确定性输出**（固定 mtime / uid / gid / 排序）让同一个包在任意机器上
 * 得到同一个 sha256——发布链路与 integrity 校验都依赖这一点。
 *
 * 边界（调用方 plugin-package.js 还会按配额再校验一遍）：
 * - 只接受普通文件（typeflag `0` 或 `\0`）与目录（`5`，跳过）；符号链接/硬链接/设备一律拒；
 * - 路径必须是相对 POSIX 路径：禁绝对路径、禁 `..` 段、禁 NUL、禁反斜杠；总长 ≤ 100（USTAR name）；
 * - 解包上限：≤ 64MB、≤ 4000 个文件、单文件 ≤ 16MB（可被入参覆盖）。
 *   d.125 起带「本机引擎」的插件要随包携带纯 Python 依赖，20MB 装不下；
 *
 * ★ 只做「格式正确 + 边界安全」，不做「这是不是一个合法插件包」——清单校验在
 *   plugin-package.js 里，两者分开才能各自单测。
 */

const BLOCK = 512;
const MAX_NAME = 100;
const LIMITS = Object.freeze({
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 4000,
  maxFileBytes: 16 * 1024 * 1024,
});

/** 规范化并校验一个包内相对路径；非法返回 null。 */
function safeRelativePath(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\\/g, "/");
  if (!text || text.length > MAX_NAME) return null;
  if (text.includes("\0")) return null;
  if (text.startsWith("/")) return null;
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  if (parts.length === 0) return null;
  const joined = parts.join("/");
  // 目录条目允许以 / 结尾；文件条目不允许
  return raw.endsWith("/") ? `${joined}/` : joined;
}

function octal(value, width) {
  const text = value.toString(8);
  return text.length >= width ? text.slice(-width) : text.padStart(width - 1, "0") + "\0";
}

function writeHeader(name, size, mode) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, MAX_NAME, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii"); // uid
  header.write(octal(0, 8), 116, 8, "ascii"); // gid
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii"); // mtime = 0 → 确定性
  header.write("        ", 148, 8, "ascii"); // 校验和先填空格
  header.write("0", 156, 1, "ascii"); // typeflag = 普通文件
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/**
 * 生成确定性 tar。
 * @param {Array<{path: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
function writeTar(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("tar: 至少需要一个文件");
  const seen = new Set();
  const prepared = entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("tar: 条目必须是对象");
    const path = safeRelativePath(entry.path);
    if (!path || path.endsWith("/")) throw new Error(`tar: 非法路径 ${String(entry.path)}`);
    if (seen.has(path)) throw new Error(`tar: 重复路径 ${path}`);
    seen.add(path);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    return { path, data };
  });
  // 排序：同一份内容必须产出同一串字节（发布侧算 sha256 依赖它）
  prepared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const chunks = [];
  for (const { path, data } of prepared) {
    chunks.push(writeHeader(path, data.length, 0o644));
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // 两个 0 块收尾
  return Buffer.concat(chunks);
}

function readOctal(buffer, offset, length) {
  const text = buffer.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) return NaN;
  return parseInt(text, 8);
}

/**
 * 解 tar（不含 gzip）。任何越界/非法条目直接抛错——安装不允许「装一半」。
 * @param {Buffer} buffer
 * @param {{ maxTotalBytes?: number, maxFiles?: number, maxFileBytes?: number }} [limits]
 * @returns {Array<{ path: string, data: Buffer }>}
 */
function readTar(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("tar: 内容为空");
  const maxTotalBytes = limits.maxTotalBytes ?? LIMITS.maxTotalBytes;
  const maxFiles = limits.maxFiles ?? LIMITS.maxFiles;
  const maxFileBytes = limits.maxFileBytes ?? LIMITS.maxFileBytes;
  const files = [];
  let total = 0;
  let offset = 0;
  let sawEnd = false;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    // 校验和：把 chksum 字段当空格再求和
    const expected = readOctal(header, 148, 8);
    const copy = Buffer.from(header);
    copy.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (const byte of copy) sum += byte;
    if (Number.isNaN(expected) || sum !== expected) throw new Error("tar: 头部校验和不匹配");
    if (header.toString("ascii", 257, 262) !== "ustar") throw new Error("tar: 不是 USTAR 格式");

    const typeflag = header.toString("ascii", 156, 157);
    const size = readOctal(header, 124, 12);
    if (Number.isNaN(size) || size < 0) throw new Error("tar: 文件大小非法");
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`tar: 条目越界 ${name}`);

    if (typeflag === "5") {
      // 目录：跳过，不落盘（安装端按文件路径自行建目录）
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "") {
      throw new Error(`tar: 不允许的条目类型 ${JSON.stringify(typeflag)}（${name}）`);
    }
    const path = safeRelativePath(name);
    if (!path || path.endsWith("/")) throw new Error(`tar: 非法路径 ${JSON.stringify(name)}`);
    if (size > maxFileBytes) throw new Error(`tar: 单文件超过上限 ${path}`);
    if (!Number.isInteger(size) || size < 0) throw new Error(`tar: 文件大小非法 ${path}`);
    total += size;
    if (total > maxTotalBytes) throw new Error("tar: 解包总量超过上限");
    if (files.length + 1 > maxFiles) throw new Error("tar: 文件数量超过上限");
    files.push({ path, data: Buffer.from(buffer.subarray(dataStart, dataEnd)) });
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!sawEnd) throw new Error("tar: 缺少结束块（内容被截断）");
  return files;
}

/** 打包：tar + gzip(level 9)。 */
function packTarGz(entries) {
  return zlib.gzipSync(writeTar(entries), { level: 9 });
}

/** 解包：gunzip + tar 校验。 */
function unpackTarGz(buffer, limits) {
  let raw;
  try {
    raw = zlib.gunzipSync(buffer);
  } catch {
    throw new Error("插件包不是合法的 gzip 文件");
  }
  return readTar(raw, limits);
}

module.exports = { writeTar, readTar, packTarGz, unpackTarGz, safeRelativePath, LIMITS };
