import { describe, it, expect } from "vitest";
import { DESIGN_TOKENS } from "./tokens.js";

describe("DESIGN_TOKENS", () => {
  it("分割线为浅灰，不是黑色", () => {
    expect(DESIGN_TOKENS.line).toBe("#e6e6e6");
    expect(DESIGN_TOKENS.lineSoft).toBe("#ececec");
    expect(DESIGN_TOKENS.line).not.toBe("#000000");
  });
  it("阴影为灰色系", () => {
    expect(DESIGN_TOKENS.shadowCard).toContain("rgba(0, 0, 0, 0.07)");
  });
});
