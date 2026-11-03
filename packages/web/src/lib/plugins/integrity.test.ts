import { describe, it, expect } from "vitest";
import { canonicalManifestText, contentFingerprint } from "./integrity.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";

const base = {
  schemaVersion: 3,
  id: "acme.finance",
  name: "财务助手包",
  version: "1.0.0",
  description: "周报与大屏数据源",
  author: "ACME",
  permissions: { network: ["mcp.example.com"], tools: "read", files: ["reports"] },
  contributions: {
    skills: [{ name: "财报速读", instructions: "先看收入。" }],
    mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
    commands: [{ id: "open-home", title: "打开主页", target: { kind: "page", page: "home" } }],
    toolPacks: [{ id: "report-tools", name: "报告工具", tools: ["report_query"] }],
  },
};

function manifest(overrides: Record<string, unknown> = {}): PluginManifest {
  return parsePluginManifest({ ...base, ...overrides });
}

/** 换一种键插入顺序构造同一份清单（模拟粘贴排版/序列化顺序不同）。 */
function reordered(parsed: PluginManifest): PluginManifest {
  return {
    ...parsed,
    permissions: {
      files: parsed.permissions.files,
      tools: parsed.permissions.tools,
      network: parsed.permissions.network,
    },
    contributions: {
      toolPacks: parsed.contributions.toolPacks,
      commands: parsed.contributions.commands,
      mcpServers: parsed.contributions.mcpServers,
      skills: parsed.contributions.skills,
    },
  } as PluginManifest;
}

describe("canonicalManifestText · 规范化", () => {
  it("键排序、无空白，输出是合法 JSON 且只含语义字段", () => {
    const text = canonicalManifestText(manifest());

    expect(text).not.toMatch(/\s/);
    expect(JSON.parse(text)).toMatchObject({ id: "acme.finance", version: "1.0.0" });
    // 语义字段（按字母序）
    expect(text.startsWith('{"author":')).toBe(true);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      "author",
      "contributions",
      "description",
      "id",
      "name",
      "permissions",
      "version",
    ]);
  });

  it("对象键顺序不同 → 规范化文本相同", () => {
    const left = canonicalManifestText(manifest());
    const right = canonicalManifestText(reordered(manifest()));
    expect(right).toBe(left);
  });

  it("运行时字段不参与规范化", () => {
    const parsed = manifest();
    const withRuntime = {
      ...parsed,
      installedAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      fingerprint: "fnv1a64b:0000000000000000",
      enabled: false,
      skillIds: ["s1"],
    } as PluginManifest;
    expect(canonicalManifestText(withRuntime)).toBe(canonicalManifestText(parsed));
  });
});

describe("contentFingerprint · 稳定性与敏感性", () => {
  it("格式为 fnv1a64b:<16 位小写 hex>", () => {
    expect(contentFingerprint(manifest())).toMatch(/^fnv1a64b:[0-9a-f]{16}$/);
  });

  it("同内容同指纹（与键顺序无关）", () => {
    const left = contentFingerprint(manifest());
    expect(contentFingerprint(manifest())).toBe(left);
    expect(contentFingerprint(reordered(manifest()))).toBe(left);
  });

  it("任一语义字段变化都会改变指纹", () => {
    const original = contentFingerprint(manifest());
    const variants: [string, PluginManifest][] = [
      ["id", manifest({ id: "acme.other" })],
      ["version", manifest({ version: "1.0.1" })],
      ["name", manifest({ name: "财务助手包 2" })],
      ["description", manifest({ description: "改过的描述" })],
      ["author", manifest({ author: "Other" })],
      [
        "skills",
        manifest({
          contributions: {
            ...base.contributions,
            skills: [{ name: "财报速读", instructions: "先看现金流。" }],
          },
        }),
      ],
      [
        "permissions.network",
        manifest({ permissions: { ...base.permissions, network: ["mcp.example.com", "api.acme.com"] } }),
      ],
      [
        "permissions.tools",
        manifest({ permissions: { ...base.permissions, tools: "write" } }),
      ],
      [
        "toolPacks",
        manifest({
          contributions: {
            ...base.contributions,
            toolPacks: [{ id: "report-tools", name: "报告工具", tools: ["report_export"] }],
          },
        }),
      ],
    ];

    const seen = new Set<string>([original]);
    for (const [field, variant] of variants) {
      const fingerprint = contentFingerprint(variant);
      expect(fingerprint, field).not.toBe(original);
      expect(seen.has(fingerprint), `${field} 与其他字段撞指纹`).toBe(false);
      seen.add(fingerprint);
    }
  });

  it("规范化文本长度参与混合：截断内容不会与原文同指纹", () => {
    const long = manifest({
      contributions: {
        ...base.contributions,
        skills: [{ name: "财报速读", instructions: "先看收入。".repeat(10) }],
      },
    });
    expect(contentFingerprint(long)).not.toBe(contentFingerprint(manifest()));
  });

  it("同长度、只改靠前字段：前后两半都要变（d.64.2.23.0 偶数质数回归）", () => {
    // 回归用例：d.64.2.23.0 首版第二轮质数是偶数，导致后 8 位只与文本末尾有关。
    // 这里只改 author 的最后一个字符（长度不变、位置靠前），前后两半都必须变化。
    const a = contentFingerprint(manifest({ author: "ACME" }));
    const b = contentFingerprint(manifest({ author: "ACMF" }));
    const half = (fp: string) => fp.replace(/^fnv1a64b:/, "").length / 2;
    const headA = a.slice(9, 9 + half(a));
    const headB = b.slice(9, 9 + half(b));
    const tailA = a.slice(9 + half(a));
    const tailB = b.slice(9 + half(b));
    expect(headA).not.toBe(headB);
    expect(tailA).not.toBe(tailB);
  });
});
