/**
 * Live2D 适配算法（live2dFit）· 回归测试。
 *
 * 这些用例先于实现写出来，钉住 d.68 用户报的「拖动时画面局部被放大 / 角色只露一部分」：
 * 旧实现 `useLive2D.fitModel` 拿 `model.width / model.height` 算缩放，而 pixi 的
 * `Container.width` 是**已经乘过 scale 的宽度**，于是第二次拟合会得到
 * `scale' ≈ 1 / scale` —— 缩放被取倒数，角色瞬间巨大或被裁切。
 *
 * ★ 这里的假模型刻意把「缩放后的尺寸」建模成 `natural * scale`（与 pixi 一致），
 *   所以「同尺寸连续调用两次，scale 必须不变」就是幂等性的直接证明。
 */
import { describe, expect, it } from "vitest";
import {
  fitModel,
  fitViewport,
  nextFitScale,
  readNaturalSize,
  type FitTarget,
} from "./live2dFit.js";

/** 与 pixi 行为一致的假模型：width/height 返回 natural × scale。 */
function makeFakeModel(
  naturalWidth = 900,
  naturalHeight = 1600,
  opts: { internal?: boolean; withInternalSize?: boolean } = {},
) {
  const state = {
    scaleX: 1,
    scaleY: 1,
    anchorX: 0,
    anchorY: 0,
    x: 0,
    y: 0,
  };
  const model = {
    internalModel:
      opts.internal === false
        ? undefined
        : opts.withInternalSize === false
          ? {}
          : { width: naturalWidth, height: naturalHeight },
    get width() {
      return naturalWidth * state.scaleX;
    },
    get height() {
      return naturalHeight * state.scaleY;
    },
    scale: {
      get x() {
        return state.scaleX;
      },
      get y() {
        return state.scaleY;
      },
      set(x: number, y: number) {
        state.scaleX = x;
        state.scaleY = y;
      },
    },
    anchor: {
      set(x: number, y: number) {
        state.anchorX = x;
        state.anchorY = y;
      },
    },
    position: {
      set(x: number, y: number) {
        state.x = x;
        state.y = y;
      },
    },
    state,
  };
  return model;
}

/** 拟合后「渲染出来的宽高」 = 自然尺寸 × 当前缩放。 */
function renderedSize(model: ReturnType<typeof makeFakeModel>, natural = { w: 900, h: 1600 }) {
  return { width: natural.w * model.state.scaleX, height: natural.h * model.state.scaleY };
}

describe("自然尺寸读取", () => {
  it("优先用 internalModel.width/height", () => {
    const model = makeFakeModel();
    expect(readNaturalSize(model as unknown as FitTarget)).toEqual({ width: 900, height: 1600 });
  });

  it("internalModel 没有尺寸时，用「当前尺寸 ÷ 当前缩放」反推自然尺寸", () => {
    const model = makeFakeModel(900, 1600, { withInternalSize: false });
    model.scale.set(0.5, 0.5);
    expect(readNaturalSize(model as unknown as FitTarget)).toEqual({ width: 900, height: 1600 });
  });

  it("退化模型（尺寸为 0 / 非法）返回 null，不产生 NaN 缩放", () => {
    const broken = {
      width: 0,
      height: 0,
      scale: { x: 0, y: 0, set() {} },
      anchor: { set() {} },
      position: { set() {} },
    };
    expect(readNaturalSize(broken as unknown as FitTarget)).toBeNull();
  });
});

describe("fitViewport（纯计算）", () => {
  it("等比适配：取宽高比例中较小的那个，不超窗口", () => {
    // 900×1600 的模型放进 300×420：0.333 vs 0.2625 → 0.2625（高度受限）
    const fit = fitViewport({ width: 900, height: 1600 }, { width: 300, height: 420 });
    expect(fit).not.toBeNull();
    expect(fit!.scale).toBeCloseTo(0.2625, 6);
    expect(900 * fit!.scale).toBeLessThanOrEqual(300 + 1e-6);
    expect(1600 * fit!.scale).toBeLessThanOrEqual(420 + 1e-6);
  });

  it("底边贴底、水平居中：position = (宽/2, 高)", () => {
    const fit = fitViewport({ width: 900, height: 1600 }, { width: 375, height: 525 });
    expect(fit!.x).toBe(187.5);
    expect(fit!.y).toBe(525);
  });

  it("非法窗口尺寸返回 null（宁可不动，也不要写出 NaN 变换）", () => {
    const natural = { width: 900, height: 1600 };
    expect(fitViewport(natural, { width: 0, height: 420 })).toBeNull();
    expect(fitViewport(natural, { width: 300, height: 0 })).toBeNull();
    expect(fitViewport(natural, { width: NaN, height: 420 })).toBeNull();
    expect(fitViewport({ width: 0, height: 0 }, { width: 300, height: 420 })).toBeNull();
  });
});

