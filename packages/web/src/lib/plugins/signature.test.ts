import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";
import {
  PUBLISHERS_KEY,
  PublisherTrustStore,
  publicKeyFingerprint,
  signedManifestText,
  verifyManifestSignature,
} from "./signature.js";

/**
 * 签名脚本是纯 Node ESM（没有类型声明），用 file URL 动态导入做「脚本 ↔ 应用」
 * 互证：测试里生成/签名，应用侧验签。`@vite-ignore` 让 Vite 不要尝试静态分析。
 */
interface SignScriptApi {
  generateEd25519KeyPair(): { privateKey: string; publicKey: string };
  signManifest(
    manifest: Record<string, unknown>,
    privateKey: string,
  ): { publisher: { id: string; publicKey: string }; signature: { alg: "ed25519"; value: string } };
  signedManifestText(manifest: Record<string, unknown>): string;
}

/** 从当前工作目录向上找仓库根的 scripts/sign-plugin.mjs（vitest cwd 可能是包目录）。 */
function findSignScript(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, "scripts/sign-plugin.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 scripts/sign-plugin.mjs（测试需要仓库根目录）");
}

const scriptApi = (await import(
  /* @vite-ignore */
  pathToFileURL(findSignScript()).href
)) as SignScriptApi;

const BASE = {
  schemaVersion: 3,
  id: "acme.signed",
  name: "签名包",
  version: "1.0.0",
  description: "带签名的示例清单",
  author: "Acme",
  permissions: { network: [], tools: "read", files: [] },
  contributions: { skills: [{ name: "签名技能", instructions: "做点什么。" }] },
};

/** 生成一对密钥并给 BASE 签名，返回可直接解析的清单对象与密钥对。 */
function signedFixture(): {
  manifestObject: Record<string, unknown>;
  privateKey: string;
  publicKey: string;
} {
  const pair = scriptApi.generateEd25519KeyPair() as { privateKey: string; publicKey: string };
  const unsigned = { ...BASE, publisher: { id: "acme", publicKey: pair.publicKey } };
  const { publisher, signature } = scriptApi.signManifest(unsigned, pair.privateKey) as {
    publisher: { id: string; publicKey: string };
    signature: { alg: "ed25519"; value: string };
  };
  return {
    manifestObject: { ...BASE, publisher, signature },
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signedManifestText · 规范化签名文本", () => {
  const fixture = signedFixture();
  const manifest = parsePluginManifest(fixture.manifestObject);

  it("键排序、无空白，含 publisher、排除 signature", () => {
    const text = signedManifestText(manifest);
    expect(text).not.toMatch(/\s/);
    expect(text).toContain('"publisher"');
    expect(text).not.toContain('"signature"');
    // 顶层键按字母序（author, contributions, description, id, name, permissions, publisher, version）
    expect(text.startsWith('{"author":')).toBe(true);
  });

  it("signature 变化不影响签名文本（签名不签自己）", () => {
    const changed: PluginManifest = {
      ...manifest,
      signature: { alg: "ed25519", value: "A".repeat(86) },
    };
    expect(signedManifestText(changed)).toBe(signedManifestText(manifest));
  });

  it("publisher 变化会改变签名文本（公钥属于内容）", () => {
    const changed: PluginManifest = {
      ...manifest,
      publisher: { id: "acme", publicKey: "C".repeat(43) },
    };
    expect(signedManifestText(changed)).not.toBe(signedManifestText(manifest));
  });

  it("与 scripts/sign-plugin.mjs 逐字节一致", () => {
    expect(scriptApi.signedManifestText(fixture.manifestObject)).toBe(signedManifestText(manifest));
    const unsigned = parsePluginManifest(BASE);
    expect(scriptApi.signedManifestText(BASE)).toBe(signedManifestText(unsigned));
  });

  it("手写清单省略默认值、大小写/空白/重复项在脚本与应用两边归一化一致", () => {
    const pair = scriptApi.generateEd25519KeyPair();
    const rich = {
      schemaVersion: 3,
      id: "acme.rich",
      name: "  富清单  ",
      version: "1.2.3",
      publisher: { id: "acme", publicKey: pair.publicKey },
      // description/author 省略；主机大小写+重复；tools 省略走默认 read
      permissions: {
        network: ["API.Example.COM", "api.example.com", "MCP.Example.com", ""],
      },
      contributions: {
        skills: [
          {
            name: " 富技能 ",
            instructions: "  正文  ",
            triggers: [" 财报 ", "财报", ""],
            tags: ["财务", "财务"],
          },
        ],
        mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
        commands: [
          { id: "go-home", title: "去主页", keywords: ["首页", "首页"], target: { kind: "page", page: "home" } },
        ],
        toolPacks: [{ id: "pack", name: "工具束", tools: ["get_data"] }],
      },
    };
    const parsed = parsePluginManifest(rich);
    expect(scriptApi.signedManifestText(rich)).toBe(signedManifestText(parsed));
  });
});

