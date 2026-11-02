import { describe, expect, it } from "vitest";
import { isPetWindow } from "./petWindow.js";

describe("桌宠窗口判定", () => {
  it("带 hemingWindow=pet 才算桌宠窗", () => {
    expect(isPetWindow("?hemingWindow=pet")).toBe(true);
    expect(isPetWindow("?a=1&hemingWindow=pet")).toBe(true);
  });

  it("通话窗口 / 无标记 / 其它值都不算", () => {
    expect(isPetWindow("?hemingWindow=call&conv=c1&peers=u2")).toBe(false);
    expect(isPetWindow("")).toBe(false);
    expect(isPetWindow("?a=1")).toBe(false);
    expect(isPetWindow("?hemingWindow=pet2")).toBe(false);
    expect(isPetWindow("?hemingWindow=")).toBe(false);
  });

  it("坏输入不抛错", () => {
    expect(isPetWindow(null as unknown as string)).toBe(false);
    expect(isPetWindow(undefined as unknown as string)).toBe(false);
    expect(isPetWindow("%%%")).toBe(false);
  });
});
