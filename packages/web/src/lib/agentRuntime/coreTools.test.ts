import { describe, expect, it } from "vitest";

import { CORE_TOOL_NAMES, coreToolNames, isCoreTool } from "./coreTools.js";

describe("核心工具常驻（d.191）", () => {
  it("认出本地能力：读写、命令、作业、清单、子代理、长输出", () => {
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
    ]) {
      expect(isCoreTool(name)).toBe(true);
      expect(CORE_TOOL_NAMES).toContain(name);
    }
  });

  it("MCP 工具与第三方工具都不算常驻（只认精确名字）", () => {
    for (const name of ["srv__read", "srv__file_write", "file_read_extra", "webtools__search", "file_"]) {
      expect(isCoreTool(name)).toBe(false);
    }
  });

  it("按目录原顺序挑出常驻工具，目录里没有的跳过", () => {
    const catalog = ["srv__a", "file_write", "srv__b", "run_command", "unknown_tool", "todo_write"];
    expect(coreToolNames(catalog)).toEqual(["file_write", "run_command", "todo_write"]);
  });

  it("重复名字只保留一次（不同提供者重名时不重复占名额）", () => {
    expect(coreToolNames(["file_read", "srv__x", "file_read"])).toEqual(["file_read"]);
  });

  it("空目录与全是陌生工具时返回空", () => {
    expect(coreToolNames([])).toEqual([]);
    expect(coreToolNames(["srv__a", "srv__b"])).toEqual([]);
  });
});
