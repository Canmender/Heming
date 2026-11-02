import { describe, expect, it } from "vitest";
import { parsePetEvent } from "./petEvent.js";

describe("事件校验 · 合法载荷", () => {
  it("pose：认得的姿态放行", () => {
    expect(parsePetEvent({ kind: "pose", pose: "speaking" })).toEqual({ kind: "pose", pose: "speaking" });
  });

  it("pose：不认得的姿态拒绝（不是字符串 / 不在表里）", () => {
    expect(parsePetEvent({ kind: "pose", pose: "dancing" })).toBeNull();
    expect(parsePetEvent({ kind: "pose", pose: 42 })).toBeNull();
    expect(parsePetEvent({ kind: "pose" })).toBeNull();
  });

  it("speak：去首尾空白", () => {
    expect(parsePetEvent({ kind: "speak", text: "  早报来了  " })).toEqual({
      kind: "speak",
      text: "早报来了",
    });
  });

  it("speak：空白文本拒绝（空气泡等于没说话）", () => {
    expect(parsePetEvent({ kind: "speak", text: "   " })).toBeNull();
    expect(parsePetEvent({ kind: "speak", text: 123 })).toBeNull();
  });

  it("speak：超长文本截断并加省略号", () => {
    const long = "啊".repeat(300);
    const out = parsePetEvent({ kind: "speak", text: long });
    expect(out).not.toBeNull();
    expect((out as { text: string }).text.length).toBe(201); // 200 + 省略号
    expect((out as { text: string }).text.endsWith("…")).toBe(true);
  });

  it("task：ok 只认严格 true", () => {
    expect(parsePetEvent({ kind: "task", title: "导出完成", ok: true })).toEqual({
      kind: "task",
      title: "导出完成",
      ok: true,
    });
    expect(parsePetEvent({ kind: "task", title: "导出失败" })).toEqual({
      kind: "task",
      title: "导出失败",
      ok: false,
    });
    expect(parsePetEvent({ kind: "task", title: "x", ok: "true" })).toEqual({
      kind: "task",
      title: "x",
      ok: false,
    });
  });

  it("schedule：标题与时间都要有", () => {
    expect(parsePetEvent({ kind: "schedule", title: "晚自习", at: "19:00" })).toEqual({
      kind: "schedule",
      title: "晚自习",
      at: "19:00",
    });
    expect(parsePetEvent({ kind: "schedule", title: "晚自习" })).toBeNull();
    expect(parsePetEvent({ kind: "schedule", at: "19:00" })).toBeNull();
  });

  it("reset：无字段也成立", () => {
    expect(parsePetEvent({ kind: "reset" })).toEqual({ kind: "reset" });
  });
});

describe("事件校验 · 畸形载荷一律返回 null（桌宠没有控制台，不能抛）", () => {
  it("非对象 / 数组 / 空", () => {
    for (const bad of [null, undefined, 0, "", "pose", [], [1, 2], true]) {
      expect(parsePetEvent(bad)).toBeNull();
    }
  });

  it("缺 kind / kind 不认识", () => {
    expect(parsePetEvent({})).toBeNull();
    expect(parsePetEvent({ kind: "unknown" })).toBeNull();
    expect(parsePetEvent({ kind: 123 })).toBeNull();
  });

  it("多余字段被丢弃（不透传，避免把未知数据带进渲染层）", () => {
    const out = parsePetEvent({ kind: "speak", text: "hi", evil: "<script>" });
    expect(out).toEqual({ kind: "speak", text: "hi" });
  });
});
