import { describe, it, expect, afterEach } from "vitest";
import { setOverride } from "./modelCaps.js";
import { capabilityNotice, supportsKind } from "./capabilityNotice.js";
import type { LlmProfile } from "../store/llm.js";

function profile(provider: LlmProfile["provider"], model: string): LlmProfile {
  return { id: "p1", label: "测试连接", provider, apiKey: "k", model };
}

afterEach(() => localStorage.clear());

describe("supportsKind", () => {
  it("没有绑定连接时一切能力都算不支持", () => {
    expect(supportsKind(undefined, "tools")).toBe(false);
    expect(supportsKind(undefined, "vision")).toBe(false);
  });

  it("Anthropic 不再一票否决工具（d.49：形状在边缘转换，能力交回能力表）", () => {
    expect(supportsKind(profile("anthropic", "claude-sonnet-5"), "tools")).toBe(true);
    // 视觉同样回到表上：claude-sonnet-5 支持图片输入
    expect(supportsKind(profile("anthropic", "claude-sonnet-5"), "vision")).toBe(true);
  });

  it("Anthropic 连接的视觉仍按表判定（不再是全供应商一刀切）", () => {
    // 说 Anthropic 协议的第三方端点：模型本身没视觉就判掉，有工具能力就放行
    expect(supportsKind(profile("anthropic", "deepseek-chat"), "vision")).toBe(false);
    expect(supportsKind(profile("anthropic", "deepseek-chat"), "tools")).toBe(true);
  });

  it("按能力表判定：纯文本模型不支持视觉，未知模型按保守缺省支持工具", () => {
    expect(supportsKind(profile("openai", "deepseek-chat"), "vision")).toBe(false);
    expect(supportsKind(profile("openai", "gpt-4o"), "vision")).toBe(true);
    expect(supportsKind(profile("openai", "some-new-model"), "tools")).toBe(true);
  });

  it("用户覆盖层说模型不支持函数调用时，工具判掉（能力表是唯一事实源）", () => {
    setOverride("openai", "gpt-4o", { supportsTools: false });
    expect(supportsKind(profile("openai", "gpt-4o"), "tools")).toBe(false);
    // 只影响工具：视觉仍按表判定，避免一次覆盖把三个能力一起改掉
    expect(supportsKind(profile("openai", "gpt-4o"), "vision")).toBe(true);
  });
});

describe("capabilityNotice", () => {
  it("全部支持时返回 null（界面不该挂空提示）", () => {
    expect(
      capabilityNotice("tools", [{ name: "小鸣", profile: profile("openai", "deepseek-chat") }]),
    ).toBeNull();
  });

  it("工具降级文案点出智能体名与「不会使用工具」的事实", () => {
    // 表内没有「不支持函数调用」的模型，降级只可能来自用户覆盖层——这正是要提示的场景
    setOverride("anthropic", "claude-sonnet-4-5", { supportsTools: false });
    const text = capabilityNotice("tools", [
      { name: "小鸣", profile: profile("anthropic", "claude-sonnet-4-5") },
      { name: "财报", profile: profile("openai", "deepseek-chat") },
    ]);
    expect(text).toContain("小鸣");
    expect(text).not.toContain("财报");
    expect(text).toContain("不支持工具调用");
  });

  it("多个不支持时用顿号连排，视觉口径同工具", () => {
    const text = capabilityNotice("vision", [
      { name: "A", profile: profile("openai", "deepseek-chat") },
      { name: "B", profile: profile("openai", "deepseek-chat") },
    ]);
    expect(text).toContain("A、B");
    expect(text).toContain("不支持图片输入");
  });

  it("enabled=false 时不提示（一个工具都没开的会话不谈工具降级）", () => {
    expect(
      capabilityNotice(
        "tools",
        [{ name: "小鸣", profile: profile("anthropic", "claude-sonnet-4-5") }],
        false,
      ),
    ).toBeNull();
  });

  it("没绑连接的智能体不进文案：未绑定由发送拦截负责，不是能力降级", () => {
    expect(capabilityNotice("tools", [{ name: "小鸣", profile: undefined }])).toBeNull();
    expect(
      capabilityNotice("vision", [
        { name: "小鸣", profile: undefined },
        { name: "财报", profile: profile("openai", "deepseek-chat") },
      ]),
    ).toBe("绑定的模型不支持图片输入（财报），图片只作为附件保存，模型读不到内容。");
  });
});
