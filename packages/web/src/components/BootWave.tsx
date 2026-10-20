import { useCallback, useEffect, useRef, useState } from "react";
import { WordmarkWrite } from "./WordmarkWrite.js";

/** 声波扩散段时长；与 packages/desktop/splash-config.js 的 WAVE_MS 保持一致。 */
const WAVE_MS = 1300;

/**
 * 保证完成的余量：定时器比动画时长多等 80ms，让最后一帧 rAF 有机会先落地
 * （正常路径下由 rAF 收尾，定时器只是「rAF 被暂停时」的保险丝）。
 */
const COMPLETE_SLACK_MS = 80;

/**
 * 兜底开播时限。真实信号由主进程 did-finish-load + 静默间隔后送达，远端慢时可能远超 1s，
 * 所以兜底只覆盖「信号永远不会来」（主进程异常），必须放得足够宽：
 * 定得太小会让波纹在 splash 还开着的时候就播完（用户只看到白屏）。
 *
 * 取 7000ms：splash 覆盖前两段 + 静默（WRITE 1500 + SPLASH 1500 + GAP 200 = 3200ms），
 * 正常路径信号在 ~3200ms 到达；7000 给了一倍余量。真正的「信号永不到来」只在主进程
 * 出 bug 时发生，那时多等几秒也胜过把主界面永久挡在白遮罩后。
 */
const FALLBACK_MS = 7000;

/**
 * 波前羽化带（占半径百分比）：内容在这条带里由全白遮罩渐变到全透，
 * 于是主界面是「随扩散一起渐显」，而不是被硬边洞口一下子切出来。
 */
export const FEATHER_BANDS = [0, 0.35, 0.7, 1] as const;
export const FEATHER_SPAN_PCT = 22;

/**
 * 生成遮罩用的 radial-gradient。
 *
 * 关键：CSS 遮罩按 **alpha** 取值——`transparent`（alpha 0）是洞（露出主界面），
 * `#000`（alpha 1）是完整白底。中间插入若干 alpha 递增的色标即形成羽化带，
 * 波前经过时遮罩逐渐变透明，内容随之渐显。
 */
export function revealMaskImage(revealPct: number): string {
  const r = Math.min(100, Math.max(0, revealPct));
  const stops = FEATHER_BANDS.map((alpha, i) => {
    const at = r + (FEATHER_SPAN_PCT * i) / (FEATHER_BANDS.length - 1);
    return `rgba(0, 0, 0, ${alpha}) ${Math.min(100, at).toFixed(2)}%`;
  });
  // 洞内全透明；带内 alpha 爬升；带外完全不透明白底
  return `radial-gradient(circle at 50% 50%, transparent ${r.toFixed(2)}%, ${stops.join(", ")}, #000 100%)`;
}

/** ease-out cubic：揭示进度的缓出曲线（0→1）。 */
export function easeOutCubic(p: number): number {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  return 1 - Math.pow(1 - t, 3);
}

interface BootWaveProps {
  /** 动画完成回调（遮罩已完全揭开，可卸载）。只调用一次。 */
  onDone: () => void;
  /**
   * 在声波段之前先播「逐笔写出 Heming」的手写段。
   *
   * 桌面端由 splash 窗口负责手写段（那边还接着粒子聚拢），所以传 false，避免写两遍；
   * 浏览器 / 预览环境没有 splash 窗口，传 true 才能看到写字动画。
   */
  writeFirst?: boolean;
}

