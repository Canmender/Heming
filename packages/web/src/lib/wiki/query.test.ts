import { describe, expect, it } from "vitest";
import { CJK_COVERAGE, matchTerm, tokenizeQuery } from "./query.js";

/**
 * wiki 查询分词（d.35 · P1-5）。
 *
 * 这层是纯函数：分词与匹配强度在这里钉死，`searchPages` 只负责组合与排序。
 */
describe("tokenizeQuery", () => {
  it("ASCII 词整词保留（与旧版行为一致）", () => {
    const terms = tokenizeQuery("deploy Rollback");
    expect(terms.map((t) => t.text)).toEqual(["deploy", "rollback"]);
    expect(terms.every((t) => !t.coverage && t.units.length === 1)).toBe(true);
  });

  it("按空白与中英文标点切段", () => {
    expect(tokenizeQuery("预算, 风险。部署；回滚").map((t) => t.text)).toEqual([
      "预算",
      "风险",
      "部署",
      "回滚",
    ]);
  });

  it("CJK 长度 ≤ 2 不展开", () => {
    const [term] = tokenizeQuery("预算");
    expect(term.text).toBe("预算");
    expect(term.coverage).toBe(false);
    expect(term.units).toEqual(["预算"]);
  });

  it("CJK 长词展开相邻二元组", () => {
    const [term] = tokenizeQuery("项目预算风险");
    expect(term.coverage).toBe(true);
    expect(term.units).toEqual(["项目", "目预", "预算", "算风", "风险"]);
  });

  it("中英混合各自处理", () => {
    const terms = tokenizeQuery("部署 deploy 流程");
    expect(terms.map((t) => t.text)).toEqual(["部署", "deploy", "流程"]);
    expect(terms[0].coverage).toBe(false); // 两个汉字
    expect(terms[2].coverage).toBe(false);
  });

  it("空串与纯标点 → 空数组", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("  ,，。 ")).toEqual([]);
  });
});

describe("matchTerm", () => {
  it("整词命中强度为 1", () => {
    const [term] = tokenizeQuery("预算");
    expect(matchTerm(term, "本季度的预算与风险")).toBe(1);
  });

  it("CJK 长词允许覆盖率命中（文档写作「预算与风险」）", () => {
    const [term] = tokenizeQuery("预算风险"); // 二元组：预算 / 算风 / 风险
    // 「预算与风险」命中 预算 + 风险 = 2/3 ≥ 60%
    expect(matchTerm(term, "预算与风险")).toBeGreaterThanOrEqual(CJK_COVERAGE);
  });

  it("覆盖率不足 → 不命中", () => {
    const [term] = tokenizeQuery("预算风险"); // 三个二元组，只命中一个 = 1/3
    expect(matchTerm(term, "预算说明")).toBe(0);
  });

  it("ASCII 词不做覆盖率匹配（只认整词）", () => {
    const [term] = tokenizeQuery("deploy");
    expect(matchTerm(term, "deployment")).toBe(1); // includes 语义：子串算命中（与旧版一致）
    expect(matchTerm(term, "de ploy")).toBe(0);
  });

  it("空文本不命中", () => {
    const [term] = tokenizeQuery("预算");
    expect(matchTerm(term, "")).toBe(0);
  });
});
