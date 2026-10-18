import { useEffect, useRef, useState } from "react";

interface BootWaveProps {
  /** 动画完成回调 */
  onDone: () => void;
}

/**
 * 声波扩散动画：3 圈同心圆从中心扩散，主界面内容从中心向外渐次浮现。
 * 时长 1.3s，与 splash 粒子聚拢段（1.5s）+ 静默（0.2s）组成完整约 3s 启动动画。
 * 启动信号由主进程 did-finish-load 后通过 window.heming.__startBootWave() 触发。
 *
 * 挂载时调用 preload 暴露的 window.heming.__onBootReady(cb) 注册启动回调，
 * 主进程 did-finish-load 后调用 window.heming.__startBootWave() 触发播放。
 * 无 preload（浏览器直接打开）时无外部信号源，直接开播兜底。
 *
 * 防御性兜底：即使有信号通道，也设 1700ms 兜底定时器——若主进程信号迟迟不到
 * （如远程加载极慢导致 did-finish-load 晚于 App 门禁翻转），仍会自动开播，
 * 避免 BootWave 停在 null（无波纹）。信号到达时清掉兜底定时器。
 */
export function BootWave({ onDone }: BootWaveProps) {
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "playing" | "done">("idle");
  const timerRef = useRef<number | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // jsdom 未实现 matchMedia；真实浏览器/Electron 有。缺失时按未开启减弱动态处理。
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      onDone();
      return;
    }

    // preload 通过 contextBridge 暴露 __onBootReady/__startBootWave（对象被冻结，
    // 渲染进程只读、不可注入），故此处只「调用」而非注入。
    const heming = (window as any).heming;
    if (typeof heming?.__onBootReady === "function") {
      heming.__onBootReady(() => {
        startAnimation();
      });
    } else {
      // 兜底：无可用信号通道（浏览器直接打开）时直接开播
      startAnimation();
    }

    // 防御性兜底：信号通道存在但信号迟迟不到时，1700ms 后自动开播（与 Task-4 草图一致）。
    // 已开播时 startAnimation 会清除该定时器，故真实信号与兜底互斥。
    fallbackRef.current = window.setTimeout(() => {
      startAnimation();
    }, 1700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startAnimation() {
    if (startedRef.current) return;
    startedRef.current = true;
    if (fallbackRef.current !== null) {
      window.clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
    playSound();
    setStarted(true);
    setPhase("playing");
    timerRef.current = window.setTimeout(() => {
      setPhase("done");
      onDone();
    }, 1300);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
    };
  }, []);

  function playSound() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
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

  if (!started) return null;

  return (
    <div className="boot-wave" aria-hidden="true">
      <style>{`
        .boot-wave {
          position: fixed; inset: 0; z-index: 9999;
          pointer-events: none;
          display: flex; align-items: center; justify-content: center;
        }
        .boot-wave .ripple {
          position: absolute; left: 50%; top: 50%;
          border: 1.5px solid #1a1a1a; border-radius: 50%;
          opacity: 0;
          animation: ripple-expand 1.3s ease-out forwards;
        }
        .boot-wave .ripple:nth-child(1) { width: 40px; height: 40px; animation-delay: 0s; }
        .boot-wave .ripple:nth-child(2) { width: 40px; height: 40px; animation-delay: 0.3s; }
        .boot-wave .ripple:nth-child(3) { width: 40px; height: 40px; animation-delay: 0.6s; }
        @keyframes ripple-expand {
          0% { opacity: 0.6; transform: translate(-50%,-50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%,-50%) scale(30); }
        }
      `}</style>
      <div className="ripple" />
      <div className="ripple" />
      <div className="ripple" />
    </div>
  );
}
