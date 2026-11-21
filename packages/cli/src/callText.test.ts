import { describe, it, expect } from "vitest";
import { oneLine, describeCallArgs } from "./callText.js";

describe("oneLine：一行化截断", () => {
  it("普通文本超长按 max-1 截断并加省略号", () => {
    expect(oneLine("a".repeat(100), 80)).toBe(`${"a".repeat(79)}…`);
    expect(oneLine("hello world", 80)).toBe("hello world");
  });

  it("截断落在 emoji 代理对中间时不留孤立半截（d.412 回归）", () => {
    const input = "a".repeat(78) + "😀" + "TAIL";
    const clipped = oneLine(input, 80);
    // 不含任何落单代理：逐码元扫，高位必须紧跟低位，低位前必须是高位。
    const units = Array.from(clipped, (ch) => ch.charCodeAt(0));
    let ok = true;
    for (let i = 0; i < units.length; i += 1) {
      const c = units[i];
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = units[i + 1];
        if (!(next >= 0xdc00 && next <= 0xdfff)) ok = false;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        const prev = units[i - 1];
        if (!(prev >= 0xd800 && prev <= 0xdbff)) ok = false;
      }
    }
    expect(ok).toBe(true);
    expect(clipped.endsWith("…")).toBe(true);
    // emoji 整体被让出（回退一格），不会留下高位半截 + 省略号。
    expect(clipped).toBe("a".repeat(78) + "…");
  });

  it("窄宽度审批提示同样不劈 emoji（approvals.ts:180 宽度）", () => {
    const clipped = oneLine("a".repeat(18) + "😀" + "TAIL", 20);
    expect(clipped).not.toContain("\ud83d");
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("describeCallArgs", () => {
  it("挑出 command 字段并压成一行", () => {
    expect(describeCallArgs(JSON.stringify({ command: "git status", path: "x" }))).toBe(" command=git status");
  });

  it("非对象或空参数返回空串", () => {
    expect(describeCallArgs("null")).toBe("");
    expect(describeCallArgs("{}")).toBe("");
  });
});
