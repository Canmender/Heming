import { useCallback, useEffect, useRef, useState } from "react";
import type { Application } from "pixi.js";
import type { Live2DModel as Live2DModelInstance } from "pixi-live2d-display/cubism4";
import type { Rect } from "./petInteraction.js";
import { modelBoundsToHitBox } from "./petInteraction.js";

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
 * 入参用结构类型而不是 `Live2DModel`：这样这个函数不依赖 pixi 的运行时类型，
 * 也方便在测试里拿一个假对象验证「缩放/锚点/位置」三件事。
 */
interface FitTarget {
  width: number;
  height: number;
  scale: { set: (x: number, y: number) => void };
  anchor: { set: (x: number, y: number) => void };
  position: { set: (x: number, y: number) => void };
}

function fitModel(model: FitTarget, width: number, height: number): void {
  const modelW = model.width || 1;
  const modelH = model.height || 1;
  const scale = Math.min(width / modelW, height / modelH);
  model.scale.set(scale, scale);
  model.anchor.set(0.5, 1);
  model.position.set(width / 2, height);
}

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

        fitModel(model, width, height);
        app.stage.addChild(model);

        const syncHitBox = () => {
          const b = model.getBounds();
          setHitBox(
            modelBoundsToHitBox(
              { x: b.x, y: b.y, width: b.width, height: b.height },
              { width, height },
            ),
          );
        };
        syncHitBox();

        stageRef.current = {
          model,
          app,
          resize: (w, h) => {
            app.renderer.resize(w, h);
            fitModel(model, w, h);
            syncHitBox();
          },
        };

        setStatus("ready");
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

  // 窗口尺寸变化（缩放档位切换）时重排，不重建模型
  useEffect(() => {
    stageRef.current.resize?.(width, height);
  }, [width, height]);

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

  return { status, error, hitBox, setMouthOpen, playMotion, focus, focusCenter };
}