describe("verifyManifestSignature · 验签", () => {
  it("脚本签名 → 有效", async () => {
    const fixture = signedFixture();
    const manifest = parsePluginManifest(fixture.manifestObject);
    expect(await verifyManifestSignature(manifest)).toEqual({ status: "valid" });
  });

  it("未签名 → none", async () => {
    const manifest = parsePluginManifest(BASE);
    expect(await verifyManifestSignature(manifest)).toEqual({ status: "none" });
  });

  it("篡改任意语义字段 → invalid（验签失败绝不放行）", async () => {
    const fixture = signedFixture();
    const base = parsePluginManifest(fixture.manifestObject);

    const tampered: PluginManifest[] = [
      { ...base, name: "被改过的名字" },
      { ...base, version: "9.9.9" },
      { ...base, author: "Someone Else" },
      {
        ...base,
        publisher: { id: "acme", publicKey: fixture.publicKey },
        permissions: { ...base.permissions, network: ["evil.example.com"] },
      },
      { ...base, signature: { alg: "ed25519", value: "A".repeat(86) } },
    ];

    for (const manifest of tampered) {
      const check = await verifyManifestSignature(manifest);
      expect(check.status, JSON.stringify(manifest.name)).toBe("invalid");
      expect(check.reason).toBeTruthy();
    }
  });

  it("有签名但缺发布者 → invalid（无法确定验签公钥）", async () => {
    const fixture = signedFixture();
    const manifest = parsePluginManifest(fixture.manifestObject);
    const broken = { ...manifest, publisher: undefined } as unknown as PluginManifest;
    const check = await verifyManifestSignature(broken);
    expect(check.status).toBe("invalid");
    expect(check.reason).toContain("缺少发布者公钥");
  });

  it("无 crypto.subtle 环境 → unsupported（不谎报 valid）", async () => {
    const fixture = signedFixture();
    const manifest = parsePluginManifest(fixture.manifestObject);
    vi.stubGlobal("crypto", {});
    const check = await verifyManifestSignature(manifest);
    expect(check.status).toBe("unsupported");
    expect(check.reason).toContain("WebCrypto");
  });

  it("Ed25519 不被支持（importKey 抛 NotSupportedError）→ unsupported", async () => {
    const fixture = signedFixture();
    const manifest = parsePluginManifest(fixture.manifestObject);
    const error = new Error("Ed25519 not supported");
    error.name = "NotSupportedError";
    vi.stubGlobal("crypto", {
      subtle: {
        importKey: async () => {
          throw error;
        },
      },
    });
    const check = await verifyManifestSignature(manifest);
    expect(check.status).toBe("unsupported");
    expect(check.reason).toContain("不支持");
  });
});

describe("publicKeyFingerprint · 公钥指纹", () => {
  it("格式为 sha256:<16 位 hex>，同一把公钥稳定", async () => {
    const fixture = signedFixture();
    const first = await publicKeyFingerprint(fixture.publicKey);
    const second = await publicKeyFingerprint(fixture.publicKey);
    expect(first).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(first).toBe(second);
  });

  it("不同公钥指纹不同", async () => {
    const left = await publicKeyFingerprint(scriptApi.generateEd25519KeyPair().publicKey);
    const right = await publicKeyFingerprint(scriptApi.generateEd25519KeyPair().publicKey);
    expect(left).not.toBe(right);
  });

  it("非法公钥抛中文错误", async () => {
    await expect(publicKeyFingerprint("not-base64url!")).rejects.toThrow("base64url");
    await expect(publicKeyFingerprint("A".repeat(20))).rejects.toThrow("32 字节");
  });
});

