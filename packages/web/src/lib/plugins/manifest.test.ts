import { describe, it, expect } from "vitest";
import {
  MAX_PLUGIN_MCP_SERVERS,
  MAX_PLUGIN_SKILLS,
  PluginManifestError,
  parsePluginManifest,
} from "./index.js";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "acme.finance",
    name: "财务助手包",
    version: "1.0.0",
    skills: [
      {
        name: "财报速读",
        description: "提取关键变化",
        instructions: "先看收入，再看现金流。",
        triggers: ["财报", "年报"],
        tags: ["财务"],
      },
    ],
    ...overrides,
  };
}

describe("parsePluginManifest · 合法清单", () => {
  it("最小清单补齐默认值，未知字段被丢弃", () => {
    const parsed = parsePluginManifest({
      schemaVersion: 1,
      id: "acme.demo",
      name: "演示包",
      version: "0.1.0",
      skills: [{ name: "演示技能", instructions: "做点什么。" }],
      extra: "不该保留",
    });

    expect(parsed.description).toBe("");
    expect(parsed.author).toBe("");
    expect(parsed.skills[0].description).toBe("");
    expect(parsed.skills[0].triggers).toEqual([]);
    expect(parsed.skills[0].tags).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect("extra" in parsed).toBe(false);
  });

  it("接受 JSON 文本，并 trim / 去重触发词与标签", () => {
    const text = JSON.stringify(
      manifest({
        name: "  财务助手包  ",
        skills: [
          {
            name: "  财报速读 ",
            instructions: "  正文  ",
            triggers: [" 财报 ", "财报", ""],
            tags: ["财务", "财务", "  "],
          },
        ],
      }),
    );
    const parsed = parsePluginManifest(text);
    expect(parsed.name).toBe("财务助手包");
    expect(parsed.skills[0].name).toBe("财报速读");
    expect(parsed.skills[0].instructions).toBe("正文");
    expect(parsed.skills[0].triggers).toEqual(["财报"]);
    expect(parsed.skills[0].tags).toEqual(["财务"]);
  });
});

describe("parsePluginManifest · 拒绝非法清单", () => {
  function failure(input: unknown): string {
    try {
      parsePluginManifest(input);
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      return (err as Error).message;
    }
    throw new Error("应当解析失败");
  }

  it("空文本与非 JSON 文本", () => {
    expect(failure("   ")).toContain("插件清单为空");
    expect(failure("{ 不是 JSON")).toContain("不是有效的 JSON");
  });

  it("清单或技能不是对象", () => {
    expect(failure([])).toContain("插件清单必须是 JSON 对象");
    expect(failure(manifest({ skills: ["x"] }))).toContain("技能必须是 JSON 对象");
  });

  it("schemaVersion 必须为 1 或 2", () => {
    expect(failure(manifest({ schemaVersion: 3 }))).toContain("仅支持 schemaVersion: 1 或 2");
    expect(failure({ ...manifest(), schemaVersion: undefined })).toContain("schemaVersion");
    expect(parsePluginManifest(manifest({ schemaVersion: 2 })).schemaVersion).toBe(2);
  });

  it("插件 id 只允许小写字母、数字、点、下划线与连字符", () => {
    for (const id of ["Acme", "-acme", "acme/evil", "a".repeat(65)]) {
      expect(failure(manifest({ id })), id).toContain("插件 id");
    }
  });

  it("缺少必填字段与空技能列表", () => {
    expect(failure({ ...manifest(), version: undefined })).toContain("版本号");
    expect(failure(manifest({ skills: [] }))).toContain("至少要包含 1 个技能");
    expect(failure(manifest({ skills: [{ name: "只有名字" }] }))).toContain(
      "skills[0].instructions",
    );
  });

  it("同一插件内技能重名", () => {
    const message = failure(
      manifest({
        skills: [
          { name: "同名", instructions: "a" },
          { name: "同名", instructions: "b" },
        ],
      }),
    );
    expect(message).toContain("skills[1].name");
    expect(message).toContain("技能名重复：同名");
  });

  it("字段超长与技能数量超限", () => {
    expect(
      failure(
        manifest({
          skills: [{ name: "超长", instructions: "x".repeat(8001) }],
        }),
      ),
    ).toContain("技能指令最多 8000 字");

    const many = Array.from({ length: MAX_PLUGIN_SKILLS + 1 }, (_, i) => ({
      name: `技能${i}`,
      instructions: "x",
    }));
    expect(failure(manifest({ skills: many }))).toContain(
      `单个插件最多 ${MAX_PLUGIN_SKILLS} 个技能`,
    );
  });
});

