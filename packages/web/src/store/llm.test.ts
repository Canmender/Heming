import { describe, it, expect, beforeEach, vi } from "vitest";
import { useLlmStore, type LlmProfile } from "./llm.js";

const p: LlmProfile = { id: "p1", label: "我的 Claude", provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-5" };

describe("llm store", () => {
  beforeEach(() => {
    localStorage.clear();
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
});
