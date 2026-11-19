import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./blocks.js";

describe("splitMarkdownBlocks（d.353）", () => {
  it("空正文没有可冻结的部分", () => {
    expect(splitMarkdownBlocks("")).toEqual({ stable: "", tail: "" });
  });

  it("块数不多于尾部预留时，整段都是尾部", () => {
    const text = "第一段，还没有空行。";
    expect(splitMarkdownBlocks(text)).toEqual({ stable: "", tail: text });
    const two = ["一", "", "二"].join("\n");
    expect(splitMarkdownBlocks(two)).toEqual({ stable: "", tail: two });
  });

  it("按空行切开，尾部保留两块", () => {
    const text = ["一", "", "二", "", "三", "", "四"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text);
    expect(stable).toBe("一\n\n二\n\n");
    expect(tail).toBe("三\n\n四");
    // 拼回去必须还是原文，一个字符都不能少
    expect(stable + tail).toBe(text);
  });

  it("追加内容时，已冻结的前缀一个字节都不变", () => {
    const before = ["# 标题", "", "第一段", "", "第二段"].join("\n");
    const after = `${before}\n\n第三段还在写`;
    const first = splitMarkdownBlocks(before);
    const second = splitMarkdownBlocks(after);
    expect(first.stable).toBe("# 标题\n\n");
    expect(second.stable.startsWith(first.stable)).toBe(true);
    expect(second.stable).toBe("# 标题\n\n第一段\n\n");
    expect(second.tail).toBe("第二段\n\n第三段还在写");
  });

  it("列表跨空行不切开（松散列表仍是一张列表）", () => {
    const text = ["1. 第一步", "", "2. 第二步", "", "3. 第三步", "", "尾巴", "", "再加一段"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text);
    // 列表内的空行不是切点：切了就会变成两张列表
    expect(stable).toBe("1. 第一步\n\n2. 第二步\n\n3. 第三步\n\n");
    expect(tail).toBe("尾巴\n\n再加一段");
    expect(stable + tail).toBe(text);
  });

  it("表格行跨空行不切开", () => {
    const text = ["| a | b |", "|---|---|", "| 1 | 2 |", "", "| 3 | 4 |", "", "尾巴", "", "再加一段"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text);
    expect(stable).toContain("| 1 | 2 |");
    expect(stable).toContain("| 3 | 4 |");
    expect(tail).toBe("尾巴\n\n再加一段");
  });

  it("围栏没闭合时，从围栏那一块起都算尾部", () => {
    const text = ["开场", "", "中间", "", "```ts", "const a = 1;", "", "const b = 2;"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text, 1);
    // 「中间」可以冻结；半截代码块不能
    expect(stable).toBe("开场\n\n中间\n\n");
    expect(tail.startsWith("```ts")).toBe(true);
  });

  it("围栏闭合后可以继续冻结", () => {
    const text = ["开场", "", "```ts", "const a = 1;", "```", "", "中间", "", "收尾"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text);
    expect(stable).toContain("const a = 1;");
    expect(tail).toBe("中间\n\n收尾");
  });

  it("缩进续行不切开", () => {
    const text = ["- 项目", "", "  续行说明", "", "另一段", "", "收尾"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text);
    expect(stable).toContain("  续行说明");
    expect(tail).toBe("另一段\n\n收尾");
  });

  it("keepUnstable 可以调成 1：只留最后一块", () => {
    const text = ["一", "", "二", "", "三"].join("\n");
    const { stable, tail } = splitMarkdownBlocks(text, 1);
    expect(stable).toBe("一\n\n二\n\n");
    expect(tail).toBe("三");
  });
});
