/**
 * 子代理写盘授权（d.202）：只测数据口径与安全默认。
 *
 * 这个开关是「无人看守的写路径」的唯一闸门，所以断言的是一组安全性质：
 * 缺省关闭、按会话隔离、坏数据当没开、清空后回到关闭。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  SUBAGENT_WRITE_KEY,
  isSubagentWriteEnabled,
  listSubagentWriteConversations,
  resetSubagentWriteStore,
  setSubagentWriteEnabled,
  toggleSubagentWrite,
} from "./subagentWrite.js";

beforeEach(() => {
  localStorage.clear();
  resetSubagentWriteStore();
});

describe("子代理写盘授权", () => {
  it("缺省是关闭的（安全默认）", () => {
    expect(isSubagentWriteEnabled("c1")).toBe(false);
    expect(isSubagentWriteEnabled("")).toBe(false);
  });

  it("打开后读得到，关掉后读不到", () => {
    expect(setSubagentWriteEnabled("c1", true)).toBe(true);
    expect(isSubagentWriteEnabled("c1")).toBe(true);
    expect(setSubagentWriteEnabled("c1", false)).toBe(false);
    expect(isSubagentWriteEnabled("c1")).toBe(false);
  });

  it("按会话隔离：给 A 打开不会顺延到 B", () => {
    setSubagentWriteEnabled("c1", true);
    expect(isSubagentWriteEnabled("c2")).toBe(false);
    expect(listSubagentWriteConversations()).toEqual(["c1"]);
  });

  it("toggle 来回切并返回新值", () => {
    expect(toggleSubagentWrite("c1")).toBe(true);
    expect(isSubagentWriteEnabled("c1")).toBe(true);
    expect(toggleSubagentWrite("c1")).toBe(false);
    expect(isSubagentWriteEnabled("c1")).toBe(false);
  });

  it("落 localStorage 后重开能读回（同一把键）", () => {
    setSubagentWriteEnabled("c1", true);
    const raw = localStorage.getItem(SUBAGENT_WRITE_KEY) ?? "";
    expect(raw).toContain("c1");
    expect(JSON.parse(raw)).toEqual({ c1: true });
  });

  it("坏数据当成没开，不崩也不放行", () => {
    localStorage.setItem(SUBAGENT_WRITE_KEY, "{not json");
    expect(isSubagentWriteEnabled("c1")).toBe(false);
    localStorage.setItem(SUBAGENT_WRITE_KEY, JSON.stringify({ c1: "yes", c2: true }));
    expect(isSubagentWriteEnabled("c1")).toBe(false);
    expect(isSubagentWriteEnabled("c2")).toBe(true);
  });

  it("关掉最后一个会话会把键整个删掉，不留空对象", () => {
    setSubagentWriteEnabled("c1", true);
    setSubagentWriteEnabled("c1", false);
    expect(localStorage.getItem(SUBAGENT_WRITE_KEY)).toBeNull();
  });

  it("reset 清空全部授权", () => {
    setSubagentWriteEnabled("c1", true);
    setSubagentWriteEnabled("c2", true);
    resetSubagentWriteStore();
    expect(listSubagentWriteConversations()).toEqual([]);
    expect(isSubagentWriteEnabled("c1")).toBe(false);
  });
});
