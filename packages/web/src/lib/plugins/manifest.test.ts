import { describe, it, expect } from "vitest";
import {
  MAX_PLUGIN_COMMANDS,
  MAX_PLUGIN_MCP_SERVERS,
  MAX_PLUGIN_PERMISSION_HOSTS,
  MAX_PLUGIN_SKILLS,
  MAX_PLUGIN_TOOL_PACKS,
  MAX_TOOL_PACK_TOOLS,
  PluginManifestError,
  parsePluginManifest,
} from "./index.js";

/** v3 完整清单元数据（不 build 完整清单，按用例补 contributions/permissions）。 */
function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    id: "acme.finance",
    name: "财务助手包",
    version: "1.0.0",
    ...overrides,
  };
}

const skill = { name: "财报速读", instructions: "先看收入，再看现金流。" };
const server = { key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" };

/** v3 合法清单：技能 + MCP + 命令，权限覆盖服务主机。 */
function full(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return meta({
    description: "周报与大屏数据源",
    author: "ACME",
    permissions: { network: ["mcp.example.com"], tools: "read", files: [] },
    contributions: {
      skills: [skill],
      mcpServers: [server],
      commands: [
        {
          id: "weekly-report",
          title: "生成周报",
          keywords: ["周报"],
          target: { kind: "skill", name: "财报速读" },
        },
      ],
    },
    ...overrides,
  });
}

/** 旧版（v1/v2）清单：顶层 skills / mcpServers。 */
function legacy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "acme.legacy",
    name: "旧版能力包",
    version: "1.0.0",
    skills: [skill],
    ...overrides,
  };
}

function failure(input: unknown): string {
  try {
    parsePluginManifest(input);
  } catch (err) {
    expect(err).toBeInstanceOf(PluginManifestError);
    return (err as Error).message;
  }
  throw new Error("应当解析失败");
}

describe("parsePluginManifest · v3 合法清单", () => {
  it("三类贡献面与权限归一化完整", () => {
    const parsed = parsePluginManifest(full());

    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.contributions.skills).toHaveLength(1);
    expect(parsed.contributions.mcpServers).toHaveLength(1);
    expect(parsed.contributions.commands[0]).toMatchObject({
      id: "weekly-report",
      title: "生成周报",
      description: "",
      keywords: ["周报"],
      target: { kind: "skill", name: "财报速读" },
    });
    expect(parsed.permissions).toEqual({
      network: ["mcp.example.com"],
      tools: "read",
      files: [],
    });
  });

  it("接受 JSON 文本，字段 trim / 去重，未知字段被丢弃", () => {
    const text = JSON.stringify(
      full({
        name: "  财务助手包  ",
        extra: "不该保留",
        permissions: {
          network: ["  API.Example.COM  ", "api.example.com", ""],
          tools: "write",
          files: ["reports", "reports", ""],
        },
        contributions: {
          skills: [
            {
              name: "  财报速读 ",
              instructions: "  正文  ",
              triggers: [" 财报 ", "财报", ""],
              tags: ["财务", "财务", "  "],
            },
          ],
          mcpServers: [],
          commands: [],
        },
      }),
    );
    const parsed = parsePluginManifest(text);

    expect(parsed.name).toBe("财务助手包");
    expect(parsed.contributions.skills[0].name).toBe("财报速读");
    expect(parsed.contributions.skills[0].instructions).toBe("正文");
    expect(parsed.contributions.skills[0].triggers).toEqual(["财报"]);
    expect(parsed.contributions.skills[0].tags).toEqual(["财务"]);
    expect(parsed.permissions.network).toEqual(["api.example.com"]);
    expect(parsed.permissions.files).toEqual(["reports"]);
    expect(parsed.permissions.tools).toBe("write");
    expect("extra" in parsed).toBe(false);
  });

  it("无 MCP 服务时可省略整个 permissions（补缺省值）", () => {
    const parsed = parsePluginManifest(
      meta({
        contributions: { skills: [skill], commands: [] },
      }),
    );

    expect(parsed.permissions).toEqual({ network: [], tools: "read", files: [] });
    expect(parsed.contributions.mcpServers).toEqual([]);
  });

  it("只有命令也算一项能力", () => {
    const parsed = parsePluginManifest(
      meta({
        contributions: {
          commands: [{ id: "open-home", title: "打开主页", target: { kind: "page", page: "home" } }],
        },
      }),
    );
    expect(parsed.contributions.commands[0].target).toEqual({ kind: "page", page: "home" });
    expect(parsed.contributions.skills).toEqual([]);
  });

  it("permissions.network 覆盖带端口的本机服务", () => {
    const parsed = parsePluginManifest(
      meta({
        permissions: { network: ["localhost:8787"] },
        contributions: {
          mcpServers: [{ key: "local", name: "本地服务", url: "http://localhost:8787/mcp" }],
        },
      }),
    );
    expect(parsed.permissions.network).toEqual(["localhost:8787"]);
  });
});

