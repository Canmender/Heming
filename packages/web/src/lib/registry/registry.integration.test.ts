import { describe, it, expect } from "vitest";
import { McpRegistry } from "../mcp/store.js";
import type { StorageLike } from "../memory/types.js";
import { toServerConfig } from "./map.js";
import type { RegistryEntry } from "./types.js";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const entry: RegistryEntry = {
  key: "io.github.example/mcp-demo",
  title: "Demo",
  description: "",
  status: "active",
  options: [],
};

describe("Registry → MCP 注册表联动（T09）", () => {
  it("装出来的服务 origin=registry，且工具默认全部未启用", () => {
    const mcp = new McpRegistry(memStorage());
    const cfg = toServerConfig(entry, {
      kind: "http",
      label: "远程",
      url: "https://mcp.example.com/mcp",
    });
    mcp.add(cfg);

    const saved = mcp.servers().find((s) => s.id === cfg.id);
    expect(saved?.origin).toBe("registry");
    expect(saved?.registryName).toBe(entry.key);

    // 关键安全断言：连接并发现工具后，启用集合仍为空
    mcp.setTools(cfg.id, [
      { name: "write_file", description: "写文件" },
      { name: "read_file", description: "读文件" },
    ]);
    expect(mcp.enabledTools()).toHaveLength(0);
  });

  it("不污染内置预置：装 Registry 服务后三条预置仍在", () => {
    const mcp = new McpRegistry(memStorage());
    const before = mcp.servers().map((s) => s.id).sort();
    expect(before.length).toBeGreaterThan(0);

    mcp.add(toServerConfig(entry, { kind: "http", label: "远程", url: "https://mcp.example.com/mcp" }));

    const after = mcp.servers();
    for (const id of before) expect(after.some((s) => s.id === id)).toBe(true);
  });

  it("★ 手填配置缺省 origin=manual，且重启前后长得一样（与 Registry 装的分得开）", () => {
    const storage = memStorage();
    const mcp = new McpRegistry(storage);
    mcp.add({ name: "手填", transport: "http", url: "https://manual.example.com/mcp", enabled: true });
    const saved = mcp.servers().find((s) => s.name === "手填");
    expect(saved?.origin).toBe("manual");
    expect(saved?.registryName).toBeUndefined();
    // 内存里 undefined、读回 manual = 同一个服务重启前后不一致，界面上会自己变脸
    expect(new McpRegistry(storage).get(saved!.id)?.origin).toBe("manual");
  });
});