describe("parsePluginManifest · v2 系统能力包", () => {
  const weather = { key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" };

  function failure(input: unknown): string {
    try {
      parsePluginManifest(input);
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      return (err as Error).message;
    }
    throw new Error("应当解析失败");
  }

  it("纯 MCP 包可以没有技能", () => {
    const parsed = parsePluginManifest(
      manifest({ schemaVersion: 2, skills: [], mcpServers: [weather] }),
    );
    expect(parsed.skills).toEqual([]);
    expect(parsed.mcpServers).toEqual([{ ...weather, description: "" }]);
  });

  it("混合包保留技能与服务，字段 trim", () => {
    const parsed = parsePluginManifest(
      manifest({
        schemaVersion: 2,
        mcpServers: [{ ...weather, name: "  天气服务  ", description: " 查询天气 " }],
      }),
    );
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.mcpServers[0]).toMatchObject({
      key: "weather",
      name: "天气服务",
      description: "查询天气",
    });
  });

  it("v1 声明 MCP 服务必须升级 schemaVersion", () => {
    expect(failure(manifest({ mcpServers: [weather] }))).toContain(
      "schemaVersion 1 不支持 MCP 服务",
    );
  });

  it("v2 也至少要有一项能力", () => {
    expect(failure(manifest({ schemaVersion: 2, skills: [], mcpServers: [] }))).toContain(
      "至少要包含 1 项能力",
    );
  });

  it("服务地址只接受 https 或本机 http，且不能带账号密码", () => {
    const ok = [
      "https://mcp.example.com/mcp",
      "http://localhost:8787/mcp",
      "http://127.0.0.1:8787/mcp",
      "http://[::1]:8787/mcp",
    ];
    for (const url of ok) {
      const parsed = parsePluginManifest(
        manifest({ schemaVersion: 2, skills: [], mcpServers: [{ ...weather, url }] }),
      );
      expect(parsed.mcpServers[0].url).toBe(url);
    }

    expect(
      failure(
        manifest({ schemaVersion: 2, mcpServers: [{ ...weather, url: "http://example.com/mcp" }] }),
      ),
    ).toContain("远程 MCP 必须使用 https");
    expect(
      failure(
        manifest({ schemaVersion: 2, mcpServers: [{ ...weather, url: "ftp://example.com/mcp" }] }),
      ),
    ).toContain("远程 MCP 必须使用 https");
    expect(
      failure(
        manifest({
          schemaVersion: 2,
          mcpServers: [{ ...weather, url: "https://user:pass@example.com/mcp" }],
        }),
      ),
    ).toContain("不能包含用户名或密码");
    expect(
      failure(manifest({ schemaVersion: 2, mcpServers: [{ ...weather, url: "不是地址" }] })),
    ).toContain("不是合法的 URL");
  });

  it("服务 key 格式与插件内唯一", () => {
    for (const key of ["Weather", "-w", "a".repeat(33)]) {
      expect(
        failure(manifest({ schemaVersion: 2, mcpServers: [{ ...weather, key }] })),
      ).toContain("服务 key");
    }
    expect(
      failure(
        manifest({
          schemaVersion: 2,
          mcpServers: [weather, { ...weather, name: "第二个" }],
        }),
      ),
    ).toContain("服务 key 重复：weather");
  });

  it("服务不是对象、名称超长与数量超限", () => {
    expect(
      failure(manifest({ schemaVersion: 2, mcpServers: ["天气"] })),
    ).toContain("MCP 服务必须是 JSON 对象");
    expect(
      failure(
        manifest({ schemaVersion: 2, mcpServers: [{ ...weather, name: "x".repeat(65) }] }),
      ),
    ).toContain("服务名最多 64 字");

    const many = Array.from({ length: MAX_PLUGIN_MCP_SERVERS + 1 }, (_, i) => ({
      ...weather,
      key: `s${i}`,
    }));
    expect(failure(manifest({ schemaVersion: 2, mcpServers: many }))).toContain(
      `单个插件最多 ${MAX_PLUGIN_MCP_SERVERS} 台 MCP 服务`,
    );
  });
});
