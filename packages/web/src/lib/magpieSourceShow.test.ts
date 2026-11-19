import { describe, expect, it } from "vitest";

import { describeShowFlags, headersToText, parseSourceShow } from "./magpieSourceShow.js";

const show = [
  "  Zhipu  zhipu",
  "  chat       https://open.bigmodel.cn/api/paas/v4",
  "  unmasked   yes  Settings' redaction leaves its requests as written",
  "  free       yes  counted free by Free first and Cheapest routing; prices and Usage's costs stay as listed",
  "  header     X-Trace: abc",
  "  header     X-Team: data",
  "  refresh    every 6h  the gateway fetches its list by itself",
  "  include    claude-* gpt-4o*  newly listed models these match are exposed",
  "  models     2 exposed of 2 from models.dev",
].join("\n");

describe("读回来源现状", () => {
  it("请求头、算免费、原文照发、刷新间隔、自动收都能读出来", () => {
    const flags = parseSourceShow(show);
    expect(flags.headers).toEqual([
      { name: "X-Trace", value: "abc" },
      { name: "X-Team", value: "data" },
    ]);
    expect(flags.free).toBe(true);
    expect(flags.unmasked).toBe(true);
    expect(flags.refreshEvery).toBe("6h");
    expect(flags.autoInclude).toEqual(["claude-*", "gpt-4o*"]);
  });

  it("什么也没设时全是空值，不抛异常", () => {
    const flags = parseSourceShow("  Zhipu  zhipu\n  chat  https://x\n  models  0 exposed of 0\n");
    expect(flags.headers).toEqual([]);
    expect(flags.free).toBe(false);
    expect(flags.unmasked).toBe(false);
    expect(flags.refreshEvery).toBe("");
    expect(flags.autoInclude).toEqual([]);
  });

  it("值是空的请求头也读得出来（那是「删掉这个头」留下的痕迹）", () => {
    expect(parseSourceShow("  header     X-Old:\n").headers).toEqual([{ name: "X-Old", value: "" }]);
  });

  it("header 的值里带冒号不影响名字", () => {
    expect(parseSourceShow("  header     Authorization: Bearer a:b\n").headers).toEqual([
      { name: "Authorization", value: "Bearer a:b" },
    ]);
  });

  it("搜索、压缩、User-Agent 这三行也读得出来", () => {
    const flags = parseSourceShow(
      [
        "  chat       https://x",
        "  search     by itself  a client's web search goes to it as sent",
        "  compaction native  Codex's own, sealed by the key or account that answers it",
        "  user-agent magpie's  not the one the agent gave",
      ].join("\n"),
    );
    expect(flags.searches).toBe(true);
    expect(flags.nativeCompaction).toBe(true);
    expect(flags.magpieUserAgent).toBe(true);
    expect(parseSourceShow("  chat  https://x  ").searches).toBe(false);
  });

  it("还原成多行文本时一行一个", () => {
    expect(headersToText([{ name: "X-A", value: "1" }, { name: "X-B", value: "" }])).toBe(
      "X-A: 1\nX-B: ",
    );
  });

  it("现状一句话：设了什么说什么，什么都没设就是空串", () => {
    expect(
      describeShowFlags({
        headers: [{ name: "X-Trace", value: "abc" }],
        free: true,
        unmasked: false,
        refreshEvery: "6h",
        autoInclude: ["claude-*"],
        searches: false,
        nativeCompaction: false,
        magpieUserAgent: false,
      }),
    ).toBe("请求头 X-Trace；算免费；每 6h 刷清单；自动收 claude-*");
    expect(
      describeShowFlags({
        headers: [],
        free: false,
        unmasked: false,
        refreshEvery: "",
        autoInclude: [],
        searches: false,
        nativeCompaction: false,
        magpieUserAgent: false,
      }),
    ).toBe("");
  });
});
