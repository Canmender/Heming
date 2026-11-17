/**
 * 会话改动台账（d.210）纯逻辑测试。
 *
 * 重点不是「能存能取」，而是三件会静默出错的事：
 * 1. 同一路径多次改动要累加 writes（「改了几次」是用户判断风险的重要信号）；
 * 2. 快照引用稳定（`useSyncExternalStore` 依赖它，每次返回新数组会无限重渲染）；
 * 3. 坏数据、缺字段、配额失败都要静默降级，不能把收口流程带崩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSessionChanges,
  getSessionChanges,
  recordSessionChanges,
  resetSessionChanges,
  SESSION_CHANGES_KEY,
  SESSION_CHANGES_MAX_FILES,
  SESSION_CHANGES_MAX_SESSIONS,
  subscribeSessionChanges,
} from "./sessionChanges.js";

beforeEach(() => {
  resetSessionChanges();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("会话改动台账（d.210）", () => {
  it("按会话隔离，并给每个文件记下最近改动时间与次数", () => {
    recordSessionChanges("c1", ["/w/a.ts"], 1000);
    recordSessionChanges("c1", ["/w/b.ts"], 2000);
    recordSessionChanges("c2", ["/w/c.ts"], 3000);

    expect(getSessionChanges("c1").map((item) => item.path)).toEqual(["/w/b.ts", "/w/a.ts"]);
    expect(getSessionChanges("c2").map((item) => item.path)).toEqual(["/w/c.ts"]);
    expect(getSessionChanges("c1")[0]).toMatchObject({ path: "/w/b.ts", at: 2000, writes: 1 });
    expect(getSessionChanges("c3")).toEqual([]);
  });

  it("同一文件再改一次：时间刷新、次数累加、不重复出现", () => {
    recordSessionChanges("c1", ["/w/a.ts"], 1000);
    recordSessionChanges("c1", ["/w/a.ts", "/w/a.ts"], 2000);

    const changes = getSessionChanges("c1");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "/w/a.ts", at: 2000, writes: 2 });
  });

  it("空路径与空会话号不入账", () => {
    expect(recordSessionChanges("c1", [])).toBe(0);
    expect(recordSessionChanges("", ["/w/a.ts"])).toBe(0);
    expect(recordSessionChanges("c1", ["", "/w/a.ts"], 1)).toBe(1);
    expect(getSessionChanges("c1")).toHaveLength(1);
  });

  it("快照引用稳定：内容没变就返回同一个数组（useSyncExternalStore 的前提）", () => {
    recordSessionChanges("c1", ["/w/a.ts"], 1000);
    const first = getSessionChanges("c1");
    const second = getSessionChanges("c1");
    expect(second).toBe(first);

    recordSessionChanges("c1", ["/w/a.ts"], 2000);
    expect(getSessionChanges("c1")).not.toBe(first);
  });

  it("订阅只在变更时通知，退订后不再通知", () => {
    const listener = vi.fn();
    const off = subscribeSessionChanges(listener);
    recordSessionChanges("c1", ["/w/a.ts"], 1000);
    expect(listener).toHaveBeenCalledTimes(1);
    clearSessionChanges("c1");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    recordSessionChanges("c1", ["/w/b.ts"], 2000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("清空不存在的会话不通知（避免无意义的界面重算）", () => {
    const listener = vi.fn();
    subscribeSessionChanges(listener);
    clearSessionChanges("nope");
    expect(listener).not.toHaveBeenCalled();
  });

  it("落盘后新进程能读回（重启 App 仍能回顾上个会话改了什么）", async () => {
    recordSessionChanges("c1", ["/w/a.ts", "/w/b.ts"], 1000);
    recordSessionChanges("c1", ["/w/a.ts"], 2000);
    expect(localStorage.getItem(SESSION_CHANGES_KEY)).toBeTruthy();

    vi.resetModules();
    const fresh = await import("./sessionChanges.js");
    const changes = fresh.getSessionChanges("c1");
    expect(changes.map((item) => item.path)).toEqual(["/w/a.ts", "/w/b.ts"]);
    expect(changes[0]).toMatchObject({ path: "/w/a.ts", at: 2000, writes: 2 });
  });

  it("每个会话最多 100 个文件，超出淘汰最久没动过的", () => {
    const paths = Array.from({ length: SESSION_CHANGES_MAX_FILES + 5 }, (_, index) => `/w/f${index}.ts`);
    for (const [index, path] of paths.entries()) recordSessionChanges("c1", [path], 1000 + index);

    const changes = getSessionChanges("c1");
    expect(changes).toHaveLength(SESSION_CHANGES_MAX_FILES);
    const known = new Set(changes.map((item) => item.path));
    expect(known.has("/w/f0.ts")).toBe(false);
    expect(known.has("/w/f4.ts")).toBe(false);
    expect(known.has("/w/f5.ts")).toBe(true);
  });

  it("最多记 30 个会话，超出淘汰最近改动时间最老的会话", () => {
    for (let index = 0; index < SESSION_CHANGES_MAX_SESSIONS + 1; index += 1) {
      recordSessionChanges(`c${index}`, [`/w/${index}.ts`], 1000 + index);
    }
    expect(getSessionChanges("c0")).toEqual([]);
    expect(getSessionChanges(`c${SESSION_CHANGES_MAX_SESSIONS}`)).toHaveLength(1);
  });

  it("坏数据静默降级：非数组、缺字段、次数为 0 的条目全丢（模拟重启后读盘）", async () => {
    localStorage.setItem(
      SESSION_CHANGES_KEY,
      JSON.stringify({
        c1: [
          { path: "/w/ok.ts", at: 5, writes: 2 },
          { path: "/w/no-at.ts", writes: 1 },
          { path: "", at: 5, writes: 1 },
          { path: "/w/zero.ts", at: 5, writes: 0 },
          "not-an-object",
        ],
        c2: "not-an-array",
        c3: [],
      }),
    );
    // 重新加载模块 = 新进程启动时的懒装载路径。
    vi.resetModules();
    const fresh = await import("./sessionChanges.js");
    expect(fresh.getSessionChanges("c1").map((item) => item.path)).toEqual(["/w/ok.ts"]);
    expect(fresh.getSessionChanges("c2")).toEqual([]);
    expect(fresh.getSessionChanges("c3")).toEqual([]);
  });

  it("localStorage 写失败（配额满 / 隐私模式）不抛异常，内存仍可用", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordSessionChanges("c1", ["/w/a.ts"], 1000)).not.toThrow();
    expect(getSessionChanges("c1")).toHaveLength(1);
    spy.mockRestore();
  });
});