describe("parsePluginManifest · v3 拒绝非法清单", () => {
  it("缺少 contributions", () => {
    expect(failure(meta())).toContain("schemaVersion 3 必须声明 contributions");
  });

  it("contributions 三类都为空", () => {
    expect(failure(meta({ contributions: { skills: [], mcpServers: [], commands: [] } }))).toContain(
      "至少要包含 1 项能力",
    );
  });

  it("顶层 skills / mcpServers 给出迁移提示", () => {
    expect(failure(meta({ skills: [skill] }))).toContain("请迁移到 contributions.skills");
    expect(failure(meta({ mcpServers: [server] }))).toContain(
      "请迁移到 contributions.mcpServers",
    );
  });

  it("MCP 服务主机未被 permissions.network 覆盖时拒绝，并指明缺失主机", () => {
    const message = failure(
      meta({
        permissions: { network: ["other.example.com"] },
        contributions: { mcpServers: [server] },
      }),
    );
    expect(message).toContain("未声明 MCP 服务主机：mcp.example.com");
    expect(message).toContain("contributions.mcpServers[0].url");

    // 完全省略 permissions 也要拒绝（有服务就必须声明主机）
    expect(failure(meta({ contributions: { mcpServers: [server] } }))).toContain(
      "未声明 MCP 服务主机：mcp.example.com",
    );
  });

  it("主机覆盖按 host（含端口）精确匹配", () => {
    const remote = { key: "report", name: "报告服务", url: "https://api.acme.com/mcp" };
    // 只声明主机名、不声明实际 https 默认端口 → 覆盖成功
    expect(
      parsePluginManifest(
        meta({
          permissions: { network: ["api.acme.com"] },
          contributions: { mcpServers: [remote] },
        }),
      ).permissions.network,
    ).toEqual(["api.acme.com"]);

    // 端口不同不是同一台服务
    expect(
      failure(
        meta({
          permissions: { network: ["api.acme.com:8443"] },
          contributions: {
            mcpServers: [{ key: "local", name: "本地", url: "http://localhost:8787/mcp" }],
          },
        }),
      ),
    ).toContain("未声明 MCP 服务主机：localhost:8787");
  });

  it("permissions.tools 只接受 none / read / write", () => {
    expect(
      failure(
        meta({
          permissions: { network: [], tools: "danger" },
          contributions: { skills: [skill] },
        }),
      ),
    ).toContain('permissions.tools 只能是 "none" / "read" / "write"');
  });

  it("命令 id 重复 / 未知页面 / 目标技能不存在", () => {
    expect(
      failure(
        meta({
          contributions: {
            commands: [
              { id: "same", title: "一", target: { kind: "plugin" } },
              { id: "same", title: "二", target: { kind: "plugin" } },
            ],
          },
        }),
      ),
    ).toContain("命令 id 重复：same");

    expect(
      failure(
        meta({
          contributions: {
            commands: [{ id: "go", title: "去", target: { kind: "page", page: "not-a-page" } }],
          },
        }),
      ),
    ).toContain("未知页面：not-a-page");

    expect(
      failure(
        meta({
          contributions: {
            skills: [skill],
            commands: [{ id: "use", title: "用", target: { kind: "skill", name: "不存在的技能" } }],
          },
        }),
      ),
    ).toContain("command 目标技能不存在于本插件：不存在的技能");
  });

  it("命令 id 格式与数量上限", () => {
    for (const id of ["Weekly", "-weekly", "weekly report"]) {
      expect(
        failure(
          meta({ contributions: { commands: [{ id, title: "标题", target: { kind: "plugin" } }] } }),
        ),
      ).toContain("命令 id");
    }

    const many = Array.from({ length: MAX_PLUGIN_COMMANDS + 1 }, (_, i) => ({
      id: `cmd-${i}`,
      title: `命令${i}`,
      target: { kind: "plugin" },
    }));
    expect(failure(meta({ contributions: { commands: many } }))).toContain(
      `单个插件最多 ${MAX_PLUGIN_COMMANDS} 个命令`,
    );
  });

  it("网络主机数量上限与格式校验", () => {
    const many = Array.from({ length: MAX_PLUGIN_PERMISSION_HOSTS + 1 }, (_, i) => `h${i}.example.com`);
    expect(
      failure(
        meta({
          permissions: { network: many },
          contributions: { skills: [skill] },
        }),
      ),
    ).toContain(`网络主机最多 ${MAX_PLUGIN_PERMISSION_HOSTS} 个`);

    expect(
      failure(
        meta({
          permissions: { network: ["https://api.example.com/mcp"] },
          contributions: { skills: [skill] },
        }),
      ),
    ).toContain("网络主机只能写 host 或 host:port");
  });
});

