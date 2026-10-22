import { describe, it, expect } from "vitest";
import { matchUsage } from "./attribution.js";
import type { InjectedItem } from "./format.js";

const item = (
  id: string,
  content: string,
  layer: InjectedItem["layer"] = "semantic",
  truncated = false,
): InjectedItem => ({ id, layer, content, truncated });

describe("matchUsage：确定性字符串级判定", () => {
  it("回答里出现同一条记忆的两个不同词才算疑似引用", () => {
    const injected = [item("s1", "部署端口：默认 8787，发布前确认")];
    expect(matchUsage("发布前先确认端口设置", injected).map((m) => m.id)).toEqual(["s1"]);
  });

  it("只命中一个二字词太容易撞，判为未引用", () => {
    const injected = [item("s1", "偏好-语言：默认使用简体中文")];
    expect(matchUsage("今天天气不错", injected)).toEqual([]);
    // 只共享「默认」这一个二字词：可能是巧合，不算引用
    expect(matchUsage("默认设置里改一下", injected)).toEqual([]);
  });

  it("单个长词（ASCII 词或数字）几乎不会白撞，一次命中即算", () => {
    expect(matchUsage("服务保持 8787 就行", [item("s1", "部署端口：默认 8787")]).map((m) => m.id)).toEqual([
      "s1",
    ]);
    expect(matchUsage("用 React 写就行", [item("s1", "偏好-框架：React")]).map((m) => m.id)).toEqual(["s1"]);
  });

  it("工作层与聚合焦点行不参与判定：恒命中等于没有信息量", () => {
    const injected = [
      item("w1", "用户：部署端口是多少", "working"),
      item("focus", "焦点：部署端口是多少", "working"),
      item("s1", "部署端口：默认 8787"),
    ];
    const out = matchUsage("部署端口是 8787", injected);
    expect(out.map((m) => m.id)).toEqual(["s1"]);
  });

  it("情景行的日期前缀是排版产物，不参与命中", () => {
    const injected = [item("e1", "2026-10-16：讨论了发布计划的回归范围", "episodic")];
    // 只提到日期的回答不该因为「2026」「10」「16」而判成引用（前两个是长词，单独就可能误判）
    expect(matchUsage("2026 年 10 月 16 日有什么安排", injected)).toEqual([]);
    expect(matchUsage("发布计划的回归范围还要再确认", injected).map((m) => m.id)).toEqual(["e1"]);
  });

  it("比对的是截断后的实际注入文本：模型没看到的半句不算命中", () => {
    const injected = [item("s1", "发布计划：每次安排在周四并留出回归时间", "semantic", true)];
    // content 已被预算裁掉后半段，回答里复述的「回归时间」不在注入文本里
    const truncatedOnly = [item("s1", "发布计划：每次安排在周四", "semantic", true)];
    expect(matchUsage("回归时间还是要留", truncatedOnly)).toEqual([]);
    expect(matchUsage("回归时间还是要留", injected).map((m) => m.id)).toEqual(["s1"]);
  });

  it("命中词最多留 6 个，供 UI 解释判定依据", () => {
    const injected = [item("s1", "发布 计划 回归 排期 确认 端口 预算 覆盖")];
    const out = matchUsage("发布 计划 回归 排期 确认 端口 预算 覆盖", injected);
    expect(out).toHaveLength(1);
    expect(out[0].hits).toHaveLength(6);
    expect(out[0].layer).toBe("semantic");
  });

  it("空回答或纯标点回答一律不命中", () => {
    const injected = [item("s1", "部署端口：默认 8787")];
    expect(matchUsage("", injected)).toEqual([]);
    expect(matchUsage("，。！？", injected)).toEqual([]);
  });
});
