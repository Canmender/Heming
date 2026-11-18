import { describe, expect, it } from "vitest";

import {
  parseAgentVisibility,
  pickedOnlyArgs,
  sameVisibleRange,
  visibilityOf,
  visibilitySummary,
  visibleArgs,
} from "./magpieVisible";

describe("magpieVisible", () => {
  it("解析每个智能体一行的收窄情况", () => {
    const raw = [
      "  codex         deepseek, relay          12 shown, 3 not",
      "  claude        deepseek · only models picked   40 shown, 0 not",
      "",
    ].join("\n");
    const list = parseAgentVisibility(raw);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ agent: "codex", names: ["deepseek", "relay"], shown: 12, hidden: 3 });
    expect(list[1]).toEqual({
      agent: "claude",
      names: ["deepseek"],
      pickedOnly: true,
      shown: 40,
      hidden: 0,
    });
  });

  it("去掉终端颜色再解析", () => {
    const raw = "  \u001b[32mcodex\u001b[0m         \u001b[2mdeepseek\u001b[0m   3 shown, 1 not";
    expect(parseAgentVisibility(raw)[0]).toEqual({
      agent: "codex",
      names: ["deepseek"],
      shown: 3,
      hidden: 1,
    });
  });

  it("空态（每个智能体都能看到全部模型）返回空数组", () => {
    expect(
      parseAgentVisibility(
        "every agent is shown every model · magpie visible <agent> <family>,… narrows one",
      ),
    ).toEqual([]);
    expect(parseAgentVisibility("")).toEqual([]);
    expect(parseAgentVisibility("! something failed")).toEqual([]);
  });

  it("忽略没有缩进的提示行与 families 行", () => {
    const raw = ["magpie visible", "  codex       relay    4 shown, 0 not", "families: ocgo"].join("\n");
    const list = parseAgentVisibility(raw);
    expect(list).toHaveLength(1);
    expect(list[0]!.agent).toBe("codex");
  });

  it("按智能体查、查不到就是不受限", () => {
    const list = parseAgentVisibility("  codex       relay    4 shown, 0 not");
    expect(visibilityOf(list, "Codex")?.names).toEqual(["relay"]);
    expect(visibilityOf(list, "cursor")).toBeUndefined();
    expect(visibilitySummary(undefined)).toBe("能看到全部模型");
    expect(visibilitySummary(list[0]!)).toBe("收窄到 relay · 4 个可见");
  });

  it("勾满或一个都不勾时恢复 all", () => {
    expect(visibleArgs("claude", ["deepseek", "relay"])).toEqual([
      "visible",
      "claude",
      "deepseek,relay",
    ]);
    expect(visibleArgs("claude", [])).toEqual(["visible", "claude", "all"]);
    expect(visibleArgs("claude", ["  "])).toEqual(["visible", "claude", "all"]);
  });

  it("只显示挑过的模型：开与关各一条命令", () => {
    expect(pickedOnlyArgs("claude", true)).toEqual(["visible", "claude", "--only-picked"]);
    expect(pickedOnlyArgs("codex", false)).toEqual(["visible", "codex", "--show-new"]);
  });

  it("判断有没有改动：全勾与「没勾过」是同一份，顺序也不影响", () => {
    const all = ["deepseek", "relay", "workbuddy"];
    // 保存的是「全部」（空名单），现在勾满 => 没改动。
    expect(sameVisibleRange([], all, all)).toBe(true);
    // 保存的就是同一份子集 => 没改动（不是只有「全部」才算没改）。
    expect(sameVisibleRange(["relay"], ["relay"], ["relay", "deepseek"])).toBe(true);
    // 保存的是子集、现在勾满了 => 改过了（从「收窄」放开成「全部」）。
    expect(sameVisibleRange(["relay"], ["relay", "deepseek"], ["relay", "deepseek"])).toBe(false);
    expect(sameVisibleRange(["deepseek", "relay"], ["relay", "deepseek"], all)).toBe(true);
    // 少勾一个 => 改过了。
    expect(sameVisibleRange([], ["deepseek", "relay"], all)).toBe(false);
    // 两人都空 => 没改动。
    expect(sameVisibleRange([], [], all)).toBe(true);
    // 勾了目录里没有的旧名字、但目录里每一个都在里面：仍算「全部」。
    expect(sameVisibleRange([], ["deepseek", "relay", "workbuddy", "old"], all)).toBe(true);
    // 少勾一个、其余照旧 => 真的改过了。
    expect(sameVisibleRange([], ["deepseek", "relay"], all)).toBe(false);
  });
});
