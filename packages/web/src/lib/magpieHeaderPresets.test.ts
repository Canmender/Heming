import { describe, expect, it } from "vitest";

import { HEADER_PRESETS, applyHeaderPreset } from "./magpieHeaderPresets.js";

const codex = HEADER_PRESETS.find((preset) => preset.name === "Codex CLI");
const cherry = HEADER_PRESETS.find((preset) => preset.name === "Cherry Studio");

describe("常见客户端的请求头", () => {
  it("七份预设都有名字、出处和至少一个头", () => {
    expect(HEADER_PRESETS.length).toBe(7);
    expect(HEADER_PRESETS.every((preset) => preset.name && preset.from && preset.headers.length > 0)).toBe(true);
  });

  it("空草稿：把预设整个抄进去，一行一个", () => {
    expect(applyHeaderPreset("", cherry!)).toBe("HTTP-Referer: https://cherry-ai.com\nX-Title: Cherry Studio");
  });

  it("草稿里没有的追加，已有的留着自己的值", () => {
    const text = applyHeaderPreset("X-Title: 我自己的", cherry!);
    expect(text).toBe("X-Title: 我自己的\nHTTP-Referer: https://cherry-ai.com");
  });

  it("同名但没值（意思是删掉这个头）：填上预设的值", () => {
    expect(applyHeaderPreset("X-Title:", cherry!)).toBe("X-Title: Cherry Studio\nHTTP-Referer: https://cherry-ai.com");
  });

  it("名字不分大小写，也不会抄出第二个同名的头", () => {
    const text = applyHeaderPreset("user-agent: 我的", codex!);
    expect(text.split("user-agent:").length - 1 + (text.match(/User-Agent:/g)?.length ?? 0)).toBe(1);
    expect(text.startsWith("user-agent: 我的")).toBe(true);
    expect(text).toContain("originator: codex_cli_rs");
  });

  it("空行顺手去掉，别的行原样留着", () => {
    expect(applyHeaderPreset("\nX-A: 1\n\n  \n", cherry!)).toBe(
      "X-A: 1\nHTTP-Referer: https://cherry-ai.com\nX-Title: Cherry Studio",
    );
  });

  it("抄两遍不会变成两份：第二遍什么都不多", () => {
    const once = applyHeaderPreset("", cherry!);
    expect(applyHeaderPreset(once, cherry!)).toBe(once);
  });
});
