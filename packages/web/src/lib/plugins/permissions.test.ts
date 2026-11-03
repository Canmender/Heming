import { describe, it, expect } from "vitest";
import {
  evaluatePluginPermissions,
  hostOfUrl,
  pluginIdFromServerId,
  riskAllowed,
} from "./permissions.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";

const server = { key: "report", name: "报告服务", url: "https://api.acme.com/mcp" };

function manifest(overrides: Record<string, unknown> = {}): PluginManifest {
  return parsePluginManifest({
    schemaVersion: 3,
    id: "acme.report",
    name: "报告工具箱",
    version: "1.0.0",
    permissions: { network: ["api.acme.com"], tools: "read", files: [] },
    contributions: { mcpServers: [server] },
    ...overrides,
  });
}

describe("hostOfUrl", () => {
  it("取 host 并小写，默认端口被规范化掉", () => {
    expect(hostOfUrl("https://API.Acme.com/mcp")).toBe("api.acme.com");
    expect(hostOfUrl("https://api.acme.com:443/mcp")).toBe("api.acme.com");
  });

  it("非默认端口保留（不同端口是不同服务）", () => {
    expect(hostOfUrl("http://localhost:8787/mcp")).toBe("localhost:8787");
    expect(hostOfUrl("http://[::1]:8787/mcp")).toBe("[::1]:8787");
  });

  it("非法地址返回空串", () => {
    expect(hostOfUrl("不是地址")).toBe("");
    expect(hostOfUrl("")).toBe("");
  });
});

describe("pluginIdFromServerId", () => {
  it("解析 plugin:<插件 id>:<服务 key>", () => {
    expect(pluginIdFromServerId("plugin:acme.report:report")).toBe("acme.report");
    expect(pluginIdFromServerId("plugin:a:key:with-colon")).toBe("a");
  });

  it("非插件服务与非法格式返回 null", () => {
    for (const id of [
      "manual-server",
      "plugin:",
      "plugin::key",
      "plugin:Acme:key",
      "plugin:-bad:key",
      "plugin:acme/evil:key",
      "",
    ]) {
      expect(pluginIdFromServerId(id), id).toBeNull();
    }
  });
});

describe("riskAllowed", () => {
  it("none 不放行任何工具", () => {
    expect(riskAllowed("read", "none")).toBe(false);
    expect(riskAllowed("write", "none")).toBe(false);
  });

  it("read 只放行只读工具（只能收紧）", () => {
    expect(riskAllowed("read", "read")).toBe(true);
    expect(riskAllowed("write", "read")).toBe(false);
  });

  it("write 上限按 HITL 正常判定（不代表免确认）", () => {
    expect(riskAllowed("read", "write")).toBe(true);
    expect(riskAllowed("write", "write")).toBe(true);
  });
});

describe("evaluatePluginPermissions", () => {
  it("主机全覆盖时 accepted", () => {
    const report = evaluatePluginPermissions(manifest());
    expect(report).toEqual({
      network: ["api.acme.com"],
      files: [],
      tools: "read",
      hosts: ["api.acme.com"],
      undeclared: [],
      accepted: true,
    });
  });

  it("多个服务共用主机时 hosts 去重、保留声明顺序", () => {
    const parsed = manifest({
      permissions: { network: ["api.acme.com", "localhost:8787"], tools: "write" },
      contributions: {
        mcpServers: [
          { key: "a", name: "甲", url: "https://api.acme.com/a" },
          { key: "b", name: "乙", url: "https://api.acme.com/b" },
          { key: "c", name: "丙", url: "http://localhost:8787/c" },
        ],
      },
    });
    const report = evaluatePluginPermissions(parsed);
    expect(report.hosts).toEqual(["api.acme.com", "localhost:8787"]);
    expect(report.undeclared).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(report.tools).toBe("write");
  });

  it("运行时兜底：被手工改坏的清单能报出未声明主机", () => {
    // 解析期已拒绝这种清单；这里模拟「存储里被改过」的运行时兜底口径
    const parsed = manifest();
    const tampered: PluginManifest = {
      ...parsed,
      permissions: { ...parsed.permissions, network: [] },
    };
    const report = evaluatePluginPermissions(tampered);
    expect(report.undeclared).toEqual(["api.acme.com"]);
    expect(report.accepted).toBe(false);
  });

  it("旧版 v2 包归一化后视为已确认（不回溯拦截）", () => {
    const legacy = parsePluginManifest({
      schemaVersion: 2,
      id: "acme.legacy",
      name: "旧包",
      version: "1.0.0",
      skills: [{ name: "旧技能", instructions: "做点什么。" }],
      mcpServers: [server],
    });
    const report = evaluatePluginPermissions(legacy);
    expect(report.tools).toBe("read");
    expect(report.network).toEqual(["api.acme.com"]);
    expect(report.undeclared).toEqual([]);
    expect(report.accepted).toBe(true);
  });
});
