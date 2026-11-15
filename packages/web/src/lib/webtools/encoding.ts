/**
 * 编码转换工具（内置只读工具 `encoding`，d.150.4.95.11）。
 *
 * 常用面：base64（含 URL-safe 变体）、URL 百分号编码、十六进制。
 * 全部按 UTF-8 处理（JSON 里的中文要能还原），坏输入返回中文原因、绝不抛。
 */

export type EncodingFormat = "base64" | "url" | "hex";
export type EncodingDirection = "encode" | "decode";
export type EncodingOutcome = { ok: true; text: string } | { ok: false; error: string };

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_INPUT_CHARS = 20_000;

export function normalizeFormat(raw: string): EncodingFormat | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "base64" || value === "b64") return "base64";
  if (value === "url" || value === "urlencode" || value === "percent") return "url";
  if (value === "hex" || value === "16" || value === "16进制") return "hex";
  return null;
}

export function normalizeDirection(raw: string | undefined): EncodingDirection {
  const value = String(raw ?? "encode").trim().toLowerCase();
  return value === "decode" || value === "解密" || value === "解码" ? "decode" : "encode";
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : BASE64_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : BASE64_ALPHABET[third & 0b111111];
  }
  return output;
}

function base64ToBytes(raw: string): Uint8Array | null {
  // 兼容 URL-safe 变体与缺失的填充符
  let text = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!text) return new Uint8Array();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  if (text.length % 4 === 1) return null;
  text = text.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    try {
      const lenient = new TextDecoder("utf-8").decode(bytes);
      return { ok: true, text: `${lenient}\n（字节不是合法 UTF-8，已按替换字符显示）` };
    } catch {
      return { ok: false, error: "字节不是合法 UTF-8，无法还原成文本" };
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(raw: string): Uint8Array | null {
  const text = raw.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!text) return new Uint8Array();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < text.length; index += 2) {
    bytes[index / 2] = Number.parseInt(text.slice(index, index + 2), 16);
  }
  return bytes;
}

/** 编码/解码任意文本；中间结果超过上限或格式不支持时返回中文错误。 */
export function convertText(
  rawText: string,
  rawFormat: string,
  rawDirection?: string,
): EncodingOutcome {
  const text = String(rawText ?? "");
  if (!text) return { ok: false, error: "内容为空" };
  if (text.length > MAX_INPUT_CHARS) {
    return { ok: false, error: `内容太长（上限 ${MAX_INPUT_CHARS} 个字符）` };
  }
  const format = normalizeFormat(rawFormat);
  if (!format) return { ok: false, error: `不支持的格式：${rawFormat}（可用 base64/url/hex）` };
  const direction = normalizeDirection(rawDirection);

  if (format === "url") {
    try {
      return { ok: true, text: direction === "encode" ? encodeURIComponent(text) : decodeURIComponent(text) };
    } catch {
      return { ok: false, error: "不是合法的 URL 编码（有残缺的 % 转义）" };
    }
  }

  if (format === "base64") {
    if (direction === "encode") return { ok: true, text: bytesToBase64(utf8Encode(text)) };
    const bytes = base64ToBytes(text);
    if (!bytes) return { ok: false, error: "不是合法的 base64（含有非法字符或长度不对）" };
    return utf8Decode(bytes);
  }

  if (direction === "encode") return { ok: true, text: bytesToHex(utf8Encode(text)) };
  const bytes = hexToBytes(text);
  if (!bytes) return { ok: false, error: "不是合法的十六进制（只能是 0-9a-f 且位数为偶数）" };
  return utf8Decode(bytes);
}
