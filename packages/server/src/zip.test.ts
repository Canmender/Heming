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
}

/** 手工构造一个最小 zip（不校验 CRC，读取端也不校验）。 */
function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc（不校验）
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
    central.writeUInt32LE(0, 16);
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
});
