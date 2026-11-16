import { describe, it, expect } from "vitest";
import { createSteerQueue } from "./steer.js";

const item = (text: string) => ({ text, mentions: [{ agentId: "a1", name: "和小鸣" }] });

describe("steer 插话队列", () => {
  it("入队给条数，take 按先进先出取走全部正文并清空", () => {
    const q = createSteerQueue();
    expect(q.push(item("先跑测试"))).toBe(1);
    expect(q.push(item("别改文件了"))).toBe(2);
    expect(q.size()).toBe(2);
    expect(q.take()).toEqual(["先跑测试", "别改文件了"]);
    // 取走即清空：避免同一条话在下一个工具轮被重复注入
    expect(q.size()).toBe(0);
    expect(q.take()).toEqual([]);
  });

  it("空白正文不入队（按住回车只发空格不该占掉一步）", () => {
    const q = createSteerQueue();
    expect(q.push(item("   "))).toBe(0);
    expect(q.push(item("\n\t"))).toBe(0);
    expect(q.size()).toBe(0);
    q.push(item("真话"));
    expect(q.pending()).toHaveLength(1);
  });

  it("正文入队时去首尾空白", () => {
    const q = createSteerQueue();
    q.push(item("  先跑测试 "));
    expect(q.pending()[0].text).toBe("先跑测试");
  });

  it("shift 一次只取一条（收尾后另起一轮用它，剩下的留到下一轮）", () => {
    const q = createSteerQueue();
    q.push(item("甲"));
    q.push(item("乙"));
    expect(q.shift()).toMatchObject({ text: "甲" });
    expect(q.size()).toBe(1);
    expect(q.shift()).toMatchObject({ text: "乙" });
    expect(q.shift()).toBeUndefined();
  });

  it("pending 返回拷贝：外面改数组不影响队列里的条目", () => {
    const q = createSteerQueue();
    q.push(item("甲"));
    const list = q.pending();
    list.pop();
    expect(q.size()).toBe(1);
    expect(q.pending().map((i) => i.text)).toEqual(["甲"]);
  });

  it("clear 清空（切会话时轮次已经不属于原来那段对话）", () => {
    const q = createSteerQueue();
    q.push(item("甲"));
    q.push(item("乙"));
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.take()).toEqual([]);
  });
});
