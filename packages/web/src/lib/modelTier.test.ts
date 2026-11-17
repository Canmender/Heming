import { describe, expect, it } from "vitest";

import { supportsModelTier } from "./modelTier.js";

const WITH_TIER = `usage:
  magpie model name <provider/model>             the name the model goes by
  magpie model tier <provider/model>             how fast the model answers
  magpie model price <provider/model>            what the model costs you
`;

const WITHOUT_TIER = `usage:
  magpie model name <provider/model>             the name the model goes by
  magpie model price <provider/model>            what the model costs you
`;

describe("supportsModelTier", () => {
  it("usage 里有 model tier 才算支持", () => {
    expect(supportsModelTier(WITH_TIER)).toBe(true);
  });

  it("内核不认识 tier 时返回 false", () => {
    expect(supportsModelTier(WITHOUT_TIER)).toBe(false);
  });

  it("空输出、报错文本都不算支持", () => {
    expect(supportsModelTier("")).toBe(false);
    expect(supportsModelTier('magpie: unknown command "tier"')).toBe(false);
  });
});
