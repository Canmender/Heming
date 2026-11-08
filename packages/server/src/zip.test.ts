import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  ZipError,
  readZipEntries,
} from "./zip.js";

/**
 * 零依赖 zip 读取：只测「技能包解包要用到的行为」——STORE/DEFLATE、目录项、
 * 路径穿越、条目数与大小上限、坏 zip。
 */

interface ZipInput {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  /** 故意写错 CRC（模拟损坏/伪造包）。 */
  crcOverride?: number;
  /** 只改 local header 的 CRC（模拟 central/local 不一致）。 */
  localCrcOverride?: number;
}

/** 测试侧独立实现 CRC32，避免「拿被测实现造测试数据」。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** 手工构造一个最小 zip（读取端会校验 CRC）。 */
function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = entry.crcOverride ?? crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.localCrcOverride ?? crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function captureZipError(fn: () => unknown): ZipError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ZipError) return error;
    throw error;
  }
  throw new Error("应当抛出 ZipError");
}

describe("readZipEntries", () => {
  it("STORE 与 DEFLATE 两种方法都能解出原文", () => {
    const entries = readZipEntries(
      makeZip([
        { name: "SKILL.md", data: Buffer.from("# 技能\n正文", "utf8") },
        { name: "docs/notes.txt", data: Buffer.from("压缩内容".repeat(50), "utf8"), method: 8 },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(["SKILL.md", "docs/notes.txt"]);
    expect(entries[0].data.toString("utf8")).toContain("# 技能");
    expect(entries[1].data.toString("utf8")).toBe("压缩内容".repeat(50));
    expect(entries[1].size).toBe(Buffer.byteLength("压缩内容".repeat(50), "utf8"));
  });

  it("目录项跳过，不进入文件清单", () => {
    const entries = readZipEntries(
      makeZip([
        { name: "assets/" },
        { name: "assets/logo.png", data: Buffer.from([1, 2, 3]) },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(["assets/logo.png"]);
  });

  it("拒绝 `..` 路径穿越、绝对路径、盘符与 NUL", () => {
    for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/Windows/x.txt"]) {
      const error = captureZipError(() => readZipEntries(makeZip([{ name, data: Buffer.from("x") }])));
      expect(error.code).toBe("unsafe_path");
    }
    const nul = captureZipError(() =>
      readZipEntries(makeZip([{ name: "a\0b.txt", data: Buffer.from("x") }])),
    );
    expect(nul.code).toBe("unsafe_path");
  });

  it("单文件解压后超过 1MB → 拒绝", () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const error = captureZipError(() => readZipEntries(makeZip([{ name: "big.txt", data: big }])));
    expect(error.code).toBe("too_large");
  });

  it(`条目数超过 ${MAX_ZIP_ENTRIES} → 拒绝`, () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => ({
      name: `f${index}.txt`,
      data: Buffer.from("x"),
    }));
    const error = captureZipError(() => readZipEntries(makeZip(entries)));
    expect(error.code).toBe("too_many_entries");
  });

  it("zip 总字节超过 5MB → 拒绝", () => {
    const error = captureZipError(() => readZipEntries(Buffer.alloc(MAX_ZIP_BYTES + 1)));
    expect(error.code).toBe("too_large");
  });

  it("坏 zip / 截断 zip → invalid_zip", () => {
    expect(captureZipError(() => readZipEntries(Buffer.from("not a zip"))).code).toBe("invalid_zip");
    const valid = makeZip([{ name: "a.txt", data: Buffer.from("x") }]);
    expect(captureZipError(() => readZipEntries(valid.subarray(0, 10))).code).toBe("invalid_zip");
  });

  it("空 zip（0 条目）返回空数组", () => {
    expect(readZipEntries(makeZip([]))).toEqual([]);
  });

  it("重复条目（同 path）→ duplicate_entry（不允许 SKILL.md 被后一条覆盖）", () => {
    const duplicate = captureZipError(() =>
      readZipEntries(
        makeZip([
          { name: "SKILL.md", data: Buffer.from("declare-A") },
          { name: "SKILL.md", data: Buffer.from("actual-B") },
        ]),
      ),
    );
    expect(duplicate.code).toBe("duplicate_entry");
    expect(duplicate.message).toContain("重复条目");

    // 归一化后同名（./a.txt 与 a.txt）同样拒绝
    const normalizedDuplicate = captureZipError(() =>
      readZipEntries(
        makeZip([
          { name: "./a.txt", data: Buffer.from("1") },
          { name: "a.txt", data: Buffer.from("2") },
        ]),
      ),
    );
    expect(normalizedDuplicate.code).toBe("duplicate_entry");
  });

  it("CRC 错误（store 与 deflate 两条路径）→ invalid_zip", () => {
    const data = Buffer.from("技能正文", "utf8");
    for (const method of [0, 8] as const) {
      const error = captureZipError(() =>
        readZipEntries(makeZip([{ name: "SKILL.md", data, method, crcOverride: 0x12345678 }])),
      );
      expect(error.code).toBe("invalid_zip");
      expect(error.message).toContain("CRC");
    }
  });

  it("central 与 local 的 CRC 不一致 → invalid_zip", () => {
    const data = Buffer.from("hello", "utf8");
    const goodCrc = crc32(data);
    const error = captureZipError(() =>
      readZipEntries(
        makeZip([{ name: "SKILL.md", data, crcOverride: goodCrc, localCrcOverride: (goodCrc ^ 1) >>> 0 }]),
      ),
    );
    expect(error.code).toBe("invalid_zip");
    expect(error.message).toContain("CRC");
  });

  it("CRC 正确的空文件与 deflate 大文本仍可解（正例）", () => {
    const text = "内容".repeat(1000);
    const entries = readZipEntries(
      makeZip([
        { name: "empty.txt", data: Buffer.alloc(0) },
        { name: "big.txt", data: Buffer.from(text, "utf8"), method: 8 },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(["empty.txt", "big.txt"]);
    expect(entries[0].size).toBe(0);
    expect(entries[1].data.toString("utf8")).toBe(text);
  });
});
