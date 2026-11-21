import { describe, expect, it, vi } from "vitest";
import {
  MAX_SUBAGENT_DEFS,
  MAX_SUBAGENT_DEF_CHARS,
  SUBAGENT_DEFS_DIR,
  collectSubagentDefs,
  describeSubagentDefs,
  findSubagentDef,
  parseSubagentDef,
  parseSubagentDefs,
  subagentDefNameOf,
} from "./subagentDefs.js";
import type { FileRoot } from "../fileEdit/paths.js";

const ROOTS: FileRoot[] = [{ name: "评测区", path: "D:/评测区", mode: "write" }];

function source(rel: string, text: string) {
  return { rel, text };
}

const REVIEW = source(
  ".heming/agents/review.md",
  "# 安全审查\n> 只挑能被利用的问题\n\n按威胁模型逐条对：入口、权限、数据落点。",
);

describe("自定义子代理：文件名即子代理名（d.287）", () => {
  it("只认 .md、名字限小写字母数字与短横线，其余忽略", () => {
    expect(subagentDefNameOf(".heming/agents/review.md")).toBe("review");
    expect(subagentDefNameOf(".heming/agents/perf-check.md")).toBe("perf-check");
    expect(subagentDefNameOf(".heming/agents/Review.md")).toBe("review");
    expect(subagentDefNameOf(".heming/agents/审查.md")).toBeNull();
    expect(subagentDefNameOf(".heming/agents/review.txt")).toBeNull();
    expect(subagentDefNameOf(".heming/agents/-bad.md")).toBeNull();
    expect(subagentDefNameOf(".heming/agents/9lives.md")).toBeNull();
  });

  it("解析出完整定义：名字、标题、说明、要求、来源", () => {
    const def = parseSubagentDef(REVIEW);
    expect(def).not.toBeNull();
    expect(def).toMatchObject({
      name: "review",
      title: "安全审查",
      hint: "只挑能被利用的问题",
      instructions: "按威胁模型逐条对：入口、权限、数据落点。",
      rel: ".heming/agents/review.md",
      truncated: false,
    });
  });

  it("没有标题/说明时退化成名字与来源说明（正文里的 # 属于要求本身）", () => {
    const def = parseSubagentDef(source(".heming/agents/perf.md", "先问数据规模\n# 再看热点\n最后猜瓶颈"));
    expect(def?.title).toBe("perf");
    expect(def?.hint).toContain(".heming/agents/perf.md");
    expect(def?.instructions).toBe("先问数据规模\n# 再看热点\n最后猜瓶颈");
  });

  it("空文件、只有标题没有要求 → 不算定义（空转比没有更糟）", () => {
    expect(parseSubagentDef(source(".heming/agents/empty.md", "\n\n"))).toBeNull();
    expect(parseSubagentDef(source(".heming/agents/title-only.md", "# 只有标题\n> 说明\n"))).toBeNull();
    expect(parseSubagentDef(source(".heming/agents/README.md", "# 目录说明\n这些文件是子代理定义。"))).not.toBeNull();
  });

  it("指令截断落在 emoji 中间时不劈出落单代理（会进子代理提示词，d.412 回归）", () => {
    const long = "x".repeat(MAX_SUBAGENT_DEF_CHARS - 1) + "😀" + "tail";
    const instructions = parseSubagentDef(source(".heming/agents/emoji.md", long))?.instructions ?? "";
    const units = instructions.split("").map((ch) => ch.charCodeAt(0));
    const lone = units.some((c, i) =>
      (c >= 0xd800 && c <= 0xdbff)
        ? !(i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff)
        : (c >= 0xdc00 && c <= 0xdfff)
          ? !(i > 0 && units[i - 1] >= 0xd800 && units[i - 1] <= 0xdbff)
          : false,
    );
    expect(lone).toBe(false);
    expect(Array.from(instructions.split("\n")[0]!)).toHaveLength(MAX_SUBAGENT_DEF_CHARS);
  });

  it("超长要求按上限截断，并写明「需要完整内容用 file_read」", () => {
    const long = "字".repeat(MAX_SUBAGENT_DEF_CHARS + 200);
    const def = parseSubagentDef(source(".heming/agents/long.md", long));
    expect(def?.truncated).toBe(true);
    expect(def?.instructions.startsWith("字".repeat(100))).toBe(true);
    expect(def?.instructions).toContain("只发了前面这些");
    expect(def?.instructions).toContain(".heming/agents/long.md");
  });

  it("整批：按路径排序、同名取先读到的、超过上限就停", () => {
    const sources = [
      source(".heming/agents/b.md", "占位 B"),
      source(".heming/agents/a.md", "占位 A"),
      source(".heming/agents/b.md", "重复的 B"),
      ...Array.from({ length: MAX_SUBAGENT_DEFS + 5 }, (_, i) =>
        source(`.heming/agents/c${String(i).padStart(2, "0")}.md`, `角色 ${i}`),
      ),
    ];
    const defs = parseSubagentDefs(sources);
    expect(defs).toHaveLength(MAX_SUBAGENT_DEFS);
    expect(defs[0].name).toBe("a");
    expect(defs.filter((def) => def.name === "b")).toHaveLength(1);
    expect(defs.find((def) => def.name === "b")?.instructions).toBe("占位 B");
  });

  it("按名字查找忽略大小写与空白；找不到返回 null", () => {
    const defs = parseSubagentDefs([REVIEW]);
    expect(findSubagentDef(defs, "review")?.title).toBe("安全审查");
    expect(findSubagentDef(defs, " REVIEW ")?.name).toBe("review");
    expect(findSubagentDef(defs, "nope")).toBeNull();
    expect(findSubagentDef(defs, null)).toBeNull();
  });

  it("给工具描述用的清单带标题，空列表是空串", () => {
    const defs = parseSubagentDefs([REVIEW, source(".heming/agents/perf.md", "看热点")]);
    // 顺序按路径排序（perf.md 在 review.md 之前），清单本身不重排。
    expect(describeSubagentDefs(defs)).toBe("perf（perf）、review（安全审查）");
    expect(describeSubagentDefs([])).toBe("");
  });
});

