import { describe, expect, it } from "vitest";
import { isModelId, parseAgents } from "./magpieAgents.js";

/** 本机智能体解析（d.113）：只认“名字 + 配置路径”的行，不猜。 */

const RAW = `  Claude Code       —  ·  effort —                         ~\\.claude\\settings.json
  Claude Desktop    provider —                             ~\\AppData\\Local\\Claude\\claude_desktop_config.json
  Codex             space-bunny  ·  effort high            ~\\.codex\\config.toml
  OpenCode          —  ·  small —                          ~\\.config\\opencode\\opencode.jsonc
  Hermes Agent      CLI not found                          ~\\AppData\\Local\\hermes\\config.yaml
  DeepSeek Harness  deepseek-v4.1-flash  ·  thinking high  ~\\.dsh\\profiles\\web\\cordis.patch.yml
`;

describe("parseAgents", () => {
  it("解析名字、当前模型、档位与配置路径，并映射到命令 id", () => {
    const agents = parseAgents(RAW);
    expect(agents).toHaveLength(6);
    expect(agents[0]).toMatchObject({
      name: "Claude Code",
      id: "claude",
      model: "—",
      configPath: "~\\.claude\\settings.json",
    });
    expect(agents[2]).toMatchObject({ name: "Codex", id: "codex", model: "space-bunny", detail: "effort high" });
    expect(agents[5]).toMatchObject({ name: "DeepSeek Harness", id: "dsh", model: "deepseek-v4.1-flash" });
  });

  it("没有配置路径/空行/usage 行都跳过，不产出半条记录", () => {
    expect(parseAgents("")).toEqual([]);
    expect(parseAgents("usage: magpie ls")).toEqual([]);
    expect(parseAgents("Claude Code    —")).toEqual([]);
  });

  it("没映射到命令的展示名保留为只读（id=null）", () => {
    const agents = parseAgents("Some New Agent  model-x  ~\\.newagent\\config.json\n");
    expect(agents[0]).toMatchObject({ name: "Some New Agent", id: null, model: "model-x" });
  });
});

describe("isModelId", () => {
  it("接受 provider/model 与常见模型 id，拒绝空串与带空格的注入串", () => {
    expect(isModelId("deepseek/deepseek-chat")).toBe(true);
    expect(isModelId("gpt-4o")).toBe(true);
    expect(isModelId("openrouter/anthropic/claude-opus-4")).toBe(true);
    expect(isModelId("")).toBe(false);
    expect(isModelId("model; rm -rf /")).toBe(false);
    expect(isModelId("two words")).toBe(false);
  });
});
