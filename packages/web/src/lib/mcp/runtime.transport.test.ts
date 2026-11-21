import { describe, expect, it } from "vitest";
import { isTransportFailure } from "./runtime.js";

describe("isTransportFailure", () => {
  it("连不上地址（含 CORS 提示）算连接层故障，要落状态/触发重连（d.412 回归）", () => {
    const msg = "工具调用失败（mcp-exception）：连不上这个 MCP 地址：请确认服务已启动、地址填写正确，且服务允许跨域访问（CORS）。";
    expect(isTransportFailure(msg)).toBe(true);
  });

  it("工具自身的业务报错不算连接层故障", () => {
    expect(isTransportFailure("工具调用失败：目标文件不存在")).toBe(false);
  });
});
