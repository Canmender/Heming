import { describe, it, expect } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, resolveBasePrompt } from "./defaultPrompt.js";

describe("内置智能体默认人设（d.156）", () => {
  it("用户没写提示词时用默认人设，且人设里点名了多步任务清单", () => {
    expect(resolveBasePrompt(undefined)).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(resolveBasePrompt("")).toBe(DEFAULT_SYSTEM_PROMPT);
    // 空白串等同于没写（用户在输入框里敲了几个空格不算自定义）
    expect(resolveBasePrompt("   \n\t ")).toBe(DEFAULT_SYSTEM_PROMPT);
    // 人设要能让模型真的用上清单工具，否则「长任务」还是嘴上说说
    expect(DEFAULT_SYSTEM_PROMPT).toContain("todo_write");
    // 没能力不许编造，是用户最直接的投诉点
    expect(DEFAULT_SYSTEM_PROMPT).toContain("不要编造结果");
  });

  it("用户写过提示词就完全按用户的来：不拼接、不改写、不去首尾空白之外的任何字符", () => {
    const custom = "  你是测试用的角色。\n只回答一句话。  ";
    expect(resolveBasePrompt(custom)).toBe(custom);
    expect(resolveBasePrompt(custom)).not.toContain("和小鸣");
  });

  it("畸形输入不炸：null / 非字符串回落默认人设", () => {
    expect(resolveBasePrompt(null)).toBe(DEFAULT_SYSTEM_PROMPT);
    // 运行时可能拿到历史遗留的脏值（数字/对象），不能被它撑爆提示词
    expect(resolveBasePrompt(42 as unknown as string)).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(resolveBasePrompt({ a: 1 } as unknown as string)).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
