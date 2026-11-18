import { describe, expect, it } from "vitest";
import {
  failedSections,
  readFailureDetail,
  readFailureText,
  readFailuresText,
  setReadError,
  type ReadErrors,
} from "./readErrors.js";

describe("readFailureDetail", () => {
  it("取 stderr 最后一行有内容的话，并剥掉 ANSI 颜色", () => {
    const detail = readFailureDetail("\u001b[31m启动中…\u001b[0m\n\n\u001b[31m内核没有就绪（端口 3425）\u001b[0m\n");
    expect(detail).toBe("内核没有就绪（端口 3425）");
  });

  it("stderr 空时退到 error 字段", () => {
    expect(readFailureDetail("", "spawn failed")).toBe("spawn failed");
  });

  it("两边都没有就说「没有说明原因」，不编一个", () => {
    expect(readFailureDetail("", undefined)).toBe("没有说明原因");
    expect(readFailureDetail("\n\n", "")).toBe("没有说明原因");
  });

  it("长句压成一行并截到 120 字以内", () => {
    const detail = readFailureDetail(`${"x".repeat(400)}`);
    expect(detail.length).toBe(120);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("外部引擎名不会漏到界面上", () => {
    const detail = readFailureDetail("magpie: cannot read the sign-ins");
    expect(detail).not.toMatch(/magpie/i);
    expect(detail).toContain("模型服务");
  });
});

describe("setReadError", () => {
  it("失败时记下原因，成功时把这一段抹掉", () => {
    let errors: ReadErrors = {};
    errors = setReadError(errors, "providers", "连不上");
    expect(errors.providers).toBe("连不上");

    const same = setReadError(errors, "accounts", "读不到");
    expect(same.providers).toBe("连不上");
    expect(same.accounts).toBe("读不到");

    const cleared = setReadError(same, "providers", null);
    expect(cleared.providers).toBeUndefined();
    expect(cleared.accounts).toBe("读不到");
  });

  it("原因没变时原样返回，不制造一次多余渲染", () => {
    const errors = setReadError({}, "quotas", "超时");
    expect(setReadError(errors, "quotas", "超时")).toBe(errors);
    expect(setReadError({}, "quotas", null)).toEqual({});
  });

  it("空原因也写成人话，不留一个空字符串", () => {
    expect(setReadError({}, "agents", "   ").agents).toBe("没有说明原因");
  });
});

describe("给用户看的那一句", () => {
  it("说清是「没读到」，不是「还没有」", () => {
    expect(readFailureText("accounts", "连不上")).toBe("这次没读到订阅账号：连不上");
    expect(readFailureText("providers", "")).toBe("这次没读到来源：没有说明原因");
  });

  it("按固定顺序列出失败的那几段", () => {
    const errors = setReadError(setReadError({}, "quotas", "a"), "providers", "b");
    expect(failedSections(errors)).toEqual(["providers", "quotas"]);
    expect(readFailuresText(errors)).toBe("来源、其余额度这次没读到。");
  });

  it("一段都没失败就返回空串", () => {
    expect(readFailuresText({})).toBe("");
    expect(failedSections({})).toEqual([]);
  });
});