/** 组件自带的样式：遮罩揭示靠 CSS 变量 `--reveal`（由 rAF 逐帧写入，不依赖 @property）。 */
const STYLES = `
  .boot-wave {
    position: fixed; inset: 0; z-index: 9999;
    /* 吞掉动画期间的所有指针事件（规格 §7：动画不可跳过，不响应点击/键盘）。
       键盘由 App 在主界面容器上挂 inert 挡住。遮罩揭完即卸载，不残留拦截。 */
    pointer-events: auto;
    cursor: default;
    overflow: hidden;
  }
  /* 白底揭示层：以中心为圆心的透明洞从 0% 涨到 100%。
     洞沿有一段 alpha 渐变的**羽化带**（见 revealMaskImage），
     主界面内容随波前经过而渐显，不是硬边切出来。
     --reveal 未写入时回落到 0% —— 即「信号到达前完全不透明」。 */
  .boot-wave-reveal {
    position: absolute; inset: 0;
    background: #ffffff;
    mask-image: var(--reveal-mask, radial-gradient(circle at 50% 50%, transparent 0%, #000 22%));
    -webkit-mask-image: var(--reveal-mask, radial-gradient(circle at 50% 50%, transparent 0%, #000 22%));
    mask-repeat: no-repeat;
    -webkit-mask-repeat: no-repeat;
    mask-size: 100% 100%;
    -webkit-mask-size: 100% 100%;
  }
  /* 波前光晕：跟着洞沿走，给「扩散」一个可看见的锋面（纯装饰，不参与遮罩）。 */
  .boot-wave-front {
    position: absolute; left: 50%; top: 50%;
    width: 24px; height: 24px; margin: -12px 0 0 -12px;
    border-radius: 50%;
    pointer-events: none;
    background: radial-gradient(circle, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.04) 55%, rgba(0,0,0,0) 72%);
    transform: scale(var(--reveal-scale, 1));
    opacity: var(--reveal-front-opacity, 0);
  }
  /* 3 圈细线波纹叠在揭示层之上（不参与遮罩，否则会被中心洞吃掉） */
  .boot-wave .ripple {
    position: absolute; left: 50%; top: 50%;
    width: 40px; height: 40px;
    border: 1.5px solid #1a1a1a; border-radius: 50%;
    opacity: 0;
    animation: boot-ripple-expand 1.3s ease-out forwards;
  }
  .boot-wave .ripple:nth-of-type(1) { animation-delay: 0s; }
  .boot-wave .ripple:nth-of-type(2) { animation-delay: 0.3s; }
  .boot-wave .ripple:nth-of-type(3) { animation-delay: 0.6s; }
  @keyframes boot-ripple-expand {
    0% { opacity: 0.6; transform: translate(-50%,-50%) scale(1); }
    100% { opacity: 0; transform: translate(-50%,-50%) scale(30); }
  }
`;

/**
 * 声波扩散段：一块全屏白底遮罩盖在**常驻的主界面**之上，以中心为圆心开一个透明洞，
 * 洞从 0% 涨到 100%（1.3s，ease-out cubic），波纹经过的区域主界面内容
 * （导航栏/内容区/文件树）从中心向外渐次显现；同时 3 圈细线波纹同步扩散。
 *
 * 与粒子聚拢段（splash 1.5s）+ 静默（0.2s）组成约 3s 的完整启动动画。
 * 启动信号由主进程 did-finish-load 后经 preload 的 window.heming.__startBootWave() 触发；
 * 本组件只**调用** preload 的 __onBootReady 注册回调（contextBridge 暴露的对象被冻结，
 * 渲染进程不可注入）。preload 会缓冲信号，注册晚于信号也能立刻收到。
 *
 * 无 preload（浏览器直接打开）时无外部信号源，直接开播兜底。
 */
