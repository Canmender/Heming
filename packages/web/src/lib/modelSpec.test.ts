import { describe, expect, it } from "vitest";
import { parseModelSpec, specDraft, specFieldsOfYours, specHasValues } from "./modelSpec.js";

const OUTPUT = [
  "deepseek/deepseek-flash",
  "  context    1048576            the vendor's list / models.dev",
  "  max output 393216             the vendor's list / models.dev",
  "  vision     on                 the vendor's list / models.dev",
  "  reasoning  none,low,high,max  the vendor's list / models.dev",
].join("\n");

describe("模型规格回读", () => {
  it("四项都读得出来；厂商清单给的值不算「你设的」", () => {
    const spec = parseModelSpec(OUTPUT);
    expect(specHasValues(spec)).toBe(true);
    expect(spec.context).toEqual({ value: "1048576", yours: false });
    expect(spec.output).toEqual({ value: "393216", yours: false });
    expect(spec.vision).toEqual({ value: "on", yours: false });
    expect(spec.reasoning).toEqual({ value: "none,low,high,max", yours: false });
    expect(specFieldsOfYours(spec)).toEqual([]);
  });

  it("自己设过的值标出来（yours / yours for every model of …）", () => {
    const spec = parseModelSpec(
      [
        "\u001b[1mrelay/claude-opus\u001b[0m",
        "  context    200000             yours · --context auto goes back to the vendor's list",
        "  max output 8192               yours for every model of relay",
        "  vision     off                neither the vendor's list nor models.dev says · --vision sets it",
        "  reasoning  off                yours · --reasoning auto goes back to the vendor's list",
      ].join("\n"),
    );
    expect(spec.context?.yours).toBe(true);
    expect(spec.output?.yours).toBe(true);
    expect(spec.vision?.yours).toBe(false);
    expect(spec.reasoning?.yours).toBe(true);
    expect(specFieldsOfYours(spec)).toEqual(["窗口", "最大输出", "思考档"]);
  });

  it("空输出或听不懂的行不编造：返回空规格，草稿保持原样", () => {
    expect(specHasValues(parseModelSpec(""))).toBe(false);
    expect(specDraft(parseModelSpec("magpie: unknown command"))).toBeNull();
  });

  it("草稿：窗口/输出/思考档照搬，reasoning off 表示不发字段", () => {
    expect(specDraft(parseModelSpec(OUTPUT))).toEqual({
      context: "1048576",
      output: "393216",
      efforts: "none,low,high,max",
      vision: true,
    });
    const off = specDraft(
      parseModelSpec(
        ["x/y", "  vision     off   the vendor's list / models.dev", "  reasoning  off   yours"].join("\n"),
      ),
    );
    expect(off).toMatchObject({ efforts: "", vision: false });
  });
});
