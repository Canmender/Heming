import { describe, expect, it } from "vitest";
import { adaptNewlines, detectNewlineStyle } from "./eol.js";

describe("换行风格探测（d.233）", () => {
  it("纯 LF / 纯 CRLF 各自认得出来", () => {
    expect(detectNewlineStyle("a\nb\n")).toBe("\n");
    expect(detectNewlineStyle("a\r\nb\r\n")).toBe("\r\n");
  });

  it("混合行尾、没有换行、空串都没有可跟随的风格", () => {
    expect(detectNewlineStyle("a\r\nb\nc")).toBeNull();
    expect(detectNewlineStyle("没有换行")).toBeNull();
    expect(detectNewlineStyle("")).toBeNull();
  });

  it("只有 \\r 不算换行（避免把老 Mac 行尾误当 LF）", () => {
    expect(detectNewlineStyle("a\rb")).toBeNull();
  });
});

describe("把待插入文本对齐到目标风格（d.233）", () => {
  it("LF 片段写进 CRLF 文件：全部转成 CRLF，并如实标记改动过", () => {
    expect(adaptNewlines("x\ny\n", "\r\n")).toEqual({ text: "x\r\ny\r\n", converted: true });
  });

  it("CRLF 片段写进 LF 文件：收敛成 LF，不会留下裸 \\r", () => {
    expect(adaptNewlines("x\r\ny\r\n", "\n")).toEqual({ text: "x\ny\n", converted: true });
  });

  it("已经是目标风格：原样返回，不算改动（避免误报「已对齐」）", () => {
    expect(adaptNewlines("x\r\ny", "\r\n")).toEqual({ text: "x\r\ny", converted: false });
    expect(adaptNewlines("x\ny", "\n")).toEqual({ text: "x\ny", converted: false });
  });

  it("没有可跟随的风格 / 空文本：原样返回", () => {
    expect(adaptNewlines("x\ny", null)).toEqual({ text: "x\ny", converted: false });
    expect(adaptNewlines("", "\r\n")).toEqual({ text: "", converted: false });
  });

  it("\\r\\r\\n 收敛后不残留 \\r（两个换行都保留成 \\n）", () => {
    expect(adaptNewlines("a\r\r\nb", "\n")).toEqual({ text: "a\n\nb", converted: true });
  });
});
