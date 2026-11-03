/**
 * Live2D 模型适配窗口的纯函数（d.68）。
 *
 * ★ 为什么单独抽出来：这是「拖动桌宠时画面局部被放大 / 角色只露一部分」的根因所在，
 *   而且它只做几何计算、不依赖 pixi 运行时——抽成纯函数才能用假模型把幂等性钉在单测里。
 *
 * 旧实现（d.67 及以前，在 useLive2D.ts 内部）：
 *
 * ```ts
 * const scale = Math.min(width / model.width, height / model.height);
 * ```
 *
 * pixi 的 `Container.width` 是**已经乘过 scale 的宽度**（`localBounds.width × scale.x`），
 * 不是自然尺寸。于是：
 *
 * - 首次加载：`scale₀ = min(w / naturalW, h / naturalH)`（碰巧正确，因为初始 scale=1）；
 * - 任何一次 resize 再拟合：`scale₁ = min(w/(naturalW·scale₀), h/(naturalH·scale₀)) ≈ 1/scale₀`
 *   ——缩放被**取倒数**；再下一次又翻回来。
 *
 * 桌宠拖动时 Chromium 会因跨显示器 DPI 变化 / 客户区像素取整派发 resize，
 * 每来一次就翻一次，观感就是「抽一下 / 局部放大 / 角色只露一部分」。
 *
 * 修法（本文件）：拟合一律基于**自然尺寸**（优先 `internalModel.width/height`，
 * 退化用「当前尺寸 ÷ 当前缩放」反推），因此 `fitModel` 对同一窗口尺寸幂等。
 */

/** 窗口可视区尺寸（CSS 像素）。 */
export interface FitViewportSize {
  width: number;
  height: number;
}

/** 模型自然尺寸（未缩放时占的像素）。 */
export interface NaturalSize {
  width: number;
  height: number;
}

export interface FitResult {
  /** 等比缩放系数（x/y 相同）。 */
  scale: number;
  /** 模型位置（窗口 CSS 像素）：水平居中、底边贴底。 */
  x: number;
  y: number;
}

/**
 * 拟合目标的结构类型。
 *
 * 刻意不依赖 pixi / pixi-live2d-display 的运行时类型：
 * - 本文件要能在 node 环境的单测里直接跑；
 * - 测试里的假模型只需要实现这几个成员，就能验证「缩放 / 锚点 / 位置」三件事。
 *
 * `width/height` 是**缩放后**的尺寸（与 pixi `Container` 一致），
 * 所以读自然尺寸时必须除以当前缩放，不能直接拿来算比例。
 */
export interface FitTarget {
  readonly width: number;
  readonly height: number;
  /** pixi ObservablePoint：读 x/y 判断当前缩放，set 写入新缩放。 */
  scale: {
    readonly x: number;
    readonly y: number;
    set: (x: number, y: number) => void;
  };
  /** 锚点：贴底需要一个下沿锚点。 */
  anchor: {
    set: (x: number, y: number) => void;
  };
  /** 位置：窗口 CSS 像素。 */
  position: {
    set: (x: number, y: number) => void;
  };
  /**
   * Cubism 内部模型的自然尺寸（pixi-live2d-display 提供）。
   * 部分版本/模型没有这个字段，此时退化为「当前尺寸 ÷ 当前缩放」。
   */
  internalModel?: {
    readonly width?: number;
    readonly height?: number;
  } | null;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 读取模型的自然尺寸（未缩放尺寸）。
 *
 * 两条来源，优先前者：
 * 1. `internalModel.width/height`：Cubism 权威值，与缩放无关；
 * 2. `model.width / model.scale.x`：pixi 的 `Container.width` 是「自然尺寸 × scale」，
 *    除以缩放即可还原。**这是修复的关键一步**：绝不能把 `model.width` 当自然尺寸用。
 *
 * 无效输入（尺寸为 0 / 非有限数）返回 null，由调用方保持原状——
 * 宁可少拟合一次，也不要把 NaN 写进 pixi 的变换矩阵。
 */
export function readNaturalSize(model: FitTarget): NaturalSize | null {
  const internal = model.internalModel;
  if (internal && isPositive(internal.width) && isPositive(internal.height)) {
    return { width: internal.width, height: internal.height };
  }

  const width = model.width;
  const height = model.height;
  if (!isPositive(width) || !isPositive(height)) return null;

  const sx = model.scale?.x;
  const sy = model.scale?.y;
  // 还没缩放过 / 拿不到缩放：当前尺寸就是自然尺寸（初始 scale=1 的常见路径）
  if (!isPositive(sx) || !isPositive(sy)) return { width, height };
  return { width: width / sx, height: height / sy };
}

/**
 * 纯计算：把自然尺寸等比放进窗口，返回缩放与位置。
 *
 * 规则（与 d.46 的观感约定一致）：
 * - 取 `min(w/naturalW, h/naturalH)`，保证**不超窗口**；
 * - 锚点 (0.5, 1)：水平居中、底边贴窗口下沿 —— 角色「站在」窗口底部而不是浮在正中。
 *
 * 非法入参返回 null（调用方保持原状）。
 */
export function fitViewport(
  natural: NaturalSize | null | undefined,
  viewport: FitViewportSize,
): FitResult | null {
  if (!natural || !isPositive(natural.width) || !isPositive(natural.height)) return null;
  if (!isPositive(viewport.width) || !isPositive(viewport.height)) return null;

  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  if (!isPositive(scale)) return null;
  return { scale, x: viewport.width / 2, y: viewport.height };
}

/**
 * 只算不写：下一次拟合会用到的缩放（便于测试与诊断）。
 * 与 `fitModel` 共用同一套自然尺寸口径，因此也幂等。
 */
export function nextFitScale(
  model: FitTarget,
  viewportWidth: number,
  viewportHeight: number,
): number | null {
  const natural = readNaturalSize(model);
  return fitViewport(natural, { width: viewportWidth, height: viewportHeight })?.scale ?? null;
}

/**
 * 把模型拟合进窗口（幂等）。
 *
 * 同一窗口尺寸重复调用：读出的自然尺寸相同 ⇒ 缩放相同 ⇒ 不会再出现「翻转」。
 * 返回实际写入的变换（测试与日志可用）；入参非法时返回 null 且**不改动模型**。
 */
export function fitModel(
  model: FitTarget,
  viewportWidth: number,
  viewportHeight: number,
): FitResult | null {
  const fit = fitViewport(readNaturalSize(model), {
    width: viewportWidth,
    height: viewportHeight,
  });
  if (!fit) return null;
  model.scale.set(fit.scale, fit.scale);
  model.anchor.set(0.5, 1);
  model.position.set(fit.x, fit.y);
  return fit;
}
