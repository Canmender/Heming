import { describe, expect, it } from "vitest";

import {
  SOURCE_PROFILE_FIELDS,
  parseTokensInput,
  sourceProfileCommand,
  sourceProfilePairs,
  sourceProfileRejected,
} from "./magpieSourceProfile";

describe("来源的画像四项", () => {
  it("四项都在，且键不重复", () => {
    const keys = SOURCE_PROFILE_FIELDS.map((field) => field.key);
    expect(keys).toEqual(["free", "context", "family", "unmasked"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("上下文带宽与内核同口径：200000 / 200k / 1.5m 都认", () => {
    expect(parseTokensInput("200000")).toBe(200_000);
    expect(parseTokensInput("200k")).toBe(200_000);
    expect(parseTokensInput("1.5m")).toBe(1_500_000);
    expect(parseTokensInput(" 272K ")).toBe(272_000);
    expect(parseTokensInput("")).toBeNull();
    expect(parseTokensInput("272kb")).toBeNull();
    expect(parseTokensInput("很多")).toBeNull();
  });

  it("算钱与原文照发各发一条，顺序固定", () => {
    expect(sourceProfilePairs({ free: "yes" })).toEqual(["free=yes"]);
    expect(sourceProfilePairs({ unmasked: "yes" })).toEqual(["unmasked=yes"]);
    expect(sourceProfilePairs({ unmasked: "no", free: "no" })).toEqual([
      "free=no",
      "unmasked=no",
    ]);
  });

  it("上下文与族标签原样带过去，中间的空格去掉", () => {
    expect(sourceProfilePairs({ context: " 272k " })).toEqual(["context=272k"]);
    expect(sourceProfilePairs({ family: " fast " })).toEqual(["family=fast"]);
  });

  it("一项都没填就不发；没有来源 id 也不发", () => {
    expect(sourceProfilePairs({})).toEqual([]);
    expect(sourceProfileCommand("p", {})).toBeNull();
    expect(sourceProfileCommand("  ", { free: "yes" })).toBeNull();
  });

  it("看不懂的那格点名，且整条命令都不发", () => {
    expect(sourceProfileRejected({ context: "很多", family: "ok" })).toEqual(["上下文带宽"]);
    expect(sourceProfileRejected({ family: "两个 词" })).toEqual(["族标签"]);
    expect(sourceProfileRejected({ context: "272k", family: "fast" })).toEqual([]);
    expect(sourceProfilePairs({ context: "很多", free: "yes" })).toEqual([]);
    expect(sourceProfileCommand("p", { context: "很多" })).toBeNull();
  });

  it("四项都填了合成一条命令", () => {
    expect(
      sourceProfileCommand("p", {
        unmasked: "yes",
        family: "fast",
        context: "272k",
        free: "yes",
      }),
    ).toEqual(["provider", "set", "p", "free=yes", "context=272k", "family=fast", "unmasked=yes"]);
  });
});
