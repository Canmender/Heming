import { describe, expect, it } from "vitest";

import {
  compactArgs,
  compactSummary,
  contextCapArgs,
  contextCapSummary,
  parseCompact,
  parseContextCap,
  parseSuffix,
  suffixArgs,
  suffixSummary,
} from "./modelGlobals";

describe("modelGlobals", () => {
  it("名字后缀：三种模式与读不出来的情况", () => {
    expect(parseSuffix("on · agents' lists name a model with its provider, \"Sol · OpenAI\"").mode).toBe(
      "on",
    );
    expect(parseSuffix("own · a name you gave a model just as you wrote it").mode).toBe("own");
    expect(parseSuffix("off · agents' lists name a model alone").mode).toBe("off");
    expect(parseSuffix("magpie: unknown model").mode).toBe("");
    expect(suffixSummary({ mode: "own" })).toBe("自己命名的原样，其余带来源");
    expect(suffixSummary({ mode: "" })).toBe("读不到现在的设置");
    expect(suffixArgs("off")).toEqual(["model", "suffix", "off"]);
  });

  it("压缩窗口：压缩点与整个窗口", () => {
    expect(
      parseCompact(
        "on · Codex, Claude Code and Grok Build compact at 200K on a longer window; in Claude Code a Claude model runs to its own · magpie model compact off",
      ),
    ).toEqual({ fullContext: false, size: "200K" });
    expect(
      parseCompact("off · Codex, Claude Code and Grok Build run a conversation to the model's whole window"),
    ).toEqual({ fullContext: true });
    expect(compactSummary({ fullContext: false, size: "500K" })).toBe("压缩到 500K");
    expect(compactSummary({ fullContext: true })).toBe("整个窗口，不压缩");
    expect(compactArgs("500k")).toEqual(["model", "compact", "500k"]);
    expect(compactArgs(" ")).toEqual(["model", "compact", "on"]);
    expect(compactArgs("off")).toEqual(["model", "compact", "off"]);
  });

  it("窗口上限：有数值与 off", () => {
    expect(parseContextCap("off · every model takes its own window · magpie model context-cap <size>")).toEqual(
      {},
    );
    expect(parseContextCap("200K · no model is told a longer window · magpie model context-cap off")).toEqual({
      size: "200K",
    });
    expect(contextCapSummary({})).toBe("不设上限，每个模型用自己的窗口");
    expect(contextCapSummary({ size: "200K" })).toBe("不超过 200K");
    expect(contextCapArgs("")).toEqual(["model", "context-cap", "off"]);
    expect(contextCapArgs("all")).toEqual(["model", "context-cap", "all"]);
  });

  it("忽略 ANSI 与 magpie 提示行", () => {
    expect(parseSuffix("\u001b[32m✓\u001b[0m\non · x").mode).toBe("on");
  });
});