describe("fitModel · 幂等（d.68「拖动时局部放大」的根因）", () => {
  it("同一尺寸连续拟合两次，缩放不翻转（旧实现会取倒数）", () => {
    const model = makeFakeModel();
    const first = fitModel(model as unknown as FitTarget, 300, 420);
    expect(first).not.toBeNull();
    const firstScale = model.state.scaleX;
    expect(firstScale).toBeCloseTo(0.2625, 6);

    const second = fitModel(model as unknown as FitTarget, 300, 420);
    expect(second).not.toBeNull();
    expect(model.state.scaleX).toBeCloseTo(firstScale, 9);
    expect(model.state.scaleY).toBeCloseTo(firstScale, 9);
    // 拟合后画面仍然完整落在窗口内（不是被放大到裁切）
    const rendered = renderedSize(model);
    expect(rendered.width).toBeLessThanOrEqual(300 + 1e-6);
    expect(rendered.height).toBeLessThanOrEqual(420 + 1e-6);
  });

  it("连续拟合 5 次（模拟拖动中 Chromium 反复派发 resize）缩放始终稳定", () => {
    const model = makeFakeModel();
    const scales = new Set<number>();
    for (let i = 0; i < 5; i += 1) {
      fitModel(model as unknown as FitTarget, 300, 420);
      scales.add(Number(model.state.scaleX.toFixed(6)));
    }
    expect(scales.size).toBe(1);
    expect([...scales][0]).toBeCloseTo(0.2625, 6);
  });

  it("尺寸变化后按自然尺寸等比适配（不是按上一次的缩放结果）", () => {
    const model = makeFakeModel();
    fitModel(model as unknown as FitTarget, 300, 420);
    expect(model.state.scaleX).toBeCloseTo(0.2625, 6);

    // 放大一档到 375×525：高度增加 25%，缩放也应恰好 ×1.25
    fitModel(model as unknown as FitTarget, 375, 525);
    expect(model.state.scaleX).toBeCloseTo(0.328125, 6);
    expect(model.state.anchorX).toBe(0.5);
    expect(model.state.anchorY).toBe(1);
    expect(model.state.x).toBe(187.5);
    expect(model.state.y).toBe(525);

    // 缩回原尺寸：与第一次完全一致
    fitModel(model as unknown as FitTarget, 300, 420);
    expect(model.state.scaleX).toBeCloseTo(0.2625, 6);
  });

  it("底边贴底：任何尺寸下模型底边都落在窗口下沿，且不超窗口", () => {
    const model = makeFakeModel();
    for (const [w, h] of [
      [300, 420],
      [375, 525],
      [240, 336],
      [600, 840],
    ]) {
      fitModel(model as unknown as FitTarget, w, h);
      const rendered = renderedSize(model);
      expect(rendered.width).toBeLessThanOrEqual(w + 1e-6);
      expect(rendered.height).toBeLessThanOrEqual(h + 1e-6);
      expect(model.state.y).toBe(h);
      expect(model.state.anchorY).toBe(1);
      expect(model.state.x).toBe(w / 2);
    }
  });

  it("非法窗口尺寸时保持上一次有效变换（不写 NaN）", () => {
    const model = makeFakeModel();
    fitModel(model as unknown as FitTarget, 300, 420);
    const before = model.state.scaleX;
    expect(fitModel(model as unknown as FitTarget, 0, 420)).toBeNull();
    expect(model.state.scaleX).toBe(before);
    expect(Number.isFinite(model.state.scaleX)).toBe(true);
  });
});

/**
 * 对照：把旧实现原样搬过来，证明它**确实**会翻转（根因证据，不是推测）。
 * 旧实现已从 useLive2D 删除，这里保留一份最小副本，防止将来有人「顺手简化」回去。
 */
function legacyFitModel(model: ReturnType<typeof makeFakeModel>, width: number, height: number) {
  const modelW = model.width || 1; // ← 错在这里：model.width 是「自然尺寸 × scale」
  const modelH = model.height || 1;
  const scale = Math.min(width / modelW, height / modelH);
  model.scale.set(scale, scale);
}

describe("旧实现对照（证明根因：缩放被取倒数）", () => {
  it("旧算法同尺寸拟合两次得到互为倒数/极其悬殊的缩放", () => {
    const model = makeFakeModel();
    legacyFitModel(model, 300, 420);
    const first = model.state.scaleX;
    expect(first).toBeCloseTo(0.2625, 6);

    legacyFitModel(model, 300, 420);
    // 第二次的入参是「自然尺寸 × first」，于是
    //   scale = min(w/(nW·first), h/(nH·first)) = (1/first)·min(w/nW, h/nH) = 1
    // 也就是无论窗口多大，第二次一定回到 scale=1 —— 角色瞬间放大到 3.8 倍并被裁切。
    const second = model.state.scaleX;
    expect(second).toBeCloseTo(1, 6);
    expect(second / first).toBeGreaterThan(3);

    // 第三次又翻回来——这就是用户看到的「抽一下 / 局部放大」
    legacyFitModel(model, 300, 420);
    expect(model.state.scaleX).toBeCloseTo(first, 4);
  });

  it("新实现对同样的序列保持稳定（修复后的行为）", () => {
    const model = makeFakeModel();
    const scales: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      fitModel(model as unknown as FitTarget, 300, 420);
      scales.push(model.state.scaleX);
    }
    expect(scales[0]).toBeCloseTo(scales[1], 9);
    expect(scales[1]).toBeCloseTo(scales[2], 9);
  });
});

describe("nextFitScale（纯计算，不改模型）", () => {
  it("返回与 fitModel 相同的缩放，但不修改模型", () => {
    const model = makeFakeModel();
    const scale = nextFitScale(model as unknown as FitTarget, 300, 420);
    expect(scale).toBeCloseTo(0.2625, 6);
    expect(model.state.scaleX).toBe(1);
    expect(model.state.scaleY).toBe(1);
  });

  it("窗口尺寸非法时返回 null", () => {
    const model = makeFakeModel();
    expect(nextFitScale(model as unknown as FitTarget, Number.NaN, 420)).toBeNull();
  });
});
