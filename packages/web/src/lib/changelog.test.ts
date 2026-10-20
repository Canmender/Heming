import { describe, it, expect } from "vitest";
import { CHANGELOG, entriesUpTo, parseInline, stripInline } from "./changelog.js";
// 解析器是 node 侧脚本（.mjs），直接从仓库路径引入同一份实现
// @ts-expect-error 运行时无类型信息
import { parseChangelog } from "../../../../scripts/changelog-parser.mjs";
// @ts-expect-error 同上
import { renderChangelogModule } from "../../../../scripts/changelog-parser.mjs";

const SAMPLE = [
  "# 更新日志 / Changelog",
  "",
  "和鸣的版本记录。",
  "",
  "## d.3.1.0.0（2026-10-19）— 新增更新日志卡",
  "",
  "本段是说明。",
  "",
  "- 新增 **设置区** 的更新日志卡",
  "  - 支持 `**粗体**` 与 `` `代码` ``",
  "",
  "```bash",
  "node scripts/build-changelog.mjs",
  "```",
  "",
  "## d.3.0.3.0（2026-10-19）",
  "",
  "- 只有要点，没有标题",
  "",
].join("\n");

describe("parseChangelog", () => {
  it("按 `## 版本（日期）— 标题` 切条，文件头不进条目", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      version: "d.3.1.0.0",
      date: "2026-10-19",
      title: "新增更新日志卡",
    });
    expect(entries[0].paragraphs).toContain("本段是说明。");
  });

  it("列表符号去掉；缩进二级要点保留层级提示", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[0].bullets[0]).toBe("新增 **设置区** 的更新日志卡");
    expect(entries[0].bullets[1]).toBe("— 支持 `**粗体**` 与 `` `代码` ``");
  });

  it("代码块内容不进要点；无标题的条目照收", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[0].bullets.join("\n")).not.toContain("build-changelog.mjs");
    expect(entries[1]).toMatchObject({ version: "d.3.0.3.0", title: "" });
  });

  it("空/无条目输入返回空数组，不抛", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# 只有标题\n")).toEqual([]);
    expect(parseChangelog(undefined)).toEqual([]);
  });
});

describe("renderChangelogModule", () => {
  it("产出的 TS 里含条目 JSON 与类型声明", () => {
    const out = renderChangelogModule(parseChangelog(SAMPLE));
    expect(out).toContain("export interface ChangelogEntry");
    expect(out).toContain('"version": "d.3.1.0.0"');
  });
});

describe("parseInline / stripInline", () => {
  it("粗体与行内代码分别成段", () => {
    const segs = parseInline("新增 **设置区** 的 `scripts/x.mjs` 支持");
    expect(segs).toEqual([
      { kind: "text", text: "新增 " },
      { kind: "bold", text: "设置区" },
      { kind: "text", text: " 的 " },
      { kind: "code", text: "scripts/x.mjs" },
      { kind: "text", text: " 支持" },
    ]);
  });

  it("未闭合的标记按普通文本处理，不显示原始符号", () => {
    expect(stripInline("**没闭合")).toBe("**没闭合");
    expect(stripInline("`没闭合")).toBe("`没闭合");
    expect(parseInline("")).toEqual([]);
  });

  it("stripInline 去掉所有标记只留文本", () => {
    expect(stripInline("**粗** 与 `码`")).toBe("粗 与 码");
  });
});

describe("entriesUpTo / 生成数据", () => {
  it("给定当前版本时只展示到该版本（含）", () => {
    const first = CHANGELOG[0].version;
    const list = entriesUpTo(first);
    expect(list[0].version).toBe(first);
    expect(list.length).toBeLessThanOrEqual(CHANGELOG.length);
  });

  it("版本对不上就展示全部，不猜、不抛", () => {
    expect(entriesUpTo("d.99.0.0").length).toBe(CHANGELOG.length);
    expect(entriesUpTo(undefined).length).toBe(CHANGELOG.length);
  });

  it("生成的数据非空且按新→旧排列（版本号可比较）", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    const cmp = (a: string, b: string) => {
      const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
      const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < 4; i++) {
        const d = (pa[i + 1] ?? 0) - (pb[i + 1] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(cmp(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBeGreaterThanOrEqual(0);
    }
  });

  it("每条都有版本、日期且至少一段内容", () => {
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/^[a-z]\.\d+\.\d+\.\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.bullets.length + e.paragraphs.length).toBeGreaterThan(0);
    }
  });
});
