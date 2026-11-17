import { describe, expect, it } from "vitest";
import { buildSearchRows, excerptAround, findMessageHits, hitPosition, stepHit } from "./search.js";

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

describe("命中摘要（d.235）", () => {
  it("换行压成空格，在压平后的文本里重新定位关键词（不按原始下标切）", () => {
    const text = `开场白${"很长的一段铺垫内容".repeat(4)}\n\n\n第二行    发布计划 在这里\n第三行补充${"，再补一段让两端都超出".repeat(3)}`;
    const excerpt = excerptAround(text, "发布");
    expect(excerpt).not.toContain("\n");
    expect(excerpt).toContain("发布");
    // 两端都还有内容 → 两边都补省略号
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("命中在开头/结尾时只补一侧省略号", () => {
    const text = `发布计划在这里${"，后面还有很长的补充说明文字".repeat(4)}`;
    const atStart = excerptAround(text, "发布");
    expect(atStart.startsWith("…")).toBe(false);
    expect(atStart.endsWith("…")).toBe(true);

    const tailText = `${"前面的铺垫内容".repeat(6)}最后才提到发布`;
    const atEnd = excerptAround(tailText, "发布");
    expect(atEnd.startsWith("…")).toBe(true);
    expect(atEnd.endsWith("…")).toBe(false);
  });

  it("空文本 / 找不到关键词都不抛异常，至少给出一段可读文字", () => {
    expect(excerptAround("", "发布")).toBe("");
    expect(excerptAround("   \n  ", "发布")).toBe("");
    expect(excerptAround("短消息", "不存在的词")).toBe("短消息");
    expect(excerptAround("短消息", "")).toBe("短消息");
  });

  it("buildSearchRows 保持命中顺序，附上次数，跳过已撤回的时间线文本", () => {
    const rows = buildSearchRows(messages, findMessageHits(messages, "发布"), "发布");
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(rows[0]?.excerpt).toContain("发布");
    expect(rows[1]?.count).toBe(2);
    // 撤回的那条不进结果
    expect(rows.some((r) => r.id === "m4")).toBe(false);
  });

  it("空查询或空命中返回空列表（界面据此不渲染面板）", () => {
    expect(buildSearchRows(messages, findMessageHits(messages, "发布"), "")).toEqual([]);
    expect(buildSearchRows(messages, [], "发布")).toEqual([]);
  });
});