describe("parsePluginManifest · v1 / v2 归一化", () => {
  it("v1 最小清单归一化为 v3 结构", () => {
    const parsed = parsePluginManifest({
      schemaVersion: 1,
      id: "acme.demo",
      name: "演示包",
      version: "0.1.0",
      skills: [{ name: "演示技能", instructions: "做点什么。" }],
      extra: "不该保留",
    });

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.description).toBe("");
    expect(parsed.author).toBe("");
    expect(parsed.contributions.skills[0]).toMatchObject({
      name: "演示技能",
      description: "",
      triggers: [],
      tags: [],
    });
    expect(parsed.contributions.mcpServers).toEqual([]);
    expect(parsed.contributions.commands).toEqual([]);
    expect(parsed.permissions).toEqual({ network: [], tools: "read", files: [] });
    expect("extra" in parsed).toBe(false);
  });

  it("v2 纯 MCP 包可以没有技能，权限按服务 host 补全", () => {
    const parsed = parsePluginManifest(
      legacy({ schemaVersion: 2, skills: [], mcpServers: [server] }),
    );

    expect(parsed.contributions.skills).toEqual([]);
    expect(parsed.contributions.mcpServers).toEqual([{ ...server, description: "" }]);
    expect(parsed.contributions.commands).toEqual([]);
    expect(parsed.permissions).toEqual({ network: ["mcp.example.com"], tools: "read", files: [] });
  });

  it("v2 混合包保留技能与服务，network 去重", () => {
    const parsed = parsePluginManifest(
      legacy({
        schemaVersion: 2,
        mcpServers: [
          { ...server, name: "  天气服务  ", description: " 查询天气 " },
          { key: "weather2", name: "天气二号", url: "https://mcp.example.com/other" },
        ],
      }),
    );

    expect(parsed.contributions.skills).toHaveLength(1);
    expect(parsed.contributions.mcpServers[0]).toMatchObject({
      key: "weather",
      name: "天气服务",
      description: "查询天气",
    });
    expect(parsed.permissions.network).toEqual(["mcp.example.com"]);
    expect(parsed.permissions.tools).toBe("read");
  });

  it("旧版声明 contributions / permissions 时提示升级", () => {
    expect(failure(legacy({ contributions: { skills: [skill] } }))).toContain(
      "请使用顶层 skills / mcpServers",
    );
    expect(failure(legacy({ permissions: { network: [] } }))).toContain(
      "不支持权限声明，请升级到 schemaVersion 3",
    );
  });

  it("v1 声明 MCP 服务必须升级 schemaVersion", () => {
    expect(failure(legacy({ schemaVersion: 1, mcpServers: [server] }))).toContain(
      "schemaVersion 1 不支持 MCP 服务",
    );
  });

  it("v2 也至少要有一项能力", () => {
    expect(
      failure(legacy({ schemaVersion: 2, skills: [], mcpServers: [] })),
    ).toContain("至少要包含 1 项能力");
  });
});

