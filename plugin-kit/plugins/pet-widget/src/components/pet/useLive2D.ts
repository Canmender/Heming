import { useCallback, useEffect, useRef, useState } from "react";
import type { Application } from "pixi.js";
import type { Live2DModel as Live2DModelInstance } from "pixi-live2d-display/cubism4";
import type { Rect } from "./petInteraction.js";
import { modelBoundsToHitBox } from "./petInteraction.js";
import { fitModel, type FitTarget } from "./live2dFit.js";

/**
 * Live2D 舞台（d.46）：把 Cubism Core + pixi + 模型装配成一个"能看能点"的角色。
 *
 * 三条硬约束：
 *
 * 1. **pixi 与 live2d 必须懒加载**。它们是 1MB 级的渲染库，只服务桌宠窗口；
 *    静态 import 会把主窗口首屏一起拖下水。所以这里全部用动态 import()。
 *
 * 2. **Cubism Core 是全局 UMD 脚本，不是 ESM 模块**。它必须在 `Live2DModel` 真正
 *    解析模型之前挂到 window 上，所以先插 `<script>` 并 await onload，再 import 渲染库。
 *    顺序反了会得到一句 "CubismCore is not defined"。
 *
 * 3. **失败要能说清是哪一步failed**（核心库 / 渲染库 / 模型文件），否则用户看到的
 *    只是一块空白，而桌宠最需要的恰恰是"它没出现，为什么"。
 */

type StageStatus = "idle" | "loading" | "ready" | "error";

export interface Live2DStage {
  status: StageStatus;
  /** 失败原因（面向用户的短句，不用堆栈） */
  error: string | null;
  /** 角色包围盒（窗口 CSS 像素），用于「光标是否在角色上」的判定 */
  hitBox: Rect | null;
  /** 说话口型 0–1；>0 时覆盖模型的 LipSync 参数 */
  setMouthOpen: (value: number) => void;
  /** 播一个动作组（如 Idle / TapBody） */
  playMotion: (group: string) => void;
  /** 视线跟随（窗口 CSS 像素坐标） */
  focus: (x: number, y: number) => void;
  /** 视线回正 */
  focusCenter: () => void;
  /**
   * 冻结/恢复舞台（拖拽期间用）。
   *
   * ★ 透明置顶窗连续移动时，画布还在逐帧重绘（呼吸/眨眼/物理/口型）会让 Windows
   *   DWM 每帧重新合成"移动 + 内容变化"的透明层，观感就是残影与边缘闪烁。冻结后
   *   移动期间只搬静态位图；恢复时立即渲染一帧，避免松手后画面停在旧帧。
   */
  setPaused: (paused: boolean) => void;
  /**
   * 同步窗口尺寸：重设分辨率（跨屏 DPI 可能变）→ resize 渲染器 → 重新拟合 → 渲染一帧。
   *
   * 拖拽期间渲染层会忽略 resize，松手后用它补一次（见 PetWindow 的 finishDrag）：
   * 拖动中画面只搬静态位图，尺寸/DPI 的变化攒到落点一次处理。
   */
  resizeTo: (width: number, height: number) => void;
}

interface UseLive2DOptions {
  canvas: HTMLCanvasElement | null;
  /** 模型地址（同源绝对地址，由 petModelUrl 拼好） */
  modelUrl: string;
  /** Cubism Core 脚本地址 */
  coreUrl: string;
  /** 窗口尺寸变化时重排角色 */
  width: number;
  height: number;
  onReady?: () => void;
  onError?: (message: string) => void;
}

/** 全局只加载一次 Cubism Core（重复插 script 会重复执行整个运行时）。 */
let corePromise: Promise<void> | null = null;

function loadCubismCore(url: string): Promise<void> {
  if (corePromise) return corePromise;
  corePromise = new Promise<void>((resolve, reject) => {
    const w = window as unknown as { Live2DCubismCore?: unknown };
    if (w.Live2DCubismCore) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => {
      if (w.Live2DCubismCore) resolve();
      else reject(new Error("Cubism Core 加载完成但未注册 Live2DCubismCore"));
    };
    script.onerror = () => reject(new Error("Cubism Core 脚本加载失败"));
    document.head.appendChild(script);
  });
  // 失败后允许下次重试（否则一次网络抖动就永久坏掉）
  corePromise.catch(() => {
    corePromise = null;
  });
  return corePromise;
}

