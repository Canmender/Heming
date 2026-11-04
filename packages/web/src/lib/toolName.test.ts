import { describe, expect, it } from "vitest";
import { toolNameLabel } from "./toolName.js";

describe("toolNameLabel：MCP 工具名只影响展示", () => {
  it("服务名__工具名 → 服务名 · 工具名", () => {
    expect(toolNameLabel("mocksrv__save_note")).toBe("mocksrv · save_note");
    expect(toolNameLabel("echo-svc__echo")).toBe("echo-svc · echo");
  });

  it("非 MCP 名（无分隔符 / 多个分隔符 / 空段）原样返回，不猜边界", () => {
    expect(toolNameLabel("chart_render")).toBe("chart_render");
    expect(toolNameLabel("a__b__c")).toBe("a__b__c");
    expect(toolNameLabel("__tool")).toBe("__tool");
    expect(toolNameLabel("server__")).toBe("server__");
    expect(toolNameLabel("")).toBe("");
  });
});
