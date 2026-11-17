import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { STDIN_LIMIT_BYTES, readPromptFromStdin } from "./stdin.js";

describe("readPromptFromStdin", () => {
  it("把多段内容拼成完整 prompt（UTF-8 中文不乱码）", async () => {
    const stream = Readable.from([Buffer.from("把 src 下的 "), Buffer.from("TODO 列出来")]);
    const read = await readPromptFromStdin(stream);
    expect(read).toEqual({ ok: true, text: "把 src 下的 TODO 列出来" });
  });

  it("剥掉 BOM：否则第一个词会变成「\\uFEFF请…」", async () => {
    const stream = Readable.from([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("总结 README")]);
    const read = await readPromptFromStdin(stream);
    expect(read.ok && read.text).toBe("总结 README");
  });

  it("空输入给空串（是否算用法错误由调用方判断）", async () => {
    const read = await readPromptFromStdin(Readable.from([]));
    expect(read).toEqual({ ok: true, text: "" });
  });

  it("超过上限立即失败并说清怎么办（不把整份大文件读进内存）", async () => {
    const big = Buffer.alloc(STDIN_LIMIT_BYTES + 1, 0x61);
    const read = await readPromptFromStdin(Readable.from([big]));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toContain("超过");
      expect(read.error).toContain("--cwd");
    }
  });

  it("读取失败时报可读原因，而不是抛栈", async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error("管道断了"));
      },
    });
    const read = await readPromptFromStdin(broken);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("管道断了");
  });
});
