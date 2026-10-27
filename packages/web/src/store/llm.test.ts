import { describe, it, expect, beforeEach, vi } from "vitest";
import { useLlmStore, type LlmProfile } from "./llm.js";

const p: LlmProfile = { id: "p1", label: "我的 Claude", provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-5" };

describe("llm store", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
  });
  it("addProfile 落 localStorage", () => {
    useLlmStore.getState().addProfile(p);
    expect(useLlmStore.getState().profiles).toHaveLength(1);
    const saved = JSON.parse(localStorage.getItem("heming.llmConfigs")!);
    expect(saved.profiles[0].model).toBe("claude-sonnet-5");
  });
  it("绑定与提示词独立持久化", () => {
    useLlmStore.getState().setBinding("agent-1", "p1");
    useLlmStore.getState().setPrompt("agent-1", "你是架构师");
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)["agent-1"]).toBe("p1");
    expect(JSON.parse(localStorage.getItem("heming.agentPrompts")!)["agent-1"]).toBe("你是架构师");
  });
  it("removeProfile 清相关绑定", () => {
    useLlmStore.getState().addProfile(p);
    useLlmStore.getState().setBinding("agent-1", "p1");
    useLlmStore.getState().removeProfile("p1");
    expect(useLlmStore.getState().bindings["agent-1"]).toBeUndefined();
  });

  // Produces 契约补充：updateProfile/getProfile 语义、null 解绑落盘、页面加载时从三键水合
  it("updateProfile 打补丁落盘，getProfile 按 id 取", () => {
    useLlmStore.getState().addProfile(p);
    useLlmStore.getState().updateProfile("p1", { label: "改名", temperature: 0.5 });
    expect(useLlmStore.getState().getProfile("p1")?.label).toBe("改名");
    expect(useLlmStore.getState().getProfile("nope")).toBeUndefined();
    const saved = JSON.parse(localStorage.getItem("heming.llmConfigs")!);
    expect(saved.profiles[0]).toMatchObject({ label: "改名", temperature: 0.5, model: "claude-sonnet-5" });
  });

  it("setBinding(agentId, null) 解绑并落盘", () => {
    useLlmStore.getState().setBinding("agent-1", "p1");
    useLlmStore.getState().setBinding("agent-1", null);
    expect(useLlmStore.getState().bindings["agent-1"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)).not.toHaveProperty("agent-1");
  });

  it("初始化从 localStorage 水合三键（模拟刷新）", async () => {
    localStorage.setItem("heming.llmConfigs", JSON.stringify({ profiles: [p] }));
    localStorage.setItem("heming.agentLlm", JSON.stringify({ "agent-1": "p1" }));
    localStorage.setItem("heming.agentPrompts", JSON.stringify({ "agent-1": "提示" }));
    vi.resetModules(); // 重置模块注册表 → 重新 import 触发 store 模块级 load()
    const fresh = await import("./llm.js");
    expect(fresh.useLlmStore.getState().profiles).toEqual([p]);
    expect(fresh.useLlmStore.getState().bindings).toEqual({ "agent-1": "p1" });
    expect(fresh.useLlmStore.getState().prompts).toEqual({ "agent-1": "提示" });
    // 损坏 JSON 不炸：再验证一次坏数据回退
    localStorage.setItem("heming.llmConfigs", "{oops");
    vi.resetModules();
    const fresh2 = await import("./llm.js");
    expect(fresh2.useLlmStore.getState().profiles).toEqual([]);
  });

  it("有桌面桥时 apiKey 以信封落盘，刷新后能解密水合", async () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    vi.resetModules();
    const fresh = await import("./llm.js");
    fresh.useLlmStore.getState().addProfile(p);

    const raw = localStorage.getItem("heming.llmConfigs")!;
    expect(JSON.parse(raw).__hemingEnc).toBe("v1");
    expect(raw).not.toContain("sk-ant-x");

    vi.resetModules();
    const again = await import("./llm.js");
    expect(again.useLlmStore.getState().profiles).toEqual([p]);
  });

  it("绑定与提示词不是凭据：仍走普通 localStorage", () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    useLlmStore.getState().setBinding("agent-1", "p1");
    useLlmStore.getState().setPrompt("agent-1", "你是架构师");
    expect(localStorage.getItem("heming.agentLlm")).not.toContain("__hemingEnc");
    expect(localStorage.getItem("heming.agentPrompts")).not.toContain("__hemingEnc");
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)).toEqual({ "agent-1": "p1" });
  });
});