/**
 * 模型适配窗口：等比缩放到窗口内，底边贴窗口下沿（"站在"窗口底部而不是浮在正中）。
 *
 * d.68 起移到 `live2dFit.ts` 的纯函数：必须基于**自然尺寸**拟合（旧实现用缩放后的
 * `model.width/height`，第二次调用会把缩放取倒数 —— 拖动时「局部放大」的根因）。
 * 这里只保留调用点，算法与幂等性由 `live2dFit.test.ts` 钉住。
 */

export function useLive2D(opts: UseLive2DOptions): Live2DStage {
  const { canvas, modelUrl, coreUrl, width, height, onReady, onError } = opts;

  const [status, setStatus] = useState<StageStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hitBox, setHitBox] = useState<Rect | null>(null);

  /** 舞台控件（pixi app / model / 清理函数），不放进 state——它们不参与渲染。 */
  const stageRef = useRef<{
    model: Live2DModelInstance | null;
    app: Application | null;
    resize: ((w: number, h: number) => void) | null;
  }>({ model: null, app: null, resize: null });

  // 回调放进 ref：父组件每次渲染都会传新函数，不该因此重建整个舞台
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  /**
   * 最新视口尺寸（ref 版本）。
   * 创建流程里不能直接用 props 的 width/height 闭包：模型是异步加载的，加载期间用户
   * 可能已经切了缩放档。舞台就绪后用它对齐一次，避免「加载完成瞬间还是旧尺寸」。
   */
  const viewportRef = useRef({ width, height });
  viewportRef.current = { width, height };

  useEffect(() => {
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      setStatus("loading");
      setError(null);
      try {
        // ① 先挂全局运行时
        await loadCubismCore(coreUrl);
        if (cancelled) return;

        // ② 再拉渲染库（动态 import：不进主 bundle）
        const PIXI = await import("pixi.js");
        const { Live2DModel } = await import("pixi-live2d-display/cubism4");
        if (cancelled) return;

        Live2DModel.registerTicker(PIXI.Ticker);

        const app = new PIXI.Application({
          view: canvas,
          width,
          height,
          backgroundAlpha: 0, // 透明窗口：不能画底色
          antialias: true,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
        });

        const model = await Live2DModel.from(modelUrl, { autoInteract: false });
        if (cancelled) {
          model.destroy();
          app.destroy(true);
          return;
        }

        fitModel(model as unknown as FitTarget, width, height);
        app.stage.addChild(model);

        /** 命中区按**当前**窗口尺寸夹取（不能用初始 width/height 的闭包值，否则 resize 后夹错）。 */
        const syncHitBox = (vw: number, vh: number) => {
          const b = model.getBounds();
          setHitBox(
            modelBoundsToHitBox(
              { x: b.x, y: b.y, width: b.width, height: b.height },
              { width: vw, height: vh },
            ),
          );
        };
        syncHitBox(width, height);

        stageRef.current = {
          model,
          app,
          resize: (w, h) => {
            if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) return;
            // ★ 先在 resize 之前同步分辨率：跨显示器拖动 / 系统缩放变化后 devicePixelRatio
            //   会和创建时不同。只 resize 不改 resolution 的话，画布位图密度仍是旧的，
            //   观感是「拖到另一块屏就发虚」。包 try/catch：个别后端不允许运行中改分辨率。
            try {
              const dpr = window.devicePixelRatio || 1;
              if (Number.isFinite(dpr) && dpr > 0 && app.renderer.resolution !== dpr) {
                app.renderer.resolution = dpr;
              }
            } catch {
              /* 改不了分辨率：保持原值，至少尺寸是对的 */
            }
            app.renderer.resize(w, h);
            fitModel(model as unknown as FitTarget, w, h);
            syncHitBox(w, h);
            // 尺寸与缩放刚改完：立刻渲染一帧，别等下一次 ticker——
            // 拖拽结束时用户马上要看到拟合正确的画面，不能停在旧帧。
            try {
              app.render();
            } catch {
              /* 正在销毁 */
            }
          },
        };

        setStatus("ready");
        // 模型加载期间用户可能切过缩放档：按最新视口再对齐一次（幂等；尺寸没变时也安全）
        const latest = viewportRef.current;
        if (latest.width !== width || latest.height !== height) {
          stageRef.current.resize?.(latest.width, latest.height);
        }
        onReadyRef.current?.();
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error && err.message ? err.message : "Live2D 初始化失败";
        setError(message);
        setStatus("error");
        onErrorRef.current?.(message);
      }
    })();

    return () => {
      cancelled = true;
      const stage = stageRef.current;
      stageRef.current = { model: null, app: null, resize: null };
      try {
        stage.model?.destroy();
      } catch {
        /* 模型已销毁/未创建 */
      }
      try {
        // true = 移除 canvas；桌宠窗口关闭时整棵 DOM 都会丢，这里只是尽早释放 GL 上下文
        stage.app?.destroy(true);
      } catch {
        /* 同上 */
      }
    };
    // 只在画布或模型地址真正变化时重建；width/height 变化走下面的 resize 分支
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, modelUrl, coreUrl]);

  /**
   * 主动同步窗口尺寸（稳定引用）。
   *
   * 两处调用：props 的 width/height 变化（缩放档位切换）；以及拖拽结束后的补测
   * （拖动期间 PetWindow 会忽略 resize，攒到 dragEnd 再一次性处理）。
   * 舞台未就绪时是空操作——首次拟合由创建流程按当时的 width/height 完成。
   */
  const resizeTo = useCallback((w: number, h: number) => {
    stageRef.current.resize?.(w, h);
  }, []);

  // 窗口尺寸变化（缩放档位切换）时重排，不重建模型
  useEffect(() => {
    resizeTo(width, height);
  }, [resizeTo, width, height]);

  const setMouthOpen = useCallback((value: number) => {
    // coreModel 在类型声明里退化成 object（Cubism 的参数 API 不在 d.ts 里），
    // 所以要按「有这个方法就用、没有就跳过」的形态取用，而不是假定它一定存在。
    const core = stageRef.current.model?.internalModel?.coreModel as
      | { setParameterValueById?: (id: string, value: number) => void }
      | undefined;
    if (!core || typeof core.setParameterValueById !== "function") return;
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    core.setParameterValueById("ParamMouthOpenY", v);
  }, []);

  const playMotion = useCallback((group: string) => {
    const model = stageRef.current.model;
    if (!model) return;
    try {
      void model.motion(group);
    } catch {
      /* 模型没有这个动作组：静默忽略，不影响其它交互 */
    }
  }, []);

  /**
   * 视线跟随：参数是窗口内 CSS 像素坐标。
   * pixi-live2d-display 的 focus 接收舞台坐标——舞台铺满窗口且不缩放，
   * 所以窗口坐标可以直接用，不需要额外换算。
   */
  const focus = useCallback((x: number, y: number) => {
    const model = stageRef.current.model;
    if (!model) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    try {
      model.focus(x, y);
    } catch {
      /* 模型尚未完成初始化 */
    }
  }, []);

  /** 鼠标离开窗口：把视线收回正前方，否则角色会一直盯着最后那个点。 */
  const focusCenter = useCallback(() => {
    focus(width / 2, height / 2);
  }, [focus, width, height]);

  /**
   * 暂停/恢复舞台。两条更新链要一起停：
   * - `app.ticker`（渲染）——停了就不再重绘透明画布；
   * - `model.autoUpdate`——pixi-live2d-display 把模型挂在 `PIXI.Ticker.shared` 上，
   *   它与 app 的 ticker 是两条独立时钟，只停 app 的话物理/动作/呼吸仍在后台算，
   *   恢复时会积累一大段 delta 导致动作"跳一下"。
   *
   * ★ 幂等：`autoUpdate` 的 setter 每调一次 `true` 就往共享 ticker 上加一个回调，
   *   重复恢复会让模型一帧更新两次。用 ref 记住当前是否已暂停，重复调用直接忽略。
   */
  const pausedRef = useRef(false);
  const setPaused = useCallback((paused: boolean) => {
    if (pausedRef.current === paused) return;
    const stage = stageRef.current;
    if (!stage.app) return; // 舞台未就绪：没有可冻结的东西
    pausedRef.current = paused;
    try {
      if (paused) {
        stage.app.ticker.stop();
        if (stage.model) stage.model.autoUpdate = false;
      } else {
        if (stage.model) stage.model.autoUpdate = true;
        stage.app.ticker.start();
        // 停表期间窗口内容没有更新，恢复时先补一帧，别等下一次 ticker 回调
        stage.app.render();
      }
    } catch {
      /* 正在销毁：冻结与否都不影响窗口移动 */
    }
  }, []);

  return {
    status,
    error,
    hitBox,
    setMouthOpen,
    playMotion,
    focus,
    focusCenter,
    setPaused,
    resizeTo,
  };
}
