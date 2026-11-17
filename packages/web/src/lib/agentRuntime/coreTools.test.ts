import { describe, expect, it } from "vitest";

import { CORE_TOOL_NAMES, coreToolNames, isCoreTool } from "./coreTools.js";

/**
 * 假桥的 meta 查询：只对给定名字返回 `core: true`（模拟「工具定义处声明」）。
 */
function declarer(declared: Record<string, boolean>) {
  return (name: string) => (name in declared ? { core: declared[name] } : undefined);
}

describe("核心工具常驻（d.191 → d.207 声明式）", () => {
  it("旧名单兜底：本地能力仍然全部识别（含 d.204 的 workflow_run）", () => {
    for (const name of [
      "file_read",
      "file_write",
      "file_edit",
      "file_patch",
      "file_undo",
      "file_glob",
      "file_grep",
      "file_image",
      "run_command",
      "command_output",
      "command_list",
      "command_kill",
      "todo_write",
      "agent_task",
      "tool_output_read",
      // d.207 修的真 bug：d.204 加了工作流却没进名单，装了 MCP 后它可能被挤掉。
      "workflow_run",
    ]) {
      expect(isCoreTool(name)).toBe(true);
      expect(CORE_TOOL_NAMES).toContain(name);
    }
  });

  it("声明优先：桥声明 core 的工具即使不在旧名单里也会被钉住", () => {
    const metaOf = declarer({ company_search: true });
    expect(isCoreTool("company_search")).toBe(false);
    expect(isCoreTool("company_search", metaOf)).toBe(true);
    expect(coreToolNames(["srv__x", "company_search"], metaOf)).toEqual(["company_search"]);
  });

  it("声明与旧名单取并集：桥只声明一部分时，旧名单里的本地能力不会被漏掉", () => {
    const metaOf = declarer({ file_write: true });
    expect(coreToolNames(["file_read", "file_write", "run_command", "srv__a"], metaOf)).toEqual([
      "file_read",
      "file_write",
      "run_command",
    ]);
  });

  it("显式 core: false 不参与钉选，但旧名单里的名字仍按名单兜底", () => {
    const metaOf = declarer({ srv__x: false });
    expect(isCoreTool("srv__x", metaOf)).toBe(false);
    expect(coreToolNames(["srv__x"], metaOf)).toEqual([]);
  });

  it("MCP 工具与第三方工具都不算常驻（只认精确名字，不按前缀）", () => {
    for (const name of ["srv__read", "srv__file_write", "file_read_extra", "webtools__search", "file_"]) {
      expect(isCoreTool(name)).toBe(false);
      expect(isCoreTool(name, declarer({ srv__read: true }))).toBe(name === "srv__read");
    }
  });

  it("按目录原顺序挑出常驻工具，目录里没有的跳过", () => {
    const catalog = ["srv__a", "file_write", "srv__b", "run_command", "unknown_tool", "todo_write"];
    expect(coreToolNames(catalog)).toEqual(["file_write", "run_command", "todo_write"]);
  });

  it("重复名字只保留一次（不同提供者重名时不重复占名额）", () => {
    expect(coreToolNames(["file_read", "srv__x", "file_read"])).toEqual(["file_read"]);
    expect(coreToolNames(["a_tool", "a_tool"], declarer({ a_tool: true }))).toEqual(["a_tool"]);
  });

  it("空目录与全是陌生工具时返回空", () => {
    expect(coreToolNames([])).toEqual([]);
    expect(coreToolNames(["srv__a", "srv__b"])).toEqual([]);
  });
});
