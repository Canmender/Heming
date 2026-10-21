import { describe, it, expect } from "vitest";
import { buildInstallPreview, sanitizeHeaders } from "./preview.js";
import type { RegistryEntry, RegistryHeaderSpec } from "./types.js";

const remoteEntry: RegistryEntry = {
  key: "io.github.example/mcp-demo",
  title: "Demo",
  description: "",
  status: "active",
  options: [],
  repoUrl: "https://github.com/example/mcp-demo",
  repoSource: "github",
  websiteUrl: "https://example.com",
  latestVersion: "1.2.3",
};

describe("buildInstallPreview", () => {
  it("包含来源、仓库、官网、传输与官方状态（确认卡不能少行）", () => {
    const preview = buildInstallPreview(remoteEntry, {
      kind: "http",
      label: "远程 · streamable-http",
      url: "https://mcp.example.com/mcp",
      headerHints: [{ name: "Authorization", isRequired: true, isSecret: true }],
    });
    const labels = preview.rows.map((r) => r.label);
    expect(labels).toEqual(["服务", "来源", "传输", "仓库", "官网", "官方状态", "最新版本"]);
    expect(preview.risk.level).toBe("low");
    expect(preview.headerHints).toHaveLength(1);
  });

  it("无官网/仓库时不生成空行", () => {
    const preview = buildInstallPreview(
      { ...remoteEntry, repoUrl: undefined, websiteUrl: undefined },
      { kind: "http", label: "远程", url: "https://mcp.example.com/mcp" },
    );
    expect(preview.rows.some((r) => r.label === "官网")).toBe(false);
    expect(preview.rows.some((r) => r.label === "仓库")).toBe(false);
  });

  it("★ 本地包要把要在本机执行的命令摊在确认卡上", () => {
    const preview = buildInstallPreview(remoteEntry, {
      kind: "stdio",
      label: "npm · pkg@1.2.3",
      command: "npx",
      args: ["-y", "pkg@1.2.3"],
      registryType: "npm",
      version: "1.2.3",
    });
    const rows = Object.fromEntries(preview.rows.map((r) => [r.label, r.value]));
    // 用户点「允许」批准的是这一句具体的话，不是抽象的「本地包」
    expect(rows["本机命令"]).toBe("npx -y pkg@1.2.3");
    expect(rows["运行时"]).toContain("Node.js（npx）");
    // 本地包等于把本机权限交给作者 → 等级不可能是 low
    expect(preview.risk.level).toBe("medium");
  });

  it("pypi 的运行时行说 uv，不是 Node", () => {
    const preview = buildInstallPreview(remoteEntry, {
      kind: "stdio",
      label: "pypi · fetch==0.6.2",
      command: "uvx",
      args: ["mcp-server-fetch==0.6.2"],
      registryType: "pypi",
      version: "0.6.2",
    });
    const runtime = preview.rows.find((r) => r.label === "运行时")?.value ?? "";
    expect(runtime).toContain("uv（uvx）");
    expect(runtime).not.toContain("Node");
  });

  it("远程装法不出现「本机命令」行（别让人以为本机要跑东西）", () => {
    const preview = buildInstallPreview(remoteEntry, { kind: "http", label: "远程", url: "https://a" });
    expect(preview.rows.some((r) => r.label === "本机命令")).toBe(false);
    expect(preview.rows.some((r) => r.label === "运行时")).toBe(false);
  });
});

describe("sanitizeHeaders", () => {
  const hints: RegistryHeaderSpec[] = [
    { name: "Authorization", isRequired: true, isSecret: true },
    { name: "X-Optional", isRequired: false },
  ];

  it("必填缺失 → 拒绝安装", () => {
    expect(sanitizeHeaders(hints, {}).error).toContain("必填");
  });

  it("只保留声明过的头，可选头空值不写入", () => {
    const out = sanitizeHeaders(hints, { Authorization: "Bearer t", "X-Other": "nope" });
    expect(out.error).toBeUndefined();
    expect(out.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("拒绝 CR/LF（头注入）", () => {
    expect(sanitizeHeaders(hints, { Authorization: "Bearer a\r\nX-Evil: 1" }).error).toContain("换行");
  });

  it("声明了非法/禁止的头名 → 拒绝整个安装", () => {
    for (const name of ["Bad Header", "Host", "Content-Length"]) {
      const out = sanitizeHeaders([{ name }], { [name]: "x" });
      expect(out.error).toBeTruthy();
    }
  });
});
