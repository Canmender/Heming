import { describe, expect, it } from "vitest";
import type { FileFsBridge, FileReadResponse } from "../fileEdit/bridge.js";
import type { FileRoot } from "../fileEdit/paths.js";
import {
  MAX_PROJECT_RULE_CHARS,
  MAX_PROJECT_RULES_TOTAL_CHARS,
  PROJECT_RULES_HEADING,
  collectProjectRules,
  normalizeRuleText,
  summarizeProjectRules,
} from "./projectRules.js";

const ROOT: FileRoot = { name: "工作区", path: "D:/项目/和鸣", mode: "write" };

/** 以「绝对路径 → 内容」做一张内存盘，未收录的路径回 not-found。 */
function fakeBridge(files: Record<string, string>, onRead?: (path: string) => void): FileFsBridge {
  return {
    read: async ({ path }): Promise<FileReadResponse> => {
      onRead?.(path);
      const key = Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase());
      if (key === undefined) return { ok: false, code: "not-found", error: "找不到文件" };
      return { ok: true, content: files[key]!, bytes: files[key]!.length };
    },
    write: async () => ({ ok: true }),
    pickRoot: async () => null,
  };
}

const base = () => ({ bridge: fakeBridge({}), roots: [ROOT], workspace: ROOT.path });

