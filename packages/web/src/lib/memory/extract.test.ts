import { describe, it, expect } from "vitest";
import { deterministicSummary, extractExplicitMemory, normalizeKey } from "./extract.js";
import { MemoryStore } from "./store.js";
import type { StorageLike } from "./types.js";

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("extractExplicitMemory：显式指令识别", () => {
  it("「记住：X」且 X 是「我的X是Y」→ 主题键归一化", () => {
    expect(extractExplicitMemory("记住：我的称呼是阿和")).toEqual({ key: "称呼", value: "阿和" });
    expect(extractExplicitMemory("记住，我的名字叫张三。")).toEqual({ key: "名字", value: "张三" });
  });

  it("「记住 X」无冒号也识别，未带事实结构时以整句为键值", () => {
    const hit = extractExplicitMemory("记住 我下周三要去北京开会");
    expect(hit).not.toBeNull();
    expect(hit!.value).toBe("我下周三要去北京开会");
    expect(hit!.key).toBe("我下周三要去北京开会");
  });

  it("「以后都 X」→ 偏好键；涉语言时用 偏好-语言", () => {
    expect(extractExplicitMemory("以后都用简体中文回复")).toEqual({ key: "偏好-语言", value: "用简体中文回复" });
    expect(extractExplicitMemory("以后都别用 emoji")).toEqual({ key: "偏好", value: "别用 emoji" });
    expect(extractExplicitMemory("记住：以后一律用英文回答")).toEqual({ key: "偏好-语言", value: "用英文回答" });
  });

  it("「我的X是Y」无需「记住」也识别（是/叫/为/＝ 同义）", () => {
    expect(extractExplicitMemory("我的称呼是阿和")).toEqual({ key: "称呼", value: "阿和" });
    expect(extractExplicitMemory("我的常用语言为简体中文")).toEqual({ key: "常用语言", value: "简体中文" });
    expect(extractExplicitMemory("我的邮箱＝a@b.com")).toEqual({ key: "邮箱", value: "a@b.com" });
  });

  it("非指令文本一律 null（问句、日常陈述、空串）", () => {
    expect(extractExplicitMemory("今天天气不错")).toBeNull();
    expect(extractExplicitMemory("我下周想去北京")).toBeNull();
    expect(extractExplicitMemory("记住了吗")).toBeNull();
    expect(extractExplicitMemory("记住")).toBeNull();
    expect(extractExplicitMemory("我的称呼是阿和？")).toBeNull();
    expect(extractExplicitMemory("")).toBeNull();
  });

  it("键截断到 24 字、值截断到 500 字", () => {
    const hit = extractExplicitMemory(`记住：这是一段特别长的内容用来测试键长度的截断行为是否生效并且远超过二十四个字`);
    expect(hit).not.toBeNull();
    expect(hit!.key.length).toBeLessThanOrEqual(24);
    const long = extractExplicitMemory(`记住：我的偏好是${"细".repeat(900)}`);
    expect(long!.value.length).toBeLessThanOrEqual(500);
  });

  it("normalizeKey 压缩空白并去首尾标点", () => {
    expect(normalizeKey("  偏好-语言  ")).toBe("偏好-语言");
    expect(normalizeKey(":称呼，")).toBe("称呼");
  });
});

describe("deterministicSummary：确定性摘要（无 LLM）", () => {
  it("用户首问 + 助手回答前 160 字 + 关键词", () => {
    const summary = deterministicSummary("讨论发布计划", "结论是周五前完成回归");
    expect(summary).toContain("用户：讨论发布计划");
    expect(summary).toContain("助手：结论是周五前完成回归");
    expect(summary).toContain("关键词：");
    expect(summary).toContain("讨论");
  });

  it("助手回答截断到 160 字、整条摘要不超过 400 字", () => {
    const summary = deterministicSummary("问题".repeat(300), "答".repeat(900));
    const answer = summary.split("助手：")[1].split("｜")[0];
    expect(answer.length).toBeLessThanOrEqual(160);
    expect(summary.length).toBeLessThanOrEqual(400);
    const question = summary.split("用户：")[1].split("｜")[0];
    expect(question.length).toBeLessThanOrEqual(120);
  });

  it("无助手文本时只留用户与关键词", () => {
    const summary = deterministicSummary("讨论发布计划", "");
    expect(summary).toContain("用户：");
    expect(summary).not.toContain("助手：");
  });

  it("输入为空时返回空串", () => {
    expect(deterministicSummary("", "")).toBe("");
  });
});

describe("显式指令写入语义记忆（recordTurn 管道）", () => {
  it("命中即入库：source=explicit、confidence=0.9，重复指令更新同键", () => {
    const store = new MemoryStore(new FakeStorage(), () => new Date("2026-10-17T08:00:00.000Z").getTime());
    store.recordTurn("agent-1", "conv-1", "记住：我的称呼是阿和", "好的，阿和");
    let list = store.semantic("agent-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "称呼", value: "阿和", source: "explicit", confidence: 0.9 });

    store.recordTurn("agent-1", "conv-1", "记住：我的称呼是小鸣", "好的，小鸣");
    list = store.semantic("agent-1");
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("小鸣");
  });

  it("普通对话不产生语义记忆", () => {
    const store = new MemoryStore(new FakeStorage(), () => Date.now());
    store.recordTurn("agent-1", "conv-1", "帮我看下这段代码", "这段代码有三处问题");
    expect(store.semantic("agent-1")).toEqual([]);
  });
});
