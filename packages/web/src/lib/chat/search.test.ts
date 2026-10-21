import { describe, expect, it } from "vitest";
import { findMessageHits, hitPosition, stepHit } from "./search.js";

const messages = [
  { id: "m1", text: "今天开会讨论发布计划" },
  { id: "m2", text: "发布前要回归，发布后要观察" },
  { id: "m3", text: "无关内容" },
  { id: "m4", text: "已撤回的发布消息", recalled: true },
];

describe("会话内搜索", () => {
  it("大小写不敏感，按消息顺序返回，跳过撤回消息", () => {
    const hits = findMessageHits(
      [
        { id: "a", text: "Deploy 计划" },
        { id: "b", text: "deploy 完成" },
        { id: "c", text: "deploy 已撤回", recalled: true },
      ],
      "DEPLOY",
    );
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("统计每条消息里的出现次数", () => {
    const hits = findMessageHits(messages, "发布");
    expect(hits).toEqual([
      { id: "m1", index: 6, count: 1 },
      { id: "m2", index: 0, count: 2 },
    ]);
  });

  it("空串 / 全空白不产生命中", () => {
    expect(findMessageHits(messages, "")).toEqual([]);
    expect(findMessageHits(messages, "   ")).toEqual([]);
  });

  it("stepHit 循环前后跳转；当前不在命中里时从第一条开始", () => {
    const hits = findMessageHits(messages, "发布");

    expect(stepHit(hits, null, 1)?.id).toBe("m1");
    expect(stepHit(hits, "m1", 1)?.id).toBe("m2");
    expect(stepHit(hits, "m2", 1)?.id).toBe("m1");
    expect(stepHit(hits, "m1", -1)?.id).toBe("m2");
    expect(stepHit([], null, 1)).toBeNull();
    expect(hitPosition(hits, "m3")).toBe(-1);
  });
});
