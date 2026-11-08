import { describe, expect, it, vi } from "vitest";
import type { PluginCatalogEntry } from "@heming/shared";
import {
  PluginCatalogError,
  cryptoSha256Hex,
  downloadPluginManifest,
  fetchPluginCatalog,
  toHex,
} from "./catalogClient.js";

/**
 * 云端插件目录客户端（d.86）：拉目录、下载原文、**校验指纹**。
 *
 * 指纹校验是这条链上唯一的信任锚点，因此每个失败分支都要有用例：
 * 不校验/校验不了都不能继续装。
 */

const entry: PluginCatalogEntry = {
  id: "heming.magpie-gateway",
  name: "magpie 网关",
  version: "0.1.0",
  schemaVersion: 4,
  description: "本机网关",
  author: "和鸣",
  publishedAt: "2026-11-07T12:00:00.000Z",
  sha256: "a".repeat(64),
  size: 12,
  distribution: "manifest",
  permissions: { network: ["127.0.0.1:3425"], tools: "none", files: [] },
  contributions: { skills: 1, mcpServers: 0, commands: 1, toolPacks: 0, desktopWidgets: 0 },
};

const response = {
  plugins: [entry],
  generatedAt: "2026-11-07T12:00:00.000Z",
};

describe("fetchPluginCatalog", () => {
  it("成功时返回目录条目", async () => {
    const entries = await fetchPluginCatalog({ apiImpl: async () => response });
    expect(entries).toEqual([entry]);
  });

  it("服务端返回坏形状：报「格式不对」而不是把脏数据塞给 UI", async () => {
    await expect(
      fetchPluginCatalog({ apiImpl: async () => ({ plugins: [{ id: "Bad ID" }] }) }),
    ).rejects.toThrow(/云端插件目录不可用：返回的数据格式不对/);
  });

  it("网络/HTTP 失败：统一前缀 + 原始原因", async () => {
    await expect(
      fetchPluginCatalog({
        apiImpl: async () => {
          throw new Error("http 502");
        },
      }),
    ).rejects.toThrow(/云端插件目录不可用：http 502/);
  });
});

describe("downloadPluginManifest", () => {
  const bytes = new TextEncoder().encode('{"schemaVersion":4}');
  const hex = toHex(bytes);

  function responseWith(body: Uint8Array, headers: Record<string, string> = {}) {
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("校验通过后返回原文（指纹取响应头）", async () => {
    const text = await downloadPluginManifest(entry, {
      fetchImpl: async () => responseWith(bytes, { "x-plugin-sha256": hex }),
      sha256Hex: async () => hex,
    });
    expect(text).toBe('{"schemaVersion":4}');
  });

  it("响应头缺失时回退目录里的 sha256", async () => {
    const fallback = { ...entry, sha256: hex };
    await expect(
      downloadPluginManifest(fallback, {
        fetchImpl: async () => responseWith(bytes),
        sha256Hex: async () => hex,
      }),
    ).resolves.toContain("schemaVersion");
  });

  it("指纹不一致：拒绝且不返回内容", async () => {
    const promise = downloadPluginManifest(entry, {
      fetchImpl: async () => responseWith(bytes, { "x-plugin-sha256": hex }),
      sha256Hex: async () => "b".repeat(64),
    });
    await expect(promise).rejects.toBeInstanceOf(PluginCatalogError);
    await expect(promise).rejects.toThrow(/内容指纹不一致/);
  });

  it("HTTP 非 2xx / 网络异常：给可读错误", async () => {
    await expect(
      downloadPluginManifest(entry, {
        fetchImpl: async () => new Response("nope", { status: 503 }),
        sha256Hex: async () => hex,
      }),
    ).rejects.toThrow(/下载失败：HTTP 503/);

    await expect(
      downloadPluginManifest(entry, {
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toThrow(/下载失败：network down/);
  });
});

describe("cryptoSha256Hex", () => {
  it("正常环境算出的值与已知向量一致", async () => {
    // "abc" 的 SHA-256
    const digest = await cryptoSha256Hex(new TextEncoder().encode("abc"));
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("没有 subtle（非安全上下文）时明确拒绝，绝不跳过校验", async () => {
    // jsdom 的 crypto 是 getter-only，用 vi.stubGlobal 临时替换（结束统一还原）。
    vi.stubGlobal("crypto", {});
    try {
      await expect(cryptoSha256Hex(new Uint8Array([1]))).rejects.toThrow(
        /无法校验插件指纹/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("toHex", () => {
  it("小写两位补零", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});
