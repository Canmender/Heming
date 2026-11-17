import { describe, expect, it } from "vitest";
import {
  PANEL_AUTO_LONG_RUN_MS,
  PANEL_AUTO_MIN_TOOLS,
  PANEL_AUTO_QUIET_MS,
  decidePanelAutoOpen,
  formatPanelDuration,
  type PanelAutoInput,
} from "./panelAuto.js";

/**
 * 「跑久了自动摊开进度栏」的判据（d.245）。
 *
 * 这类规则最容易写成「看着差不多就弹」，所以每条约束都单独钉一例：
 * 什么都不做时不打扰、已经开着不动、一轮只抢一次镜、用户刚关掉就先别打扰、
 * 短问答不弹（否则每次提问都被一栏挡住）。
 *
 * 为什么只有「跑很久」一条：等你确认时对话里已经顶着确认卡（那就是入口），
 * 再自动摊开一栏是重复打扰；需要中途展示时由模型显式调用 `panel_show`。
 */
const base: PanelAutoInput = {
  open: false,
  autoOpenedThisRun: false,
  manualClosedAt: null,
  now: 1_000_000,
  runningMs: 0,
  tools: 0,
};

const longRun: PanelAutoInput = {
  ...base,
  runningMs: PANEL_AUTO_LONG_RUN_MS,
  tools: PANEL_AUTO_MIN_TOOLS,
};

describe("panelAuto · 什么时候自动开栏", () => {
  it("什么都没发生时不开", () => {
    expect(decidePanelAutoOpen(base)).toEqual({ open: false, reason: null, notice: null });
  });

  it("已经开着就不再动（不抢用户正在看的内容）", () => {
    expect(decidePanelAutoOpen({ ...longRun, open: true }).open).toBe(false);
  });

  it("一轮只自动开一次（心跳每秒来一次，不能反复抢镜）", () => {
    expect(decidePanelAutoOpen({ ...longRun, autoOpenedThisRun: true }).open).toBe(false);
  });

  it("用户刚手动关掉：安静期内不再自动打开", () => {
    expect(
      decidePanelAutoOpen({ ...longRun, manualClosedAt: base.now - 5_000 }).open,
    ).toBe(false);
  });

  it("安静期过了，跑得够久仍会再开（这是新一轮的判断，不是纠缠）", () => {
    const decision = decidePanelAutoOpen({
      ...longRun,
      manualClosedAt: base.now - PANEL_AUTO_QUIET_MS - 1,
    });
    expect(decision.open).toBe(true);
    expect(decision.reason).toBe("long-run");
  });

  it("跑很久但工具不够多（短问答被拖慢）不开", () => {
    expect(
      decidePanelAutoOpen({ ...base, runningMs: PANEL_AUTO_LONG_RUN_MS * 2, tools: PANEL_AUTO_MIN_TOOLS - 1 })
        .open,
    ).toBe(false);
  });

  it("工具够多但还没跑久也不开", () => {
    expect(
      decidePanelAutoOpen({ ...base, runningMs: PANEL_AUTO_LONG_RUN_MS - 1, tools: PANEL_AUTO_MIN_TOOLS + 3 })
        .open,
    ).toBe(false);
  });

  it("跑满 45 秒且调了 6 次工具才自动摊开", () => {
    const decision = decidePanelAutoOpen(longRun);
    expect(decision.open).toBe(true);
    expect(decision.reason).toBe("long-run");
    expect(decision.notice).toContain("45 秒");
    expect(decision.notice).toContain("6 次工具");
    expect(decision.notice).toContain("不用可以直接关掉");
  });

  it("时长说成人话：不到一分钟说秒，超过一分钟说分秒", () => {
    expect(formatPanelDuration(45_000)).toBe("45 秒");
    expect(formatPanelDuration(60_000)).toBe("1 分");
    expect(formatPanelDuration(125_000)).toBe("2 分 5 秒");
    expect(formatPanelDuration(-1)).toBe("0 秒");
  });
});