describe("parsePluginManifest · 通用校验（v1/v2/v3 共用）", () => {
  it("空文本与非 JSON 文本", () => {
    expect(failure("   ")).toContain("插件清单为空");
    expect(failure("{ 不是 JSON")).toContain("不是有效的 JSON");
  });

  it("清单或技能不是对象", () => {
    expect(failure([])).toContain("插件清单必须是 JSON 对象");
    expect(
      failure(meta({ contributions: { skills: ["x"] } })),
    ).toContain("技能必须是 JSON 对象");
  });

  it("schemaVersion 必须为 1 / 2 / 3", () => {
    expect(failure(meta({ schemaVersion: 4 }))).toContain("仅支持 schemaVersion: 1 / 2 / 3");
    expect(failure({ ...meta(), schemaVersion: undefined })).toContain("schemaVersion");
  });

  it("插件 id 只允许小写字母、数字、点、下划线与连字符", () => {
    for (const id of ["Acme", "-acme", "acme/evil", "a".repeat(65)]) {
      expect(failure(meta({ id })), id).toContain("插件 id");
    }
  });

  it("缺少必填字段与空技能列表", () => {
    expect(failure({ ...meta(), version: undefined })).toContain("版本号");
    expect(failure(legacy({ schemaVersion: 1, skills: [] }))).toContain("至少要包含 1 个技能");
    expect(
      failure(meta({ contributions: { skills: [{ name: "只有名字" }] } })),
    ).toContain("contributions.skills[0].instructions");
  });

  it("同一插件内技能重名（v3 路径带 contributions）", () => {
    const message = failure(
      meta({
        contributions: {
          skills: [
            { name: "同名", instructions: "a" },
            { name: "同名", instructions: "b" },
          ],
        },
      }),
    );
    expect(message).toContain("contributions.skills[1].name");
    expect(message).toContain("技能名重复：同名");
  });

  it("字段超长与技能数量超限", () => {
    expect(
      failure(
        meta({ contributions: { skills: [{ name: "超长", instructions: "x".repeat(8001) }] } }),
      ),
    ).toContain("技能指令最多 8000 字");

    const many = Array.from({ length: MAX_PLUGIN_SKILLS + 1 }, (_, i) => ({
      name: `技能${i}`,
      instructions: "x",
    }));
    expect(failure(meta({ contributions: { skills: many } }))).toContain(
      `单个插件最多 ${MAX_PLUGIN_SKILLS} 个技能`,
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
      const host = new URL(url).host;
      const parsed = parsePluginManifest(
        meta({
          permissions: { network: [host] },
          contributions: { mcpServers: [{ ...server, url }] },
        }),
      );
      expect(parsed.contributions.mcpServers[0].url).toBe(url);
    }

    expect(
      failure(
        meta({
          permissions: { network: ["example.com"] },
          contributions: { mcpServers: [{ ...server, url: "http://example.com/mcp" }] },
        }),
      ),
    ).toContain("远程 MCP 必须使用 https");
    expect(
      failure(
        meta({
          permissions: { network: ["example.com"] },
          contributions: { mcpServers: [{ ...server, url: "ftp://example.com/mcp" }] },
        }),
      ),
    ).toContain("远程 MCP 必须使用 https");
    expect(
      failure(
        meta({
          permissions: { network: ["example.com"] },
          contributions: { mcpServers: [{ ...server, url: "https://user:pass@example.com/mcp" }] },
        }),
      ),
    ).toContain("不能包含用户名或密码");
    expect(
      failure(
        meta({
          permissions: { network: ["example.com"] },
          contributions: { mcpServers: [{ ...server, url: "不是地址" }] },
        }),
      ),
    ).toContain("不是合法的 URL");
  });

  it("服务 key 格式与插件内唯一", () => {
    for (const key of ["Weather", "-w", "a".repeat(33)]) {
      expect(
        failure(
          meta({
            permissions: { network: ["mcp.example.com"] },
            contributions: { mcpServers: [{ ...server, key }] },
          }),
        ),
      ).toContain("服务 key");
    }
    expect(
      failure(
        meta({
          permissions: { network: ["mcp.example.com"] },
          contributions: { mcpServers: [server, { ...server, name: "第二个" }] },
        }),
      ),
    ).toContain("服务 key 重复：weather");
  });

  it("服务不是对象、名称超长与数量超限", () => {
    expect(
      failure(
        meta({
          permissions: { network: ["mcp.example.com"] },
          contributions: { mcpServers: ["天气"] },
        }),
      ),
    ).toContain("MCP 服务必须是 JSON 对象");

    const many = Array.from({ length: MAX_PLUGIN_MCP_SERVERS + 1 }, (_, i) => ({
      ...server,
      key: `s${i}`,
    }));
    expect(
      failure(
        meta({
          permissions: { network: ["mcp.example.com"] },
          contributions: { mcpServers: many },
        }),
      ),
    ).toContain(`单个插件最多 ${MAX_PLUGIN_MCP_SERVERS} 台 MCP 服务`);
  });
});

