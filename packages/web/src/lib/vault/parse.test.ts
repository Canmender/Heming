import { describe, expect, it } from "vitest";
import {
  extractHeadings,
  extractInlineTags,
  extractLinks,
  frontmatterAliases,
  frontmatterTags,
  maskCode,
  parseFrontmatter,
} from "./parse.js";

/**
 * vault 解析层：frontmatter / 双链 / 行内标签 / 标题。
 *
 * 全部用构造的 markdown 夹具，钉住三件事：
 * - 行号是 1 基**文件行**（body 的行号要加 frontmatter 偏移）；
 * - 代码块与行内代码里的语法一律不算；
 * - 别名、锚点、嵌入、CJK、URL 片段等边角各有用例。
 */

describe("parseFrontmatter", () => {
  it("解析数组型 aliases / tags，body 与行号偏移正确", () => {
    const raw = ["---", "title: 甲", "aliases: [A, B]", "tags: [x, y]", "---", "正文"].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(parsed.meta.title).toBe("甲");
    expect(parsed.meta.aliases).toEqual(["A", "B"]);
    expect(parsed.meta.tags).toEqual(["x", "y"]);
    expect(parsed.body).toBe("正文");
    // 前 5 行（含两条 ---）都算 frontmatter
    expect(parsed.lineOffset).toBe(5);
  });

  it("支持单数 alias 与逗号串 tags", () => {
    const raw = ["---", "alias: 单个别名", "tags: 甲, 乙", "---", ""].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(frontmatterAliases(parsed.meta)).toEqual(["单个别名"]);
    expect(frontmatterTags(parsed.meta)).toEqual(["甲", "乙"]);
  });

  it("支持「键后换行 + - 列表」写法", () => {
    const raw = ["---", "tags:", "  - 甲", "  - 乙", "aliases:", "  - A", "---", ""].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(frontmatterTags(parsed.meta)).toEqual(["甲", "乙"]);
    expect(frontmatterAliases(parsed.meta)).toEqual(["A"]);
  });

  it("tags 的 # 前缀被去掉、空格串也能拆", () => {
    const raw = ["---", 'tags: "#a #b"', "---", ""].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(frontmatterTags(parsed.meta)).toEqual(["a", "b"]);
  });

  it("没有 frontmatter 时整份当正文，偏移为 0", () => {
    const parsed = parseFrontmatter("就是正文\n第二行");
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe("就是正文\n第二行");
    expect(parsed.lineOffset).toBe(0);
  });

  it("只有开头 --- 没有闭合时不当 frontmatter", () => {
    const parsed = parseFrontmatter("---\n不是头\n");
    expect(parsed.meta).toEqual({});
    expect(parsed.lineOffset).toBe(0);
  });

  it("BOM 不影响 frontmatter 识别", () => {
    const raw = "\uFEFF---\ntitle: 甲\n---\n正文";
    const parsed = parseFrontmatter(raw);
    expect(parsed.meta.title).toBe("甲");
    expect(parsed.body).toBe("正文");
  });

  it("去重：aliases 大小写不敏感", () => {
    const raw = ["---", "aliases: [Foo, foo, Bar]", "---", ""].join("\n");
    expect(frontmatterAliases(parseFrontmatter(raw).meta)).toEqual(["Foo", "Bar"]);
  });
});

describe("maskCode", () => {
  it("围栏代码块与行内代码都变空格，长度与换行不变", () => {
    const md = ["a [[x]]", "```", "b [[y]]", "```", "c `[[z]]` d"].join("\n");
    const masked = maskCode(md);
    expect(masked.length).toBe(md.length);
    expect(masked.split("\n").length).toBe(md.split("\n").length);
    // 普通正文保留，围栏与行内代码被掩掉
    expect(masked).toContain("[[x]]");
    expect(masked).not.toContain("[[y]]");
    expect(masked).not.toContain("[[z]]");
  });

  it("未闭合的反引号按普通文本处理", () => {
    const md = "一个 ` 未闭合 [[x]]";
    expect(maskCode(md)).toBe(md);
  });

  it("~~~ 围栏同样生效", () => {
    const md = ["~~~", "[[y]]", "~~~"].join("\n");
    expect(maskCode(md)).not.toContain("[[y]]");
  });

  it("四空格缩进代码块里的链接、标签、标题都不算（与 mdast 判据一致）", () => {
    const md = ["正文 [[真]]", "", "    [[假]]", "    #假标签", "    # 假标题", "", "[[真2]]"].join("\n");
    const masked = maskCode(md);
    // 掩码必须等长且不改变行数，否则行号就错位了
    expect(masked.length).toBe(md.length);
    expect(masked.split("\n").length).toBe(md.split("\n").length);
    expect(masked).toContain("[[真]]");
    expect(masked).not.toContain("[[假]]");
    expect(extractLinks(md).map((link) => link.target)).toEqual(["真", "真2"]);
    expect(extractInlineTags(md)).toEqual([]);
    expect(extractHeadings(md)).toEqual([]);
  });

  it("引用块里的围栏代码块整段屏蔽（含引用块内的缩进代码块）", () => {
    const quoted = ["> ```markdown", "> [[假]]", "> #假标题", "> ```", "[[真]]"].join("\n");
    expect(extractLinks(quoted).map((link) => link.target)).toEqual(["真"]);
    expect(extractInlineTags(quoted)).toEqual([]);
    expect(extractHeadings(quoted)).toEqual([]);

    const quotedIndented = ["> 正文", ">", ">     [[假]]", ">", "> [[真]]"].join("\n");
    expect(extractLinks(quotedIndented).map((link) => link.target)).toEqual(["真"]);
  });

  it("列表项里的围栏与嵌套列表里的围栏都屏蔽", () => {
    const md = [
      "- 列表项",
      "  ```",
      "  [[假]]",
      "  ```",
      "  - 嵌套项",
      "    ```",
      "    [[假2]]",
      "    ```",
      "[[真]]",
    ].join("\n");
    expect(extractLinks(md).map((link) => link.target)).toEqual(["真"]);
  });

  it("列表项里的缩进代码块按「相对内容列 ≥4」屏蔽", () => {
    const md = ["- 列表项", "", "      [[假]]", "", "[[真]]"].join("\n");
    expect(extractLinks(md).map((link) => link.target)).toEqual(["真"]);
  });

  it("列表项里缩进 4 列但相对内容列只有 2 列的段落不算代码块（不误伤正文）", () => {
    const md = ["- 列表项", "", "    这是列表项里的段落 [[真]]", "", "[[真2]]"].join("\n");
    expect(extractLinks(md).map((link) => link.target)).toEqual(["真", "真2"]);
  });

  it("列表项里的围栏在列表结束时同步结束，不吞后面的顶层正文", () => {
    const md = ["- ```", "  代码里的 [[假]]", "", "[[真]]"].join("\n");
    expect(extractLinks(md).map((link) => link.target)).toEqual(["真"]);
  });
});

