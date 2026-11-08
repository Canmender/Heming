import { inflateRawSync } from "node:zlib";

/**
 * 零依赖 zip 读取（d.109）：只做「技能包解包出 SKILL.md + 文件清单」这一件事。
 *
 * 为什么自己写而不是引 `adm-zip`/`unzipper`：
 * - 服务端只处理**第三方社区**的 zip，安全面必须自己收口（路径穿越、zip bomb、条目数）；
 * - 需要的能力只有 STORE(0) 与 DEFLATE(8) 两种方法，中央目录结构固定，代码量比审计一个依赖小；
 * - 不落盘、不执行：内存里解压，调用方拿到 Buffer 后自行决定怎么用。
 *
 * 限制（全部为硬拒绝，不是截断）：
 * - zip 总字节 ≤ 5MB；单文件解压后 ≤ 1MB；文件数 ≤ 200；解压总量 ≤ 16MB（zip bomb 兜底）；
 * - 拒绝路径穿越（`..`、绝对路径、盘符、NUL）、加密条目、ZIP64、未知压缩方法。
 *
 * 不校验 CRC：上游包由虾评生成，这里的目标是「安全地解出内容」，不是完整性校验；
 * 完整性由 HTTP 层的 `Content-Length`/长度上限与调用方的 sha256 记录负责。
 */

/** zip 字节上限（与技能社区契约 `SkillHubDownload.size` 上限一致）。 */
export const MAX_ZIP_BYTES = 5 * 1024 * 1024;
/** 单个条目解压后的上限。 */
export const MAX_ZIP_ENTRY_BYTES = 1024 * 1024;
/** 条目数上限。 */
export const MAX_ZIP_ENTRIES = 200;
/** 解压总量上限（防 zip bomb；正常技能包只有几 KB 文本）。 */
export const MAX_ZIP_TOTAL_BYTES = 16 * 1024 * 1024;
/** 路径长度上限（契约里 `files[].path` 同样是 300）。 */
const MAX_PATH_LENGTH = 300;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA = 0x0001;
const EOCD_MIN_SIZE = 22;

export type ZipErrorCode =
  | "invalid_zip"
  | "too_large"
  | "too_many_entries"
  | "unsafe_path"
  | "unsupported";

/** 解包失败（调用方据此映射 HTTP 状态；消息可直接给用户看中文）。 */
export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(message: string, code: ZipErrorCode) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ZipEntry {
  /** 归一化后的包内相对路径（`/` 分隔、无 `..`/绝对路径）。 */
  path: string;
  /** 解压后字节数。 */
  size: number;
  /** 解压后内容（条目 ≤ 1MB，已在内存里）。 */
  data: Buffer;
}

/** 取中央目录结束位置（EOCD）：从尾部往前找签名（注释最长 64KB）。 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_SIZE) {
    throw new ZipError("不是合法的 ZIP（文件过小）", "invalid_zip");
  }
  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - 0xffff);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("不是合法的 ZIP（找不到中央目录）", "invalid_zip");
}

/** 包内路径归一化 + 穿越守卫。 */
function normalizeEntryPath(raw: string): string {
  if (!raw || raw.includes("\0")) throw new ZipError("ZIP 条目路径含非法字符", "unsafe_path");
  if (raw.length > MAX_PATH_LENGTH) throw new ZipError("ZIP 条目路径过长", "unsafe_path");
  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw new ZipError(`ZIP 条目路径不允许绝对路径：${raw}`, "unsafe_path");
  }
  const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw new ZipError(`ZIP 条目路径非法：${raw}`, "unsafe_path");
  if (segments.some((segment) => segment === "..")) {
    throw new ZipError(`ZIP 条目路径不允许 ..：${raw}`, "unsafe_path");
  }
  return segments.join("/");
}

/** 读一个条目的解压后内容：只支持 STORE(0) / DEFLATE(8)。 */
function readEntryData(
  buffer: Buffer,
  localOffset: number,
  compressedSize: number,
  method: number,
  uncompressedSize: number,
  path: string,
): Buffer {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new ZipError(`ZIP 条目头损坏：${path}`, "invalid_zip");
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) throw new ZipError(`ZIP 条目数据越界：${path}`, "invalid_zip");
  const compressed = buffer.subarray(dataStart, dataEnd);

  if (method === 0) {
    if (compressed.length > MAX_ZIP_ENTRY_BYTES) {
      throw new ZipError(`ZIP 条目超过单文件上限（1MB）：${path}`, "too_large");
    }
    return Buffer.from(compressed);
  }
  if (method !== 8) throw new ZipError(`不支持的 ZIP 压缩方法（${method}）：${path}`, "unsupported");

  let data: Buffer;
  try {
    data = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES + 1 });
  } catch {
    throw new ZipError(`ZIP 条目解压失败：${path}`, "invalid_zip");
  }
  if (data.length > MAX_ZIP_ENTRY_BYTES || uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new ZipError(`ZIP 条目超过单文件上限（1MB）：${path}`, "too_large");
  }
  return data;
}

/**
 * 读取 zip 全部非目录条目。
 *
 * @throws ZipError `invalid_zip` / `too_large` / `too_many_entries` / `unsafe_path` / `unsupported`
 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (!Buffer.isBuffer(buffer)) throw new ZipError("zip 内容必须是 Buffer", "invalid_zip");
  if (buffer.length === 0) throw new ZipError("zip 内容为空", "invalid_zip");
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new ZipError(`zip 超过大小上限（${MAX_ZIP_BYTES / 1024 / 1024}MB）`, "too_large");
  }

  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new ZipError("不支持 ZIP64 技能包", "unsupported");
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new ZipError(`ZIP 文件数超过上限（${MAX_ZIP_ENTRIES}）`, "too_many_entries");
  }
  if (totalEntries === 0) return [];
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError("ZIP 中央目录越界", "invalid_zip");
  }

  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError("ZIP 中央目录损坏", "invalid_zip");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new ZipError("ZIP 条目名越界", "invalid_zip");

    const rawName = buffer.subarray(nameStart, nameEnd).toString("utf8");
    offset = nameEnd + extraLength + commentLength;

    // 只认 zip64 扩展标记（其余 extra 字段与本次解包无关）
    if (extraLength >= 4) {
      let cursor = nameEnd;
      const extraEnd = nameEnd + extraLength;
      while (cursor + 4 <= extraEnd) {
        const headerId = buffer.readUInt16LE(cursor);
        const size = buffer.readUInt16LE(cursor + 2);
        if (headerId === ZIP64_EXTRA) throw new ZipError("不支持 ZIP64 技能包", "unsupported");
        cursor += 4 + size;
      }
    }

    if ((flags & 0x1) !== 0) throw new ZipError(`不支持加密的 ZIP 条目：${rawName}`, "unsupported");
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new ZipError(`ZIP 条目超过单文件上限（1MB）：${rawName}`, "too_large");
    }

    const isDirectory = rawName.endsWith("/") || rawName.endsWith("\\");
    const path = normalizeEntryPath(rawName);
    if (isDirectory) continue; // 目录项只为建目录，解包时不需要

    const data = readEntryData(buffer, localOffset, compressedSize, method, uncompressedSize, path);
    totalUncompressed += data.length;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
      throw new ZipError("ZIP 解压总量超过上限（16MB）", "too_large");
    }
    entries.push({ path, size: data.length, data });
  }

  return entries;
}
