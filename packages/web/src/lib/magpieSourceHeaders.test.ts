import { describe, expect, it } from "vitest";

import { headerPairs, parseHeaderLines } from "./magpieSourceHeaders.js";

describe("自定义请求头", () => {
  it("一行一个，冒号后是值", () => {
    expect(parseHeaderLines("X-Trace: abc\nX-Team: data").pairs).toEqual([
      "header.X-Trace=abc",
      "header.X-Team=data",
    ]);
  });

  it("全角冒号、等号、分号隔开都认", () => {
    expect(headerPairs("X-A：1\nX-B=2;X-C:3")).toEqual(["header.X-A=1", "header.X-B=2", "header.X-C=3"]);
  });

  it("值里还能有冒号：只按第一个分隔符切", () => {
    expect(headerPairs("Authorization: Bearer a:b")).toEqual(["header.Authorization=Bearer a:b"]);
  });

  it("值留空就是删掉这个头", () => {
    expect(headerPairs("X-Trace:")).toEqual(["header.X-Trace="]);
  });

  it("缺分隔符或名字带空格的行点出来，其余照发", () => {
    const result = parseHeaderLines("X-Good: 1\n这不是头\nX Bad: 2");
    expect(result.pairs).toEqual(["header.X-Good=1"]);
    expect(result.rejected).toEqual(["这不是头", "X Bad: 2"]);
  });

  it("同一个名字只留最后一个，位置不变", () => {
    expect(headerPairs("X-A: 1\nX-B: 2\nx-a: 3")).toEqual(["header.x-a=3", "header.X-B=2"]);
  });

  it("空文本一对也不发", () => {
    expect(parseHeaderLines("  \n\n").pairs).toEqual([]);
    expect(parseHeaderLines("").rejected).toEqual([]);
  });
});
