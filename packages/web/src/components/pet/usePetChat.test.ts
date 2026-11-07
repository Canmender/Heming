import { describe, expect, it } from "vitest";
import { buildPetMessages, resolvePetProfile } from "./usePetChat.js";
import type { LlmProfile } from "../../store/llm.js";
import type { ChatMessage } from "../../lib/llmClient.js";

const profileA: LlmProfile = {
  id: "p-a",
  label: "连接 A",
  provider: "openai",
  apiKey: "sk-a",
  model: "gpt-4o-mini",
};
const profileB: LlmProfile = {
  id: "p-b",
  label: "连接 B",
  provider: "openai",
  apiKey: "sk-b",
  model: "claude-3-5-sonnet",
};

describe("选桌宠用的模型连接", () => {
  it("没有任何连接时返回 null（不假装能聊）", () => {
    expect(resolvePetProfile([], {}, null)).toBeNull();
    expect(resolvePetProfile([], { a1: "p-a" }, "a1")).toBeNull();
  });

  it("智能体已绑定连接时优先用它", () => {
    expect(resolvePetProfile([profileA, profileB], { a1: "p-b" }, "a1")).toBe(profileB);
  });

  it("绑定指向的连接已被删除时回落到第一个可用连接", () => {
    expect(resolvePetProfile([profileA, profileB], { a1: "p-gone" }, "a1")).toBe(profileA);
  });

  it("未指定智能体（null）时用第一个连接", () => {
    expect(resolvePetProfile([profileA, profileB], {}, null)).toBe(profileA);
    expect(resolvePetProfile([profileA, profileB], { a1: "p-b" }, null)).toBe(profileA);
  });

  it("绑定了别的智能体不影响当前桌宠的选择", () => {
    expect(resolvePetProfile([profileA, profileB], { other: "p-b" }, "a1")).toBe(profileA);
  });
});

describe("拼桌宠对话的消息序列", () => {
  it("第一条永远是 system（含桌宠人设）", () => {
    const msgs = buildPetMessages([], "你好");
    expect(msgs[0].role).toBe("system");
    expect(String(msgs[0].content)).toContain("桌面宠物");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "你好" });
  });

  it("智能体提示词接在人设之后", () => {
    const msgs = buildPetMessages([], "在吗", "你是班级小助手");
    const system = String(msgs[0].content);
    expect(system).toContain("桌面宠物");
    expect(system).toContain("班级小助手");
    // 人设在前、智能体提示词在后（后者更具体，应该压轴）
    expect(system.indexOf("桌面宠物")).toBeLessThan(system.indexOf("班级小助手"));
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