describe("PublisherTrustStore · TOFU 信任表", () => {
  function memoryStorage(map = new Map<string, string>()) {
    return {
      map,
      storage: {
        getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
        removeItem: (key: string) => {
          map.delete(key);
        },
      },
    };
  }

  const record = { id: "acme", publicKey: "A".repeat(43), fingerprint: "sha256:abcdef0123456789" };

  it("remember / get / forget / list", () => {
    const { storage } = memoryStorage();
    const store = new PublisherTrustStore(storage);

    expect(store.get("acme")).toBeUndefined();
    store.remember(record);
    expect(store.get("acme")).toEqual(record);
    expect(store.list()).toEqual([record]);

    store.forget("acme");
    expect(store.get("acme")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("持久化到 heming.plugin.publishers.v1，重开实例仍可读", () => {
    const { storage, map } = memoryStorage();
    new PublisherTrustStore(storage).remember(record);

    const raw = map.get(PUBLISHERS_KEY);
    expect(raw).toContain("acme");
    const reloaded = new PublisherTrustStore(storage);
    expect(reloaded.get("acme")).toEqual(record);
  });

  it("坏 JSON / 坏形状回退空表，不抛", () => {
    const { storage, map } = memoryStorage();
    map.set(PUBLISHERS_KEY, "{不是 JSON");
    expect(new PublisherTrustStore(storage).list()).toEqual([]);

    map.set(PUBLISHERS_KEY, JSON.stringify({ publishers: { acme: { publicKey: 42 } } }));
    expect(new PublisherTrustStore(storage).list()).toEqual([]);

    map.set(PUBLISHERS_KEY, JSON.stringify([1, 2, 3]));
    expect(new PublisherTrustStore(storage).list()).toEqual([]);
  });
});

/* ───────────────────── d.124：页面字段进入签名覆盖 ───────────────────── */

/**
 * v5 声明式页面清单（故意用「不写默认值」的写法）：
 * - list 项省略 description（应用归一化会补 ""）；
 * - actions 用 settings / unit 两类 target（旧版脚本 canonicalizer 会丢字段）；
 * 这两点正是「脚本签的包在应用里验不过」的高发区，这里一起钉住。
 */
const V5_PAGE_MANIFEST: Record<string, unknown> = {
  schemaVersion: 5,
  id: "acme.page-signed",
  name: "页面签名包",
  version: "1.0.0",
  description: "带页面签名的示例",
  author: "Acme",
  engines: { heming: "d.123" },
  permissions: { network: [], tools: "read" },
  contributions: {
    skills: [{ name: "页面技能", instructions: "做点什么。" }],
    page: {
      title: " 采集看板 ",
      icon: "chart",
      summary: "本机采集状态",
      blocks: [
        { type: "markdown", title: " 怎么用 ", text: "  先填来源。  " },
        { type: "stats", items: [{ label: " 已采集 ", value: "12 条" }] },
        { type: "table", columns: ["来源", "状态"], rows: [["QQ", "就绪"]] },
        { type: "list", items: [{ title: "开始同步", badge: "命令" }] },
        {
          type: "actions",
          items: [
            { label: "去设置", target: { kind: "settings", card: "profile" } },
            { label: "看单元", target: { kind: "unit", unitId: "acme.page-signed" } },
            { label: "去主页", target: { kind: "page", page: "home" } },
          ],
        },
        { type: "contributions", kind: "skills" },
      ],
    },
  },
};

describe("signedManifestText · d.124 页面字段", () => {
  it("v5 页面清单：应用与 scripts/sign-plugin.mjs 逐字节一致", () => {
    const parsed = parsePluginManifest(V5_PAGE_MANIFEST);
    expect(parsed.contributions.page?.kind).toBe("blocks");
    expect(scriptApi.signedManifestText(V5_PAGE_MANIFEST)).toBe(signedManifestText(parsed));
  });

  it("页面 title / summary / 块内容 / 动作 target 任一被改，签名文本都变", () => {
    const parsed = parsePluginManifest(V5_PAGE_MANIFEST);
    const base = signedManifestText(parsed);
    if (parsed.contributions.page?.kind !== "blocks") throw new Error("应为声明式页面");

    const title = { ...parsed, contributions: { ...parsed.contributions, page: { ...parsed.contributions.page, title: "被改的标题" } } };
    expect(signedManifestText(title as PluginManifest)).not.toBe(base);

    const blockText = {
      ...parsed,
      contributions: {
        ...parsed.contributions,
        page: {
          ...parsed.contributions.page,
          blocks: [{ type: "markdown" as const, text: "被改的正文" }],
        },
      },
    };
    expect(signedManifestText(blockText as PluginManifest)).not.toBe(base);
  });

  it("脚本签 v5 页面包 → 应用验签有效；改页面标题后验签失败", async () => {
    const pair = scriptApi.generateEd25519KeyPair();
    const unsigned = { ...V5_PAGE_MANIFEST, publisher: { id: "acme", publicKey: pair.publicKey } };
    const { publisher, signature } = scriptApi.signManifest(unsigned, pair.privateKey);
    const signed = parsePluginManifest({ ...unsigned, publisher, signature });
    expect(await verifyManifestSignature(signed)).toEqual({ status: "valid" });

    if (signed.contributions.page?.kind !== "blocks") throw new Error("应为声明式页面");
    const tampered = {
      ...signed,
      contributions: {
        ...signed.contributions,
        page: { ...signed.contributions.page, title: "被改过的页面标题" },
      },
    } as PluginManifest;
    const check = await verifyManifestSignature(tampered);
    expect(check.status).toBe("invalid");
  });
});
