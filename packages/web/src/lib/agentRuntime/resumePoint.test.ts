import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESUME_KEY,
  RESUME_MAX_AGE_MS,
  RESUME_MAX_POINTS,
  clearTurnRunning,
  listResumePoints,
  loadResumePoint,
  markTurnRunning,
  resetResumePoint,
  subscribeResumePoints,
} from "./resumePoint.js";

const point = {
  conversationId: "c1",
  streamId: "s1",
  agentId: "system-assistant",
  agentName: "和小鸣",
  startedAt: Date.now(),
};

const BASE = Date.now();

function pointFor(conversationId: string, startedAt = BASE) {
  return { ...point, conversationId, streamId: `s-${conversationId}`, startedAt };
}

describe("中断存档（d.189 / d.196 按会话存）", () => {
  beforeEach(() => {
    localStorage.clear();
    resetResumePoint();
  });

  it("标记后读得回来，字段一致", () => {
    markTurnRunning(point);
    expect(loadResumePoint()).toEqual(point);
    expect(loadResumePoint("c1")).toEqual(point);
  });

  it("收口后清掉标记（成功/失败/停止都由调用方清）", () => {
    markTurnRunning(point);
    clearTurnRunning();
    expect(loadResumePoint()).toBeNull();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it("会话不匹配时不返回（别人的半轮不该在这个会话里提示）", () => {
    markTurnRunning(point);
    expect(loadResumePoint("c2")).toBeNull();
  });

  it("超过 24 小时当作陈旧标记：不返回，并顺手清掉", () => {
    markTurnRunning(point);
    const late = point.startedAt + RESUME_MAX_AGE_MS + 1;
    expect(loadResumePoint(undefined, late)).toBeNull();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it("坏 JSON 与结构不对都当没有，并清掉脏数据", () => {
    localStorage.setItem(RESUME_KEY, "{不是 json");
    expect(loadResumePoint()).toBeNull();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();

    // d.196：map 里全是坏条目 → 等价于没有，顺手清掉
    localStorage.setItem(RESUME_KEY, JSON.stringify({ c1: { conversationId: "c1" } }));
    expect(loadResumePoint()).toBeNull();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it("d.189 的单条旧格式自动升级成按会话存（升级不丢标记）", () => {
    localStorage.setItem(RESUME_KEY, JSON.stringify(point));
    expect(loadResumePoint("c1")).toEqual(point);
    markTurnRunning(pointFor("c2"));
    expect(loadResumePoint("c1")?.streamId).toBe("s1");
    expect(loadResumePoint("c2")?.streamId).toBe("s-c2");
  });

  it("多个会话各留一条：切走再回来还在（这是 d.196 的关键）", () => {
    markTurnRunning(pointFor("c1", BASE - 2000));
    markTurnRunning(pointFor("c2", BASE - 1000));
    expect(loadResumePoint("c1")?.conversationId).toBe("c1");
    expect(loadResumePoint("c2")?.conversationId).toBe("c2");
    // 没给会话时给最近的
    expect(loadResumePoint()?.conversationId).toBe("c2");
    expect(listResumePoints().map((p) => p.conversationId)).toEqual(["c2", "c1"]);
  });

  it("收口只清那一个会话，别的会话的标记还在", () => {
    markTurnRunning(pointFor("c1", BASE - 2000));
    markTurnRunning(pointFor("c2", BASE - 1000));
    clearTurnRunning("c1");
    expect(loadResumePoint("c1")).toBeNull();
    expect(loadResumePoint("c2")?.conversationId).toBe("c2");
  });

  it("超过上限只留最近的若干个（按开始时间）", () => {
    for (let i = 0; i < RESUME_MAX_POINTS + 5; i += 1) {
      markTurnRunning(pointFor(`c${i}`, BASE - 10000 + i));
    }
    const list = listResumePoints();
    expect(list).toHaveLength(RESUME_MAX_POINTS);
    expect(list[0].conversationId).toBe(`c${RESUME_MAX_POINTS + 4}`);
    expect(loadResumePoint("c0")).toBeNull();
  });

  it("订阅者会在开始/收口时被通知，退订后不再通知", () => {
    const listener = vi.fn();
    const off = subscribeResumePoints(listener);
    markTurnRunning(pointFor("c1"));
    expect(listener).toHaveBeenCalledTimes(1);
    clearTurnRunning("c1");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    markTurnRunning(pointFor("c2"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("清理过期条目时也通知（侧栏徽标要跟着消失）", () => {
    markTurnRunning(pointFor("c1", BASE - 2000));
    const listener = vi.fn();
    subscribeResumePoints(listener);
    expect(listResumePoints(BASE + RESUME_MAX_AGE_MS + 1)).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });
});
