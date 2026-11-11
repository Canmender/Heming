/**
 * 加密节点：哈希、HMAC、Base64、UUID。
 *
 * 为什么用 Web Crypto 而不是自己实现：SHA/HMAC 的正确实现细节（填充、常量、长度）
 * 不是这个产品该重写的东西；Web Crypto 在浏览器与桌面端都可用，且不需要新依赖。
 * 代价是异步——节点 execute 本来就是 async，不影响调用方。
 */

import type { INodeType } from "../../types";
import { inputItems, readString, withField } from "./helpers";

const HASH_ALGORITHMS = [
  { name: "SHA-256", value: "SHA-256" },
  { name: "SHA-1", value: "SHA-1" },
  { name: "SHA-384", value: "SHA-384" },
  { name: "SHA-512", value: "SHA-512" },
];

const OPERATIONS = [
  { name: "哈希", value: "hash" },
  { name: "HMAC 签名", value: "hmac" },
  { name: "Base64 编码", value: "base64Encode" },
  { name: "Base64 解码", value: "base64Decode" },
  { name: "生成 UUID", value: "uuid" },
];

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function textToBytes(text: string): Uint8Array<ArrayBuffer> {
  // 显式拷贝到 ArrayBuffer 支撑的视图：Web Crypto 的 BufferSource 不接受
  // 可能由 SharedArrayBuffer 支撑的 Uint8Array（TS 5.9 的泛型视图类型会拦下来）。
  const encoded = new TextEncoder().encode(text);
  const copy = new Uint8Array(encoded.length);
  copy.set(encoded);
  return copy;
}

/** 取 Web Crypto；拿不到时给出可读错误（而不是 undefined 上的怪异常）。 */
function subtleCrypto(): SubtleCrypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) throw new Error("当前环境没有 Web Crypto，无法做哈希/HMAC");
  return cryptoObj.subtle;
}

export const cryptoNode: INodeType = {
  description: {
    type: "crypto",
    displayName: "加密",
    group: "transform",
    description: "做哈希、HMAC 签名、Base64 编解码，或生成 UUID。",
    icon: "lock",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "operation",
        displayName: "操作",
        type: "options",
        default: "hash",
        options: OPERATIONS,
      },
      {
        name: "value",
        displayName: "内容",
        type: "string",
        default: "",
        description: "要处理的内容，支持 {{ }} 表达式；留空则使用输入数据的 json 序列化结果。",
        displayOptions: { show: { operation: ["hash", "hmac", "base64Encode", "base64Decode"] } },
      },
      {
        name: "secret",
        displayName: "密钥",
        type: "string",
        default: "",
        description: "HMAC 的密钥；建议先用凭据节点保存，不要直接写在工作流里。",
        displayOptions: { show: { operation: ["hmac"] } },
      },
      {
        name: "algorithm",
        displayName: "算法",
        type: "options",
        default: "SHA-256",
        options: HASH_ALGORITHMS,
        displayOptions: { show: { operation: ["hash", "hmac"] } },
      },
      {
        name: "encoding",
        displayName: "输出编码",
        type: "options",
        default: "hex",
        options: [
          { name: "十六进制", value: "hex" },
          { name: "Base64", value: "base64" },
        ],
        displayOptions: { show: { operation: ["hash", "hmac"] } },
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "result",
        description: "把结果写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const operation = readString(context, "operation", "hash");
    const outputField = readString(context, "outputField", "result") || "result";
    const items = inputItems(context);
    const rawValue = readString(context, "value", "");
    const value = rawValue || JSON.stringify(items[0]?.json ?? {});

    let result: string;
    switch (operation) {
      case "hash": {
        const algorithm = readString(context, "algorithm", "SHA-256");
        const digest = await subtleCrypto().digest(algorithm, textToBytes(value));
        const bytes = new Uint8Array(digest);
        result = readString(context, "encoding", "hex") === "base64" ? toBase64(bytes) : toHex(bytes);
        break;
      }
      case "hmac": {
        const algorithm = readString(context, "algorithm", "SHA-256");
        const secret = readString(context, "secret", "");
        if (!secret) throw new Error("HMAC 需要一个密钥");
        const key = await subtleCrypto().importKey(
          "raw",
          textToBytes(secret),
          { name: "HMAC", hash: algorithm },
          false,
          ["sign"],
        );
        const signature = await subtleCrypto().sign("HMAC", key, textToBytes(value));
        const bytes = new Uint8Array(signature);
        result = readString(context, "encoding", "hex") === "base64" ? toBase64(bytes) : toHex(bytes);
        break;
      }
      case "base64Encode": {
        result = toBase64(textToBytes(value));
        break;
      }
      case "base64Decode": {
        result = bytesToText(fromBase64(value));
        break;
      }
      case "uuid":
      default: {
        const cryptoObj = globalThis.crypto;
        result = cryptoObj?.randomUUID ? cryptoObj.randomUUID() : "no-crypto";
        if (result === "no-crypto") throw new Error("当前环境没有可用的 UUID 生成器");
        break;
      }
    }

    return withField(items, outputField, result);
  },
};
