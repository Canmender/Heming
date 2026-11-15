import { describe, expect, it } from "vitest";
import { convertText, normalizeDirection, normalizeFormat } from "./encoding.js";

describe("normalizeFormat / normalizeDirection", () => {
  it("接受别名与中文，未知格式返回 null", () => {
    expect(normalizeFormat("base64")).toBe("base64");
    expect(normalizeFormat("B64")).toBe("base64");
    expect(normalizeFormat("urlencode")).toBe("url");
    expect(normalizeFormat("16进制")).toBe("hex");
    expect(normalizeFormat("rot13")).toBeNull();
    expect(normalizeDirection(undefined)).toBe("encode");
    expect(normalizeDirection("DECODE")).toBe("decode");
    expect(normalizeDirection("解码")).toBe("decode");
  });
});

describe("convertText", () => {
  it("base64 往返中文", () => {
    const encoded = convertText("和鸣 智能体", "base64");
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.text).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const decoded = convertText(encoded.text, "base64", "decode");
    expect(decoded).toEqual({ ok: true, text: "和鸣 智能体" });
  });

  it("base64 兼容 URL-safe 变体与缺失填充", () => {
    const standard = convertText("a?b", "base64");
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    const urlSafe = standard.text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(convertText(urlSafe, "base64", "decode")).toEqual({ ok: true, text: "a?b" });
  });

  it("URL 百分号编码往返", () => {
    const encoded = convertText("a b&c=d", "url");
    expect(encoded).toEqual({ ok: true, text: "a%20b%26c%3Dd" });
    expect(convertText("a%20b%26c%3Dd", "url", "decode")).toEqual({ ok: true, text: "a b&c=d" });
  });

  it("十六进制编解码（UTF-8 字节）", () => {
    const encoded = convertText("和", "hex");
    expect(encoded).toEqual({ ok: true, text: "e5928c" });
    expect(convertText("e5928c", "hex", "decode")).toEqual({ ok: true, text: "和" });
    expect(convertText("E5 92 8C", "hex", "decode")).toEqual({ ok: true, text: "和" });
  });

  it("坏输入返回中文错误而不是抛", () => {
    const badBase64 = convertText("!!!", "base64", "decode");
    expect(badBase64.ok).toBe(false);
    if (!badBase64.ok) expect(badBase64.error).toContain("base64");
    const badHex = convertText("abc", "hex", "decode");
    expect(badHex.ok).toBe(false);
    const badUrl = convertText("%zz", "url", "decode");
    expect(badUrl.ok).toBe(false);
    const unknown = convertText("x", "rot13");
    expect(unknown.ok).toBe(false);
    expect(convertText("", "base64").ok).toBe(false);
  });
});
