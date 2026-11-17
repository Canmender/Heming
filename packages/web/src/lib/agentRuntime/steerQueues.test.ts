import { describe, expect, it } from "vitest";
import { createSteerQueueRegistry } from "./steerQueues.js";

describe("按会话分的插话队列（d.226）", () => {
  it("两个会话各排各的，谁也取不走对方的话", () => {
    const registry = createSteerQueueRegistry();
    registry.of("c1").push({ text: "先跑测试", mentions: [] });
    registry.of("c2").push({ text: "别改那份文件", mentions: [] });

    expect(registry.of("c2").take()).toEqual(["别改那份文件"]);
    // c1 的那条还在：共享一个队列时，这里会拿到 c1 的话（或者反过来被 c1 抢走）
    expect(registry.of("c1").pending().map((item) => item.text)).toEqual(["先跑测试"]);
    expect(registry.of("c2").size()).toBe(0);
  });

  it("同一会话取回同一个实例：排队不会因为再取一次就丢", () => {
    const registry = createSteerQueueRegistry();
    expect(registry.of("c1")).toBe(registry.of("c1"));
    registry.of("c1").push({ text: "接着做", mentions: [] });
    expect(registry.of("c1").size()).toBe(1);
  });

  it("按会话清：只清指定的那个，别的会话还在排队", () => {
    const registry = createSteerQueueRegistry();
    registry.of("c1").push({ text: "a", mentions: [] });
    registry.of("c2").push({ text: "b", mentions: [] });

    registry.clear("c1");
    expect(registry.of("c1").size()).toBe(0);
    expect(registry.of("c2").size()).toBe(1);
    expect(registry.size()).toBe(2);
  });

  it("不给 id 就全清", () => {
    const registry = createSteerQueueRegistry();
    registry.of("c1").push({ text: "a", mentions: [] });
    registry.of("c2").push({ text: "b", mentions: [] });

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.of("c1").size()).toBe(0);
    expect(registry.of("c2").size()).toBe(0);
  });
});
