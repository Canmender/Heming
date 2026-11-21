import { describe, expect, it } from "vitest";

import type { SourceShowFlags } from "./magpieSourceShow.js";
import {
  SOURCE_WIRE_FIELDS,
  describeWireFlags,
  sourceWireCommand,
  sourceWirePairs,
} from "./magpieSourceWire.js";

/** 什么都没设的现状。 */
const BLANK: SourceShowFlags = {
  headers: [],
  free: false,
  unmasked: false,
  refreshEvery: "",
  autoInclude: [],
  searches: false,
  nativeCompaction: false,
  magpieUserAgent: false,
};

describe("来源的端专用开关（搜索 / 压缩 / User-Agent）", () => {
  it("三个字段的键顺序固定且不重复", () => {
    expect(SOURCE_WIRE_FIELDS.map((field) => field.key)).toEqual(["userAgent", "search", "compaction"]);
  });

  it("只发填过的项，顺序固定", () => {
    expect(sourceWirePairs({ compaction: "native", userAgent: "agent" })).toEqual([
      "user-agent=agent",
      "compaction=native",
    ]);
    expect(sourceWirePairs({})).toEqual([]);
  });

  it("填了不认识的值不发（下拉只有那几项，挡住手改）", () => {
    expect(sourceWirePairs({ search: "maybe" })).toEqual([]);
  });

  it("三项合成一条 provider set；没填或没 id 是 null", () => {
    expect(
      sourceWireCommand("mock", { userAgent: "magpie", search: "yes", compaction: "native" }),
    ).toEqual(["provider", "set", "mock", "user-agent=magpie", "search=yes", "compaction=native"]);
    expect(sourceWireCommand("mock", {})).toBeNull();
    expect(sourceWireCommand("  ", { search: "yes" })).toBeNull();
    // 带首尾空白的 id 要 trim 后再下发，与兄弟命令一致（d.412 回归）。
    expect(sourceWireCommand("  mock  ", { search: "yes" })).toEqual([
      "provider", "set", "mock", "search=yes",
    ]);
  });

  it("现状那一句：UA 总要说，另外两个只在设过时说", () => {
    expect(describeWireFlags(BLANK)).toBe("带智能体的 UA");
    expect(describeWireFlags({ ...BLANK, searches: true, nativeCompaction: true })).toBe(
      "带智能体的 UA；搜索由来源做；压缩交给来源",
    );
    expect(describeWireFlags({ ...BLANK, magpieUserAgent: true })).toBe("带和鸣的 UA");
  });
});
