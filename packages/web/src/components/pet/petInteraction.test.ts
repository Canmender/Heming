import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  classifyPointerUp,
  containsPoint,
  isInteractiveAt,
  modelBoundsToHitBox,
  shouldReportChange,
} from "./petInteraction.js";

const stage = { x: 40, y: 10, width: 220, height: 400 };

describe("点与矩形", () => {
  it("落在内部与边界都算命中", () => {
    expect(containsPoint(stage, 100, 100)).toBe(true);
    expect(containsPoint(stage, 40, 10)).toBe(true); // 左上角
    expect(containsPoint(stage, 260, 410)).toBe(true); // 右下角
  });

  it("落在外部不命中", () => {
    expect(containsPoint(stage, 39, 100)).toBe(false);
    expect(containsPoint(stage, 261, 100)).toBe(false);
    expect(containsPoint(stage, 100, 9)).toBe(false);
    expect(containsPoint(stage, 100, 411)).toBe(false);
  });

  it("空矩形 / 退化矩形 / 非法数值一律不命中", () => {
    expect(containsPoint(null, 1, 1)).toBe(false);
    expect(containsPoint(undefined, 1, 1)).toBe(false);
    expect(containsPoint({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toBe(false);
    expect(containsPoint({ x: 0, y: 0, width: -10, height: 10 }, 0, 0)).toBe(false);
    expect(containsPoint({ x: NaN, y: 0, width: 10, height: 10 }, 0, 0)).toBe(false);
    expect(containsPoint(stage, NaN, 100)).toBe(false);
  });
});

describe("多区域命中（角色 ∪ 气泡 ∪ 输入框）", () => {
  const bubble = { x: 0, y: 0, width: 300, height: 60 };

  it("落在任一区域即算可交互", () => {
    expect(isInteractiveAt([stage, bubble], 150, 30)).toBe(true); // 气泡
    expect(isInteractiveAt([stage, bubble], 150, 200)).toBe(true); // 角色
    expect(isInteractiveAt([stage, bubble], 150, 350)).toBe(true); // 角色下部
  });

  it("空白处（角色与气泡之间）不拦截鼠标", () => {
    expect(isInteractiveAt([stage, bubble], 5, 300)).toBe(false);
    expect(isInteractiveAt([stage, bubble], 290, 250)).toBe(false);
  });

  it("全部为空时一律不命中", () => {
    expect(isInteractiveAt([null, undefined], 150, 150)).toBe(false);
  });
});

describe("点击 vs 拖拽", () => {
  it("小位移算点击（手抖不该把点击变成拖拽）", () => {
    expect(classifyPointerUp(100, 100, 100, 100)).toBe("tap");
    expect(classifyPointerUp(100, 100, 101, 101)).toBe("tap");
    expect(classifyPointerUp(100, 100, 102, 101)).toBe("tap");
  });

  it("达到阈值算拖拽", () => {
    expect(classifyPointerUp(100, 100, 100 + DRAG_THRESHOLD_PX, 100)).toBe("drag");
    expect(classifyPointerUp(100, 100, 100, 100 + DRAG_THRESHOLD_PX)).toBe("drag");
    expect(classifyPointerUp(100, 100, 130, 140)).toBe("drag");
  });

  it("斜向也按欧氏距离判定", () => {
    // 3-4-5：位移恰好 5px
    expect(classifyPointerUp(0, 0, 3, 4)).toBe("drag");
    expect(classifyPointerUp(0, 0, 2, 2)).toBe("tap");
  });

  it("非法输入按点击处理（保守：宁可开对话也不要莫名移动窗口）", () => {
    expect(classifyPointerUp(NaN, 0, 0, 0)).toBe("tap");
    expect(classifyPointerUp(0, 0, undefined as unknown as number, 0)).toBe("tap");
  });
});

describe("命中区换算", () => {
  const viewport = { width: 300, height: 420 };

  it("模型在画布内时原样换算", () => {
    expect(modelBoundsToHitBox({ x: 20, y: 30, width: 260, height: 380 }, viewport)).toEqual({
      x: 20,
      y: 30,
      width: 260,
      height: 380,
    });
  });

  it("模型超出画布时夹到窗口内（命中区不该延伸到窗口外）", () => {
    const box = modelBoundsToHitBox({ x: -50, y: -30, width: 400, height: 500 }, viewport);
    expect(box).toEqual({ x: 0, y: 0, width: 300, height: 420 });
  });

  it("部分超出时只夹被超出的一侧", () => {
    const box = modelBoundsToHitBox({ x: -10, y: 20, width: 200, height: 300 }, viewport);
    expect(box).toEqual({ x: 0, y: 20, width: 190, height: 300 });
  });

  it("完全在窗口外 / 退化 / 空值 → null", () => {
    expect(modelBoundsToHitBox({ x: 400, y: 0, width: 100, height: 100 }, viewport)).toBeNull();
    expect(modelBoundsToHitBox({ x: 0, y: 0, width: 0, height: 0 }, viewport)).toBeNull();
    expect(modelBoundsToHitBox(null, viewport)).toBeNull();
    expect(modelBoundsToHitBox({ x: NaN, y: 0, width: 10, height: 10 }, viewport)).toBeNull();
  });
});

describe("上报去重", () => {
  it("值不变不重复上报（mousemove 是高频事件）", () => {
    expect(shouldReportChange(true, true)).toBe(false);
    expect(shouldReportChange(false, false)).toBe(false);
  });
  it("值变化才上报", () => {
    expect(shouldReportChange(true, false)).toBe(true);
    expect(shouldReportChange(false, true)).toBe(true);
  });
});