describe("extractLinks", () => {
  const md = [
    "第一行 [[a]]",
    "```",
    "[[代码块里]]",
    "```",
    "行内 `[[行内代码里]]` 不算",
    "第二行 [[b|显示别名]]",
    "~~~",
    "[[波浪围栏里]]",
    "~~~",
    "![[图片.png]]",
    "[[c#某标题]]",
    "\\[[被转义的]]",
    "[[d|别名|带竖线]]",
  ].join("\n");

  it("抽普通链接、别名、锚点、嵌入，并跳过代码区域与转义", () => {
    const links = extractLinks(md);
    expect(links.map((l) => l.target)).toEqual(["a", "b", "图片.png", "c", "d"]);
    expect(links.map((l) => l.line)).toEqual([1, 6, 10, 11, 13]);
  });

  it("别名 / 锚点 / 嵌入字段正确", () => {
    const links = extractLinks(md);
    expect(links[1].alias).toBe("显示别名");
    expect(links[3].heading).toBe("某标题");
    expect(links[2].embed).toBe(true);
    expect(links[0].embed).toBe(false);
    // 只按第一个竖线拆：别名本身可以含竖线
    expect(links[4].alias).toBe("别名|带竖线");
  });

  it("frontmatter 偏移会加到行号上", () => {
    const raw = ["---", "title: 甲", "---", "[[a]]"].join("\n");
    const parsed = parseFrontmatter(raw);
    const links = extractLinks(parsed.body, { lineOffset: parsed.lineOffset });
    expect(links[0].line).toBe(4);
  });

  it("空目标与空文本返回空数组", () => {
    expect(extractLinks("")).toEqual([]);
    expect(extractLinks("[[]]")).toEqual([]);
    expect(extractLinks("[[|只有别名]]")).toEqual([]);
  });
});

describe("extractInlineTags", () => {
  const md = [
    "# 标题不是标签",
    "正文 #项目/预算 与 #Tag。",
    "数字 #123 不算，日期式 #2024-11 也不算。",
    "URL https://example.com/page#section 不算。",
    "行内代码 `#code` 不算。",
    "```",
    "#围栏里",
    "```",
    "括号（#括号内）可以。",
    "转义 \\#不是标签。",
  ].join("\n");

  it("抽 #tag 与 #a/b，排除标题、纯数字、URL、代码与转义", () => {
    const tags = extractInlineTags(md);
    expect(tags.map((t) => t.tag)).toEqual(["项目/预算", "Tag", "括号内"]);
    expect(tags.map((t) => t.line)).toEqual([2, 2, 9]);
  });

  it("CJK 标签与多级标签完整保留", () => {
    const tags = extractInlineTags("见 #知识/索引 与 #记忆");
    expect(tags.map((t) => t.tag)).toEqual(["知识/索引", "记忆"]);
  });

  it("frontmatter 偏移会加到行号上", () => {
    const raw = ["---", "title: 甲", "---", "正文 #标签"].join("\n");
    const parsed = parseFrontmatter(raw);
    const tags = extractInlineTags(parsed.body, { lineOffset: parsed.lineOffset });
    expect(tags[0]).toEqual({ tag: "标签", line: 4 });
  });

  it("空文本返回空数组", () => {
    expect(extractInlineTags("")).toEqual([]);
  });
});

describe("extractHeadings", () => {
  const md = [
    "# 一级",
    "## 二级 带 `代码`",
    "正文",
    "```",
    "# 代码里的标题",
    "```",
    "### 三级 ###",
  ].join("\n");

  it("抽各级标题并跳过代码块", () => {
    const headings = extractHeadings(md);
    expect(headings).toEqual([
      { level: 1, text: "一级", line: 1 },
      { level: 2, text: "二级 带 `代码`", line: 2 },
      { level: 3, text: "三级", line: 7 },
    ]);
  });

  it("frontmatter 偏移会加到行号上", () => {
    const raw = ["---", "title: 甲", "---", "# 正文标题"].join("\n");
    const parsed = parseFrontmatter(raw);
    const headings = extractHeadings(parsed.body, { lineOffset: parsed.lineOffset });
    expect(headings[0]).toEqual({ level: 1, text: "正文标题", line: 4 });
  });

  it("没有空格的 # 不算标题", () => {
    expect(extractHeadings("#不是标题")).toEqual([]);
  });
});
