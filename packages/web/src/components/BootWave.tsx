import { useCallback, useEffect, useRef, useState } from "react";

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
 */
const FALLBACK_MS = 5000;

/** ease-out cubic：揭示进度的缓出曲线（0→1）。 */
export function easeOutCubic(p: number): number {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  return 1 - Math.pow(1 - t, 3);
}

interface BootWaveProps {
  /** 动画完成回调（遮罩已完全揭开，可卸载）。只调用一次。 */
  onDone: () => void;
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
  /* 白底揭示层：以中心为圆心的透明洞从 0% 涨到 100%，洞经过的地方露出下面的主界面。
     --reveal 未写入时回落到 0% —— 即「信号到达前完全不透明」。 */
  .boot-wave-reveal {
    position: absolute; inset: 0;
    background: #ffffff;
    mask-image: radial-gradient(circle at 50% 50%, transparent var(--reveal, 0%), #000 calc(var(--reveal, 0%) + 0.5%));
    -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent var(--reveal, 0%), #000 calc(var(--reveal, 0%) + 0.5%));
    mask-repeat: no-repeat;
    -webkit-mask-repeat: no-repeat;
    mask-size: 100% 100%;
    -webkit-mask-size: 100% 100%;
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
export function BootWave({ onDone }: BootWaveProps) {
  const revealRef = useRef<HTMLDivElement | null>(null);
  const [started, setStarted] = useState(false);

  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const startedRef = useRef(false); // rAF/回调里的即时判重（state 更新是异步的）
  const finishedRef = useRef(false);
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
    playSound();
    setStarted(true);

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
      revealRef.current?.style.setProperty("--reveal", `${(eased * 100).toFixed(2)}%`);
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
    } else {
      // 无可用信号通道（浏览器直接打开）时直接开播
      startAnimation();
    }

    return () => {
      stopTimers();
    };
  }, [finish, startAnimation, stopTimers]);

  return (
    <div className="boot-wave" aria-hidden="true">
      <style>{STYLES}</style>
      <div className="boot-wave-reveal" ref={revealRef} />
      {started && (
        <div className="boot-wave-ripples">
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