export function BootWave({ onDone, writeFirst = false }: BootWaveProps) {
  const revealRef = useRef<HTMLDivElement | null>(null);

  /** 手写段是否正在播（仅 writeFirst 且无 preload 信号通道时才会为 true）。 */
  const [writing, setWriting] = useState(false);

  /**
   * 播放轮次：0 = 尚未开播；每次（重）开播 +1。
   * 它同时兼任波纹容器的 key —— key 变化才会让 3 圈波纹**重新挂载**，
   * CSS keyframes 动画才会从 0 重播（仅复位布尔量时 React 复用同一节点，
   * 动画会停在已扩散完的透明状态）。
   */
  const [runId, setRunId] = useState(0);

  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const startedRef = useRef(false); // rAF/回调里的即时判重（state 更新是异步的）
  const finishedRef = useRef(false);
  /**
   * 开播音效只播一次：StrictMode 双跑 effect 时 startAnimation 会连开两轮，
   * 不守这一道的话两路振荡器会几乎同时叠加（gain 翻倍、听起来更响）。
   * 与 finishedRef 同属「跨轮次事实」，cleanup 不复位。
   */
  const soundPlayedRef = useRef(false);
  const onDoneRef = useRef(onDone);

  // onDone 每次渲染可能是新函数；用 ref 持有最新值，避免把动画生命周期绑到它上面。
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const stopTimers = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (fallbackRef.current !== null) {
      window.clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
  }, []);

  /** 收尾：停掉所有定时器并回调 onDone（rAF 与兜底定时器双触发，只有一次生效）。 */
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    stopTimers();
    onDoneRef.current();
  }, [stopTimers]);

  /** 开播：清掉兜底定时器，用 rAF 逐帧把 --reveal 从 0% 推到 100%。 */
  const startAnimation = useCallback(() => {
    if (startedRef.current || finishedRef.current) return;
    startedRef.current = true;
    if (fallbackRef.current !== null) {
      window.clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
    if (!soundPlayedRef.current) {
      soundPlayedRef.current = true;
      playSound();
    }
    // 轮次 +1：波纹容器换 key → 重新挂载 → CSS 动画从 0 重播（StrictMode 重播时必需）
    setRunId((n) => n + 1);

    // 完成不能只依赖 rAF：splash 是覆盖整个工作区的 alwaysOnTop 窗口，Chromium 可能据此
    // 判定主窗口被遮挡并暂停其 rAF（连同渲染）。那样揭示永远停在 0%、遮罩永不卸载，
    // 主界面会被永久盖住。故用定时器兜底完成（多加 80ms 让最后一帧 rAF 先落地）；
    // 视觉平滑仍由 rAF 负责，finishedRef 保证两者不会重复回调。
    timerRef.current = window.setTimeout(finish, WAVE_MS + COMPLETE_SLACK_MS);

    // 时间基准取 rAF 自身的时间戳（同一时钟源，无需 performance.now）
    let t0: number | null = null;
    const tick = (now: number) => {
      if (t0 === null) t0 = now;
      const eased = easeOutCubic((now - t0) / WAVE_MS);
      const pct = eased * 100;
      const el = revealRef.current;
      // 遮罩（含羽化带）整条写进 --reveal-mask：内容随之渐显，而不是硬边洞口
      el?.style.setProperty("--reveal-mask", revealMaskImage(pct));
      el?.style.setProperty("--reveal", `${pct.toFixed(2)}%`);
      // 波前：半径按洞的比例放大（70vmax 铺满全屏），透明度随推进淡出
      el?.style.setProperty("--reveal-scale", (pct / 100 / 0.7).toFixed(4));
      el?.style.setProperty("--reveal-front-opacity", (0.9 * (1 - eased)).toFixed(3));
      if (eased >= 1) {
        rafRef.current = null;
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [finish]);

  useEffect(() => {
    // jsdom 未实现 matchMedia；真实浏览器/Electron 有。缺失时按未开启减弱动态处理。
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // 减弱动态：不播动画，立刻揭开遮罩
      finish();
      return;
    }

    const heming = window.heming;
    if (typeof heming?.__onBootReady === "function") {
      heming.__onBootReady(() => startAnimation());
      // 兜底：信号通道存在但信号永远不来时自动开播，否则白底遮罩会永久挡住界面
      fallbackRef.current = window.setTimeout(startAnimation, FALLBACK_MS);
    } else if (writeFirst) {
      // 浏览器/预览：没有 splash 窗口，手写段改在遮罩上自己播，播完再进声波段
      setWriting(true);
    } else {
      // 无可用信号通道（浏览器直接打开）且不需要手写段时直接开播
      startAnimation();
    }

    return () => {
      stopTimers();
      setWriting(false);
      /*
       * 兜底：React 18 StrictMode 在开发模式下会把 effect 跑两遍
       * （挂载 → cleanup → 再挂载）。cleanup 已经取消了 rAF 和收尾定时器，
       * 若不同时复位 startedRef，第二轮 startAnimation() 会命中开头的
       * `if (startedRef.current || finishedRef.current) return;` 静默早退 ——
       * 结果没有任何东西再推进 --reveal、finish() 永不被调用，白遮罩永久停在 0%，
       * 主界面被永久盖住（vite dev 下整页白屏；vite build 因不双跑 effect 而正常）。
       *
       * 只复位 startedRef / 揭示进度，**不复位 finishedRef**：
       * finishedRef 的职责是「onDone 只回调一次」（遮罩已揭开，不能重复通知宿主），
       * 它是跨轮次的事实，一旦为 true 就必须一直为 true。这样即便第一轮已经 finish()，
       * 第二轮也只会走到开头的早退分支：既不会重复回调 onDone，也不会重新开播。
       */
      startedRef.current = false;
      if (!finishedRef.current) {
        // 未完成即被取消（重播）：把洞收回 0%，让下一轮从完全不透明的白板重新播放
        const el = revealRef.current;
        el?.style.setProperty("--reveal", "0%");
        el?.style.setProperty("--reveal-mask", revealMaskImage(0));
        el?.style.setProperty("--reveal-scale", "0");
        el?.style.setProperty("--reveal-front-opacity", "0");
      }
    };
  }, [finish, startAnimation, stopTimers, writeFirst]);

  return (
    <div className="boot-wave" aria-hidden="true">
      <style>{STYLES}</style>
      <div className="boot-wave-reveal" ref={revealRef}>
        <div className="boot-wave-front" />
      </div>
      {writing && (
        <WordmarkWrite
          onDone={() => {
            setWriting(false);
            startAnimation();
          }}
        />
      )}
      {runId > 0 && (
        <div className="boot-wave-ripples" key={runId}>
          <div className="ripple" />
          <div className="ripple" />
          <div className="ripple" />
        </div>
      )}
    </div>
  );
}

/** Web Audio 合成声波音效（零外部资源）；音频不可用时静默。 */
function playSound(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = 440;
    osc2.type = "sine"; osc2.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.1);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.3);
    osc.connect(gain); osc2.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime); osc2.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 1.3); osc2.stop(ctx.currentTime + 1.3);
  } catch { /* 音频不可用静默 */ }
}