describe("parsePluginManifest · v3 工具束（d.65 增补）", () => {
  const pack = {
    id: "report-tools",
    name: "报告工具",
    description: "周报要用到的查询工具",
    tools: ["report_query", "report_export"],
  };

  it("工具束解析并归一化，description 缺省为空、工具名 trim", () => {
    const parsed = parsePluginManifest(
      meta({
        contributions: {
          toolPacks: [{ id: "report-tools", name: "  报告工具  ", tools: [" report_query "] }],
        },
      }),
    );

    expect(parsed.contributions.toolPacks).toEqual([
      {
        id: "report-tools",
        name: "报告工具",
        description: "",
        tools: ["report_query"],
      },
    ]);
    // 只有工具束也算一项能力（d.65：第四类贡献面）
    expect(parsed.contributions.skills).toEqual([]);
  });

  it("旧 v3 清单没有 toolPacks 继续合法，归一化为空数组", () => {
    const parsed = parsePluginManifest(
      meta({ contributions: { skills: [skill] } }),
    );
    expect(parsed.contributions.toolPacks).toEqual([]);
  });

  it("v1/v2 归一化后 toolPacks 为空数组", () => {
    const v1 = parsePluginManifest({
      schemaVersion: 1,
      id: "acme.demo",
      name: "演示包",
      version: "0.1.0",
      skills: [skill],
    });
    const v2 = parsePluginManifest(
      legacy({ schemaVersion: 2, skills: [], mcpServers: [server] }),
    );
    expect(v1.contributions.toolPacks).toEqual([]);
    expect(v2.contributions.toolPacks).toEqual([]);
  });

  it("工具束 id / 名称 / 工具名格式校验", () => {
    for (const id of ["Report", "-pack", "pack id"]) {
      expect(
        failure(meta({ contributions: { toolPacks: [{ ...pack, id }] } })),
      ).toContain("工具束 id");
    }
    expect(
      failure(meta({ contributions: { toolPacks: [{ ...pack, name: "x".repeat(33) }] } })),
    ).toContain("工具束名最多 32 字");
    for (const tool of ["", "-tool", "tool name", "工具"]) {
      expect(
        failure(meta({ contributions: { toolPacks: [{ ...pack, tools: [tool] }] } })),
        tool,
      ).toContain("工具名只能由字母、数字");
    }
    expect(
      failure(meta({ contributions: { toolPacks: [{ ...pack, tools: "report_query" }] } })),
    ).toContain("工具列表必须是数组");
  });

  it("跨工具束重复工具报错，并指出两处字段路径", () => {
    const message = failure(
      meta({
        contributions: {
          toolPacks: [
            { id: "pack-a", name: "甲", tools: ["report_query", "report_export"] },
            { id: "pack-b", name: "乙", tools: ["report_export"] },
          ],
        },
      }),
    );
    expect(message).toContain("工具名重复：report_export");
    expect(message).toContain("contributions.toolPacks[0].tools[1]");
    expect(message).toContain("contributions.toolPacks[1].tools[0]");
  });

  it("工具束 id 重复报错", () => {
    expect(
      failure(
        meta({
          contributions: {
            toolPacks: [
              { id: "same", name: "甲", tools: ["a"] },
              { id: "same", name: "乙", tools: ["b"] },
            ],
          },
        }),
      ),
    ).toContain("工具束 id 重复：same");
  });

  it("工具束数量与单个工具束工具数上限", () => {
    const manyPacks = Array.from({ length: MAX_PLUGIN_TOOL_PACKS + 1 }, (_, i) => ({
      id: `pack-${i}`,
      name: `束${i}`,
      tools: [`tool_${i}`],
    }));
    expect(failure(meta({ contributions: { toolPacks: manyPacks } }))).toContain(
      `单个插件最多 ${MAX_PLUGIN_TOOL_PACKS} 个工具束`,
    );

    const manyTools = Array.from({ length: MAX_TOOL_PACK_TOOLS + 1 }, (_, i) => `tool_${i}`);
    expect(
      failure(meta({ contributions: { toolPacks: [{ ...pack, tools: manyTools }] } })),
    ).toContain(`单个工具束最多 ${MAX_TOOL_PACK_TOOLS} 个工具`);
  });
});
