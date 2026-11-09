import { describe, expect, it } from "vitest";
import {
  buildPetMessages,
  resolveAgentPrompt,
  resolveConnectionLabel,
} from "./usePetChat.js";
import type { ChatConfig } from "../../lib/widgetBridge.js";
import type { ChatMessage } from "../../lib/gatewayChat.js";

const CONFIG: ChatConfig = {
  gateway: { baseUrl: "http://127.0.0.1:3425/v1", key: "magpie-heming" },
  agents: [
    { id: "a1", name: "班级助手", prompt: "你是班级小助手" },
    { id: "a2", name: "写作助手" },
  ],
  binding: { agentId: "a1" },
};

describe("对话上下文（宿主 chatConfig）", () => {
  it("绑定智能体的提示词接在人设之后", () => {
    const prompt = resolveAgentPrompt(CONFIG);
    expect(prompt).toBe("你是班级小助手");
    const msgs = buildPetMessages([], "在吗", prompt);
    const system = String(msgs[0].content);
    expect(system).toContain("桌面宠物");
    expect(system).toContain("班级小助手");
    // 人设在前、智能体提示词在后（后者更具体，应该压轴）
    expect(system.indexOf("桌面宠物")).toBeLessThan(system.indexOf("班级小助手"));
  });

  it("无绑定/无配置时不注入智能体提示词", () => {
    expect(resolveAgentPrompt(null)).toBeUndefined();
    expect(resolveAgentPrompt({ ...CONFIG, binding: { agentId: null } })).toBeUndefined();
    expect(resolveAgentPrompt({ ...CONFIG, binding: { agentId: "gone" } })).toBeUndefined();
    // 智能体存在但没有提示词
    expect(
      resolveAgentPrompt({ ...CONFIG, binding: { agentId: "a2" } }),
    ).toBeUndefined();
  });

  it("气泡角标用绑定智能体的名字", () => {
    expect(resolveConnectionLabel(CONFIG)).toBe("班级助手");
    expect(resolveConnectionLabel(null)).toBeNull();
    expect(resolveConnectionLabel({ ...CONFIG, binding: { agentId: null } })).toBeNull();
  });
});

describe("拼桌宠对话的消息序列", () => {
  it("第一条永远是 system（含桌宠人设）", () => {
    const msgs = buildPetMessages([], "你好");
    expect(msgs[0].role).toBe("system");
    expect(String(msgs[0].content)).toContain("桌面宠物");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "你好" });
  });

  it("空/空白提示词不产生多余空行", () => {
    const withBlank = String(buildPetMessages([], "hi", "   ")[0].content);
    const without = String(buildPetMessages([], "hi")[0].content);
    expect(withBlank).toBe(without);
  });

  it("历史按轮次截断，只带最近的若干条", () => {
    const history: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `第 ${i} 条`,
    }));
    const msgs = buildPetMessages(history, "新问题");
    // system + 最近 12 条 + 本轮
    expect(msgs.length).toBe(1 + 12 + 1);
    expect(msgs.at(-1)).toEqual({ role: "user", content: "新问题" });
    // 截断取的是**最后**若干条，不是最前
    expect(String(msgs[1].content)).toBe("第 18 条");
  });

  it("历史为空时只有 system + 本轮", () => {
    expect(buildPetMessages([], "只有一句").length).toBe(2);
  });

  it("不改动传入的历史数组", () => {
    const history: ChatMessage[] = [{ role: "user", content: "旧" }];
    const snapshot = JSON.parse(JSON.stringify(history));
    buildPetMessages(history, "新");
    expect(history).toEqual(snapshot);
  });
});
