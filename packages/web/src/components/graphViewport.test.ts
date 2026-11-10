import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  isDragBeyondThreshold,
  resetViewport,
  screenToWorld,
  stepZoom,
  viewportTransform,
  wheelViewport,
  wheelZoomFactor,
  zoomAtAnchor,
  zoomPercent,
} from "./graphViewport.js";

const SIZE = { w: 800, h: 480 };

describe("图谱视口 · 缩放夹取与百分比", () => {
  it("clamp 到 [MIN_ZOOM, MAX_ZOOM]，非法值回 1", () => {
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1.23456)).toBe(1.235);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("百分比四舍五入成整数（工具栏展示）", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(0.4)).toBe(40);
    expect(zoomPercent(1.235)).toBe(124);
    expect(zoomPercent(2.4)).toBe(240);
  });

  it("重置回 100% 且平移归零", () => {
    expect(resetViewport()).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
  });
});

describe("图谱视口 · 变换串", () => {
  it("顺序固定：中心 → pan → scale → 反向中心", () => {
    expect(viewportTransform({ zoom: 1.5, pan: { x: 20, y: -10 } }, SIZE)).toBe(
      "translate(420 230) scale(1.5) translate(-400 -240)",
    );
  });

  it("screenToWorld 与变换互逆", () => {
    const view = { zoom: 1.7, pan: { x: 35, y: -22 } };
    for (const point of [
      { x: 0, y: 0 },
      { x: 400, y: 240 },
      { x: 123, y: 456 },
    ]) {
      const world = screenToWorld(point, view, SIZE);
      // 用变换串的推导式手工验算一遍
      const expected = {
        x: SIZE.w / 2 + (point.x - SIZE.w / 2 - view.pan.x) / view.zoom,
        y: SIZE.h / 2 + (point.y - SIZE.h / 2 - view.pan.y) / view.zoom,
      };
      expect(world.x).toBeCloseTo(expected.x, 9);
      expect(world.y).toBeCloseTo(expected.y, 9);
    }
  });
});

describe("图谱视口 · 以光标为锚点缩放（不漂移）", () => {
  it("锚点下方的图内点在缩放前后落回同一屏幕位置", () => {
    const before = { zoom: 1.1, pan: { x: 18, y: -7 } };
    const anchor = { x: 512, y: 160 };
    const worldBefore = screenToWorld(anchor, before, SIZE);

    const after = zoomAtAnchor(before, 1.85, anchor, SIZE);
    expect(after.zoom).toBe(1.85);
    const worldAfter = screenToWorld(anchor, after, SIZE);

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9);
  });

  it("连续多次滚轮后，同一点仍不漂移（指数缩放的累积误差可控）", () => {
    let view = resetViewport();
    const anchor = { x: 700, y: 420 };
    const world = screenToWorld(anchor, view, SIZE);
    for (let i = 0; i < 12; i += 1) {
      view = wheelViewport(view, { deltaY: i % 2 === 0 ? -120 : -60 }, anchor, SIZE);
    }
    const after = screenToWorld(anchor, view, SIZE);
    expect(after.x).toBeCloseTo(world.x, 6);
    expect(after.y).toBeCloseTo(world.y, 6);
  });

  it("到达上下限后不再改变视口（避免边界处 pan 乱跑）", () => {
    const atMax = { zoom: MAX_ZOOM, pan: { x: 12, y: 34 } };
    expect(zoomAtAnchor(atMax, MAX_ZOOM * 2, { x: 100, y: 100 }, SIZE)).toBe(atMax);
    const atMin = { zoom: MIN_ZOOM, pan: { x: -5, y: 9 } };
    expect(zoomAtAnchor(atMin, 0.01, { x: 100, y: 100 }, SIZE)).toBe(atMin);
  });

  it("按钮缩放以视口中心为锚点：屏幕中心下的图内点不动（pan 按比例变化）", () => {
    const view = { zoom: 1.2, pan: { x: 40, y: -16 } };
    const center = { x: SIZE.w / 2, y: SIZE.h / 2 };
    const worldBefore = screenToWorld(center, view, SIZE);
    const after = stepZoom(view, 0.2, SIZE);
    expect(after.zoom).toBe(1.4);
    const worldAfter = screenToWorld(center, after, SIZE);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9);
    // pan 只在图被平移过时按缩放比例变化（视觉上中心内容不跑）
    expect(after.pan.x).toBeCloseTo((view.pan.x * 1.4) / 1.2, 9);
    expect(stepZoom(view, -0.5, SIZE).zoom).toBe(0.7);
  });
});

describe("图谱视口 · 滚轮换算", () => {
  it("向上滚放大、向下滚缩小；单次倍率有夹取", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    // 超大 delta（触控板甩一下）不会一步到底
    expect(wheelZoomFactor(-100000)).toBe(2);
    expect(wheelZoomFactor(100000)).toBe(0.5);
    // deltaMode=1（按行）要乘行高，同样的 deltaY 变化更大
    expect(wheelZoomFactor(-1, 1)).toBeGreaterThan(wheelZoomFactor(-1, 0));
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("滚轮落在边界内：不会越过 MIN/MAX", () => {
    let view = resetViewport();
    for (let i = 0; i < 100; i += 1) view = wheelViewport(view, { deltaY: -300 }, { x: 0, y: 0 }, SIZE);
    expect(view.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 100; i += 1) view = wheelViewport(view, { deltaY: 300 }, { x: 0, y: 0 }, SIZE);
    expect(view.zoom).toBe(MIN_ZOOM);
  });
});

describe("图谱视口 · 拖拽阈值", () => {
  it("小于阈值算点击，超过阈值算拖拽", () => {
    expect(isDragBeyondThreshold(0, 0)).toBe(false);
    expect(isDragBeyondThreshold(DRAG_THRESHOLD, 0)).toBe(false);
    expect(isDragBeyondThreshold(DRAG_THRESHOLD + 0.1, 0)).toBe(true);
    expect(isDragBeyondThreshold(3, 3)).toBe(true); // 斜向 4.24 > 4
    expect(isDragBeyondThreshold(3, 1)).toBe(false);
  });
});