describe("项目约定文件（d.174）", () => {
  it("没有工作区时不注入：约定必须挂在某个会话的工作区上", async () => {
    const got = await collectProjectRules({ bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": "规矩" }), roots: [ROOT] });
    expect(got.section).toBe("");
    expect(got.files).toEqual([]);
  });

  it("没有桌面桥时不注入（浏览器端没有 local 文件）", async () => {
    const got = await collectProjectRules({ bridge: null, roots: [ROOT], workspace: ROOT.path });
    expect(got.section).toBe("");
  });

  it("工作区里没有约定文件时零注入，不留半句残话", async () => {
    const got = await collectProjectRules(base());
    expect(got).toEqual({ files: [], section: "", omitted: [] });
  });

  it("读到 AGENTS.md：段里有标题、文件名和原文", async () => {
    const got = await collectProjectRules({
      ...base(),
      bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": "命令用 pnpm。改完跑 pnpm -w typecheck。" }),
    });
    expect(got.section).toContain(PROJECT_RULES_HEADING);
    expect(got.section).toContain("### AGENTS.md");
    expect(got.section).toContain("命令用 pnpm。");
    expect(got.files.map((f) => f.rel)).toEqual(["AGENTS.md"]);
  });

  it("说明来源与冲突口径：约定不是最高指示", async () => {
    const got = await collectProjectRules({ ...base(), bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": "用 npm" }) });
    expect(got.section).toContain("来自本工作区里的约定文件");
    expect(got.section).toContain("以用户的要求为准");
  });

  it("BOM 与 CRLF 会被归一化（Windows 编辑器写出来的东西不该带控制字符进提示词）", async () => {
    const got = await collectProjectRules({
      ...base(),
      bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": "\uFEFF第一行\r\n第二行\r\n" }),
    });
    expect(got.files[0]!.text).toBe("第一行\n第二行");
    expect(normalizeRuleText("\uFEFFa\r\n\r\nb\n")).toBe("a\n\nb");
  });

  it("空文件不占预算（只有空白的内容没有信息量）", async () => {
    const got = await collectProjectRules({ ...base(), bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": "  \n\t\n " }) });
    expect(got.section).toBe("");
  });

  it("超长文件只留开头，并写明怎么继续读", async () => {
    const long = "字".repeat(MAX_PROJECT_RULE_CHARS + 500);
    const got = await collectProjectRules({ ...base(), bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": long }) });
    const file = got.files[0]!;
    expect(file.truncated).toBe(true);
    expect(file.text.length).toBe(MAX_PROJECT_RULE_CHARS);
    expect(got.section).toContain(`只读了前 ${MAX_PROJECT_RULE_CHARS} 字`);
    expect(got.section).toContain("`file_read`");
  });

  it("按优先级读、最多读两个：AGENTS.md 之后是 HEMING.md", async () => {
    const got = await collectProjectRules({
      ...base(),
      bridge: fakeBridge({
        "D:/项目/和鸣/AGENTS.md": "第一条",
        "D:/项目/和鸣/HEMING.md": "第二条",
        "D:/项目/和鸣/.heming/rules.md": "第三条",
      }),
    });
    expect(got.files.map((f) => f.rel)).toEqual(["AGENTS.md", "HEMING.md"]);
    expect(got.section).toContain("第二条");
    expect(got.section).toContain(".heming/rules.md"); // 读满上限后的文件也要点名，不静默丢
  });

  it("总量封顶：前面的文件吃满预算后，后面的只出现在「没展开」清单里", async () => {
    // 单文件上限 4000、总量上限 6000：第一个文件 4000 + 第二个 3000 会超总量。
    const got = await collectProjectRules({
      ...base(),
      bridge: fakeBridge({
        "D:/项目/和鸣/AGENTS.md": "甲".repeat(MAX_PROJECT_RULE_CHARS + 100),
        "D:/项目/和鸣/HEMING.md": "乙".repeat(3000),
      }),
    });
    expect(got.files.map((f) => f.rel)).toEqual(["AGENTS.md"]);
    expect(got.omitted).toContain("HEMING.md");
    expect(got.section).toContain("没展开");
    expect(got.section.length).toBeLessThan(MAX_PROJECT_RULES_TOTAL_CHARS + 1000);
  });

  it("单个文件读失败只跳过一个，不影响其它文件", async () => {
    const got = await collectProjectRules({
      ...base(),
      bridge: fakeBridge({ "D:/项目/和鸣/.heming/AGENTS.md": "备用规矩" }),
    });
    expect(got.files.map((f) => f.rel)).toEqual([".heming/AGENTS.md"]);
    expect(got.section).toContain("备用规矩");
  });

  it("桥抛错时静默跳过（读盘异常不该让对话发不出去）", async () => {
    const bridge: FileFsBridge = {
      read: async () => {
        throw new Error("ipc 挂了");
      },
      write: async () => ({ ok: true }),
      pickRoot: async () => null,
    };
    const got = await collectProjectRules({ bridge, roots: [ROOT], workspace: ROOT.path });
    expect(got.section).toBe("");
  });

  it("工作区是根下面的一层时，相对路径按根算（而不是当成根自己）", async () => {
    const paths: string[] = [];
    const got = await collectProjectRules({
      roots: [{ name: "项目", path: "D:/项目", mode: "write" }],
      workspace: "D:/项目/和鸣",
      bridge: fakeBridge({ "D:/项目/和鸣/AGENTS.md": "子目录规矩" }, (p) => paths.push(p)),
    });
    expect(paths[0]).toBe("D:/项目/和鸣/AGENTS.md");
    expect(got.files.map((f) => f.rel)).toEqual(["AGENTS.md"]);
  });

  it("工作区不在任何根内时不读盘（读不到就不是约定，也不是错误）", async () => {
    const got = await collectProjectRules({
      bridge: fakeBridge({ "D:/别处/AGENTS.md": "别人的规矩" }),
      roots: [{ name: "项目", path: "D:/项目", mode: "write" }],
      workspace: "D:/别处",
    });
    expect(got.section).toBe("");
  });
});

describe("约定文件的只读摘要（d.219）", () => {
  it("摘要只给事实：文件名、字数、是否截断、省略几份", () => {
    const summary = summarizeProjectRules({
      files: [
        { rel: "AGENTS.md", text: "一二三四五", truncated: false },
        { rel: ".heming/rules.md", text: "六七八", truncated: true },
      ],
      section: "（不需要）",
      omitted: ["HEMING.md"],
    });
    expect(summary.files).toEqual([
      { rel: "AGENTS.md", chars: 5, truncated: false },
      { rel: ".heming/rules.md", chars: 3, truncated: true },
    ]);
    // 省略的是「几个文件」，不是文件名——摘要给 `/status` 用，不展开
    expect(summary.omitted).toBe(1);
    // 正文不进摘要：自检不是看文件的地方
    expect(JSON.stringify(summary)).not.toContain("一二三四五");
  });

  it("什么都没读到时给空数组（调用方据此说「无」）", () => {
    expect(summarizeProjectRules({ files: [], section: "", omitted: [] })).toEqual({ files: [], omitted: 0 });
  });
});
