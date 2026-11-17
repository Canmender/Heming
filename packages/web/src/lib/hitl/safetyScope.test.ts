/**
 * 安全范围（d.242）：用户语言三档 ↔ 内部 HITL 档位 + 全放行开关。
 *
 * 这层很薄，但每一条都值得钉住：映射错了会让用户以为「自动」其实在乱跑，
 * 或者让「完全」变成重启后依然生效的持久全放行。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HITL_POLICY, type HitlPolicy } from "./policy.js";
import {
  SAFETY_SCOPES,
  SAFETY_SCOPE_TEXT,
  describeSafetyScope,
  isDangerAuto,
  policyForScope,
  resetDangerAuto,
  scopeOfPolicy,
  setDangerAuto,
  subscribeDangerAuto,
} from "./safetyScope.js";

const policyOf = (patch: Partial<HitlPolicy> = {}): HitlPolicy => ({
  ...DEFAULT_HITL_POLICY,
  ...patch,
});

afterEach(() => {
  resetDangerAuto();
  vi.restoreAllMocks();
});

describe("三档映射（d.242）", () => {
  it("strict → 手动；guarded/trusted 且未全放行 → 自动", () => {
    expect(scopeOfPolicy(policyOf({ mode: "strict" }), false)).toBe("manual");
    expect(scopeOfPolicy(policyOf({ mode: "guarded" }), false)).toBe("auto");
    expect(scopeOfPolicy(policyOf({ mode: "trusted" }), false)).toBe("auto");
  });

  it("全放行开关打开 → 完全（即使档位是 trusted 也不会被读成自动）", () => {
    expect(scopeOfPolicy(policyOf({ mode: "trusted" }), true)).toBe("full");
  });

  it("strict 下即使开关残留开着，也按手动算（严格档恒问，不能被骗成完全）", () => {
    expect(scopeOfPolicy(policyOf({ mode: "strict" }), true)).toBe("manual");
  });

  it("选中档位后落成的内部状态：手动=strict、自动=guarded、完全=trusted+全放行", () => {
    expect(policyForScope("manual")).toEqual({ mode: "strict", dangerAuto: false });
    expect(policyForScope("auto")).toEqual({ mode: "guarded", dangerAuto: false });
    expect(policyForScope("full")).toEqual({ mode: "trusted", dangerAuto: true });
  });

  it("三档的标签与说明都不空，且「完全」的说明里写清「本次运行内有效」", () => {
    expect(SAFETY_SCOPES).toEqual(["manual", "auto", "full"]);
    for (const scope of SAFETY_SCOPES) {
      expect(SAFETY_SCOPE_TEXT[scope].label.length).toBeGreaterThan(0);
      expect(SAFETY_SCOPE_TEXT[scope].hint.length).toBeGreaterThan(0);
    }
    expect(SAFETY_SCOPE_TEXT.full.hint).toContain("本次运行内有效");
    expect(SAFETY_SCOPE_TEXT.full.hint).toContain("重启");
  });
});

describe("全放行开关的状态与订阅（d.242）", () => {
  it("默认关闭；打开后读到 true；重复设置不会重复通知", () => {
    expect(isDangerAuto()).toBe(false);
    const listener = vi.fn();
    const unsubscribe = subscribeDangerAuto(listener);
    setDangerAuto(true);
    expect(isDangerAuto()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setDangerAuto(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setDangerAuto(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("resetDangerAuto 回到关闭（测试之间不互相影响）", () => {
    setDangerAuto(true);
    resetDangerAuto();
    expect(isDangerAuto()).toBe(false);
  });
});

describe("自检文案（d.242）", () => {
  it("三档各有自己的文案，且「完全」把代价写出来", () => {
    expect(describeSafetyScope("manual")).toContain("安全范围：手动");
    expect(describeSafetyScope("auto")).toContain("安全范围：自动");
    const full = describeSafetyScope("full");
    expect(full).toContain("安全范围：完全");
    expect(full).toContain("危险操作");
    expect(full).toContain("重启");
  });
});
