import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  DEFAULT_GATEWAY,
  modelIdOfProfile,
  modelProfileId,
  routeRef,
  useLlmStore,
  type RouteGroup,
} from "./llm.js";
import type { GatewayModel } from "../lib/magpieClient.js";

/**
 * 模型 store（d.89：magpie 原生组件）。
 *
 * 关注点：网关配置落盘、目录 → 模型档案派生、绑定/候选链只存模型引用、
 * 旧版供应商连接按产品决定被清除。聊天调用本身在 llmClient 测试里覆盖。
 */

const MODELS: GatewayModel[] = [
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", ownedBy: "anthropic", contextWindow: 200000, maxOutputTokens: 8192, reasoningLevels: ["low", "high"], vision: true },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", ownedBy: "deepseek", contextWindow: 64000, maxOutputTokens: 4096, reasoningLevels: [], vision: false },
];

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  useLlmStore.setState({
    gateway: { ...DEFAULT_GATEWAY },
    models: [],
    gatewayVersion: undefined,
    backgroundModel: null,
    profiles: [],
    bindings: {},
    prompts: {},
    routes: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("llm store · magpie 网关与模型档案", () => {
  it("默认就是本机 magpie 网关，且没有任何模型（还没读过目录）", () => {
    expect(useLlmStore.getState().gateway).toEqual(DEFAULT_GATEWAY);
    expect(useLlmStore.getState().profiles).toEqual([]);
  });

  it("setModels 派生模型档案（id 带 mp: 前缀），并落盘目录缓存", () => {
    useLlmStore.getState().setModels(MODELS, "0.1.3246");
    const state = useLlmStore.getState();
    expect(state.profiles).toHaveLength(2);
    expect(state.profiles[0]).toMatchObject({
      id: modelProfileId("anthropic/claude-sonnet-5"),
      label: "Claude Sonnet 5",
      provider: "openai",
      baseUrl: DEFAULT_GATEWAY.baseUrl,
      apiKey: DEFAULT_GATEWAY.key,
      model: "anthropic/claude-sonnet-5",
    });
    expect(modelIdOfProfile(state.profiles[1].id)).toBe("deepseek/deepseek-chat");
    expect(state.gatewayVersion).toBe("0.1.3246");
    const saved = JSON.parse(localStorage.getItem("heming.magpie.models.v1")!);
    expect(saved.map((m: GatewayModel) => m.id)).toEqual([
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-chat",
    ]);
  });

  it("setGateway 落盘并把地址/Key 同步进已有档案（模型列表不变）", () => {
    useLlmStore.getState().setModels(MODELS);
    useLlmStore.getState().setGateway({ baseUrl: "http://127.0.0.1:3999/v1/", key: "magpie-acme" });
    expect(useLlmStore.getState().gateway).toEqual({
      baseUrl: "http://127.0.0.1:3999/v1",
      key: "magpie-acme",
      source: "manual",
    });
    expect(useLlmStore.getState().profiles[0].baseUrl).toBe("http://127.0.0.1:3999/v1");
    expect(useLlmStore.getState().profiles[0].apiKey).toBe("magpie-acme");
    expect(JSON.parse(localStorage.getItem("heming.magpie.v1")!)).toEqual({
      baseUrl: "http://127.0.0.1:3999/v1",
      key: "magpie-acme",
      source: "manual",
    });
  });

  it("refreshCatalog 走网关 /v1/models（带网关 Key），成功写入目录与版本", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(String(input));
        if (String(input).endsWith("/api/hello")) {
          return new Response(JSON.stringify({ name: "magpie", version: "0.1.3246" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            object: "list",
            data: MODELS.map((m) => ({
              id: m.id,
              display_name: m.name,
              owned_by: m.ownedBy,
              context_window: m.contextWindow,
              max_output_tokens: m.maxOutputTokens,
              modalities: m.vision ? ["text", "image"] : ["text"],
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const catalog = await useLlmStore.getState().refreshCatalog();
    expect(catalog.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-chat",
    ]);
    expect(useLlmStore.getState().gatewayVersion).toBe("0.1.3246");
    expect(useLlmStore.getState().profiles).toHaveLength(2);
    expect(calls.some((url) => url.endsWith("/v1/models"))).toBe(true);
  });

  it("绑定与提示词独立持久化；解绑落盘", () => {
    useLlmStore.getState().setBinding("agent-1", modelProfileId("deepseek/deepseek-chat"));
    useLlmStore.getState().setPrompt("agent-1", "你是架构师");
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)["agent-1"]).toBe(
      "mp:deepseek/deepseek-chat",
    );
    expect(JSON.parse(localStorage.getItem("heming.agentPrompts")!)["agent-1"]).toBe("你是架构师");
    useLlmStore.getState().setBinding("agent-1", null);
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)).not.toHaveProperty("agent-1");
  });

  it("桌面端反代地址：source=desktop 时自动采用并落盘；manual 永不覆盖", () => {
    useLlmStore.getState().setModels(MODELS);
    useLlmStore.setState({ gateway: { ...DEFAULT_GATEWAY, source: "desktop" } });
    expect(useLlmStore.getState().adoptDesktopGateway("http://127.0.0.1:40123/v1")).toBe(true);
    expect(useLlmStore.getState().gateway).toMatchObject({
      baseUrl: "http://127.0.0.1:40123/v1",
      source: "desktop",
    });
    expect(useLlmStore.getState().profiles[0].baseUrl).toBe("http://127.0.0.1:40123/v1");
    expect(JSON.parse(localStorage.getItem("heming.magpie.v1")!)).toMatchObject({
      baseUrl: "http://127.0.0.1:40123/v1",
      source: "desktop",
    });

    useLlmStore.getState().setGateway({ baseUrl: "https://gw.example.com/v1", key: "k" });
    expect(useLlmStore.getState().adoptDesktopGateway("http://127.0.0.1:40124/v1")).toBe(false);
    expect(useLlmStore.getState().gateway.baseUrl).toBe("https://gw.example.com/v1");
  });

  it("候选链只存模型档案引用；删链时解绑", () => {
    const group: RouteGroup = {
      id: "g1",
      label: "主备",
      members: [{ profileId: modelProfileId("deepseek/deepseek-chat") }],
    };
    useLlmStore.getState().addRoute(group);
    useLlmStore.getState().setBinding("agent-1", routeRef("g1"));
    useLlmStore.getState().removeRoute("g1");
    expect(useLlmStore.getState().routes).toEqual([]);
    expect(useLlmStore.getState().bindings["agent-1"]).toBeUndefined();
  });
});

describe("后台任务模型（d.125）", () => {
  it("设置后落盘；空串/空白 = 清空", () => {
    useLlmStore.getState().setBackgroundModel("  deepseek/deepseek-chat  ");
    expect(useLlmStore.getState().backgroundModel).toBe("deepseek/deepseek-chat");
    expect(JSON.parse(localStorage.getItem("heming.backgroundModel.v1")!)).toBe(
      "deepseek/deepseek-chat",
    );
    useLlmStore.getState().setBackgroundModel("   ");
    expect(useLlmStore.getState().backgroundModel).toBeNull();
    expect(JSON.parse(localStorage.getItem("heming.backgroundModel.v1")!)).toBeNull();
  });
});

describe("旧版供应商配置迁移（产品决定：直接清除）", () => {
  it("首次启动清掉旧连接（含安全存储备份键）、旧绑定、旧候选链与旧冷却", async () => {
    localStorage.setItem("heming.llmConfigs", JSON.stringify({ profiles: [{ id: "p1", apiKey: "sk-x" }] }));
    localStorage.setItem("heming.llmConfigs.__heming_undecryptable", "cipher");
    localStorage.setItem("heming.llmConfigs.__heming_plaintext_backup", "plain");
    localStorage.setItem("heming.agentLlm", JSON.stringify({ "agent-1": "p1" }));
    localStorage.setItem("heming.llmRoutes.v1", JSON.stringify([{ id: "g", label: "x", members: [] }]));
    localStorage.setItem("heming.llmHealth.v1", JSON.stringify({ a: { until: Date.now() + 1000 } }));
    vi.resetModules();
    const fresh = await import("./llm.js");
    for (const key of [
      "heming.llmConfigs",
      "heming.llmConfigs.__heming_undecryptable",
      "heming.llmConfigs.__heming_plaintext_backup",
      "heming.agentLlm",
      "heming.llmRoutes.v1",
      "heming.llmHealth.v1",
    ]) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    expect(fresh.useLlmStore.getState().bindings).toEqual({});
    expect(fresh.useLlmStore.getState().routes).toEqual([]);
    // 标记已迁移：二次启动不再清（用户新建的绑定不会被误删）
    localStorage.setItem("heming.agentLlm", JSON.stringify({ "agent-2": "mp:x" }));
    vi.resetModules();
    const again = await import("./llm.js");
    expect(again.useLlmStore.getState().bindings["agent-2"]).toBe("mp:x");
  });

  it("提示词不属于供应商配置，迁移不删", async () => {
    localStorage.setItem("heming.agentPrompts", JSON.stringify({ "agent-1": "保留我" }));
    vi.resetModules();
    await import("./llm.js");
    expect(JSON.parse(localStorage.getItem("heming.agentPrompts")!)["agent-1"]).toBe("保留我");
  });
});
