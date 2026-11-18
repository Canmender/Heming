import { describe, expect, it } from "vitest";
import {
  describeRegenerateConfirm,
  planRegenerate,
  type RegenerateMessage,
} from "./regenerate.js";

function user(id: string, text: string, file?: { id: string; name: string }): RegenerateMessage {
  return { id, senderType: "user", payload: file ? { text, file } : { text } };
}

function agent(id: string, text: string): RegenerateMessage {
  return { id, senderType: "agent", payload: { text } };
}

describe("planRegenerate", () => {
  it("最后一轮：删掉提问与回答，重发那句提问", () => {
    const messages = [user("m1", "把登录改成扫码"), agent("m2", "改好了")];
    const result = planRegenerate(messages, "m2");
    expect(result).toEqual({
      ok: true,
      plan: { prompt: "把登录改成扫码", ids: ["m1", "m2"], later: 0 },
    });
  });

  it("夹在中间的回答：把后面的消息一并算进去，later 数给界面提示", () => {
    const messages = [
      user("m1", "第一问"),
      agent("m2", "第一答"),
      user("m3", "第二问"),
      agent("m4", "第二答"),
      user("m5", "第三问"),
    ];
    const result = planRegenerate(messages, "m2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.prompt).toBe("第一问");
    expect(result.plan.ids).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(result.plan.later).toBe(3);
  });

  it("提问前面还有别的轮次：不动它们", () => {
    const messages = [
      user("m1", "更早的提问"),
      agent("m2", "更早的回答"),
      user("m3", "这一问"),
      agent("m4", "这一答"),
    ];
    const result = planRegenerate(messages, "m4");
    expect(result.ok && result.plan.ids).toEqual(["m3", "m4"]);
  });

  it("中间夹着工具轨迹（非 user 非目标）：往回找到最近那句提问", () => {
    const messages = [user("m1", "跑一下测试"), agent("m2", "…"), agent("m3", "工具结果之后的回答")];
    const result = planRegenerate(messages, "m3");
    expect(result.ok && result.plan.prompt).toBe("跑一下测试");
    expect(result.ok && result.plan.ids).toEqual(["m1", "m2", "m3"]);
  });

  it("提问前后空白：重发的是 trim 过的版本", () => {
    const messages = [user("m1", "  看看这个报错\n\n"), agent("m2", "…")];
    const result = planRegenerate(messages, "m2");
    expect(result.ok && result.plan.prompt).toBe("看看这个报错");
  });

  it("用户消息不能当重答目标", () => {
    const result = planRegenerate([user("m1", "问题"), agent("m2", "回答")], "m1");
    expect(result).toEqual({ ok: false, reason: "重答只对它的回答用：选它下面那条。" });
  });

  it("找不到消息：说清是本地镜像的问题", () => {
    const result = planRegenerate([user("m1", "问题")], "nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("已经不在本地");
  });

  it("前面没有提问（开场白）：不假装能重答", () => {
    const result = planRegenerate([agent("m1", "你好，我是助手")], "m1");
    expect(result).toEqual({
      ok: false,
      reason: "这条前面没有你的提问（开场白或系统消息），没法重答。",
    });
  });

  it("带附件的提问：拒绝，避免重发时把文件丢掉", () => {
    const result = planRegenerate(
      [user("m1", "看看这个文件", { id: "f1", name: "a.csv" }), agent("m2", "…")],
      "m2",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("附件");
  });

  it("空提问：拒绝", () => {
    const result = planRegenerate([user("m1", "   "), agent("m2", "…")], "m2");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("空的");
  });
});

describe("describeRegenerateConfirm", () => {
  it("最后一轮：只说撤掉这一答", () => {
    const text = describeRegenerateConfirm({ prompt: "q", ids: ["m1", "m2"], later: 0 });
    expect(text).toBe("把这个回答撤掉，用同一句提问重新答一次？");
  });

  it("后面还有消息：把会删几条说具体", () => {
    const text = describeRegenerateConfirm({ prompt: "q", ids: ["m1", "m2", "m3"], later: 3 });
    expect(text).toContain("后面还有 3 条消息");
    expect(text).toContain("继续？");
  });
});