describe("从工作区读自定义子代理（d.287）", () => {
  it("读得到就解析，读不到文件就跳过（坏一个不影响别的）", async () => {
    const bridge = {
      read: vi.fn(async ({ path }: { path: string }) => {
        if (path.endsWith("bad.md")) return { ok: false as const, code: "io", error: "读不了" };
        return { ok: true as const, content: "# 角色\n> 一句说明\n要求正文", bytes: 10 };
      }),
      write: vi.fn(),
      pickRoot: vi.fn(),
      glob: vi.fn(async ({ pattern }: { pattern: string }) => {
        expect(pattern).toBe(`${SUBAGENT_DEFS_DIR}/*.md`);
        return {
          ok: true as const,
          root: "D:/评测区",
          paths: [".heming/agents/a.md", ".heming/agents/bad.md"],
          truncated: false,
        };
      }),
    };
    const defs = await collectSubagentDefs({ bridge: bridge as never, roots: ROOTS });
    expect(defs.map((def) => def.name)).toEqual(["a"]);
    expect(defs[0].instructions).toBe("要求正文");
  });

  it("没有桥 / 没有可写根 / 老桌面端没有 glob → 空数组，不抛", async () => {
    const bridge = { read: vi.fn(), write: vi.fn(), pickRoot: vi.fn() };
    expect(await collectSubagentDefs({ bridge: null, roots: ROOTS })).toEqual([]);
    expect(await collectSubagentDefs({ bridge: bridge as never, roots: [] })).toEqual([]);
    expect(await collectSubagentDefs({ bridge: bridge as never, roots: ROOTS })).toEqual([]);
  });

  it("glob 抛错时吞掉（自定义子代理不该让对话失败）", async () => {
    const bridge = {
      read: vi.fn(),
      write: vi.fn(),
      pickRoot: vi.fn(),
      glob: vi.fn(async () => {
        throw new Error("桥崩了");
      }),
    };
    expect(await collectSubagentDefs({ bridge: bridge as never, roots: ROOTS })).toEqual([]);
  });
});
