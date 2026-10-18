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
 * 挂载时向 window.heming 注入 __onBootReady / __startBootWave 的默认实现
 * （preload 暴露的同名键初始为 null，主进程只负责调用 __startBootWave）；
 * 若外部已提供可用的同名函数（如测试注入）则保留不覆盖。
 * 无可用外部信号通道（浏览器直接打开，或 contextBridge 冻结致注入未生效）时直接开播兜底。
 */
export function BootWave({ onDone }: BootWaveProps) {
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "playing" | "done">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const existing = (window as any).heming;
    const heming = existing ?? {};
    // 判定挂载前是否存在「可用的外部信号通道」：
    // 仅当 window.heming.__onBootReady 已是函数（测试注入 / 修复后的 preload）才等待外部信号。
    // 真实 Electron 下 window.heming 由 contextBridge 暴露（contextIsolation + sandbox），
    // 对象被冻结、属性不可写——严格模式下赋值会抛 TypeError，故注入必须 best-effort。
    const externalReady = typeof heming.__onBootReady === "function";

    // 仅在缺失时注入默认实现（避免覆盖外部注入的同名函数）；冻结对象上注入失败可忽略
    try {
      if (!externalReady) {
        heming.__onBootReady = (cb: () => void) => {
          heming.__bootCallback = cb;
        };
      }
      if (typeof heming.__startBootWave !== "function") {
        heming.__startBootWave = () => {
          if (heming.__bootCallback) heming.__bootCallback();
        };
      }
      (window as any).heming = heming;
    } catch {
      /* contextBridge 冻结对象不可写：无可用外部通道，走兜底直接开播 */
    }

    // jsdom 未实现 matchMedia；真实浏览器/Electron 有。缺失时按未开启减弱动态处理。
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      onDone();
      return;
    }

    if (externalReady) {
      // 有可用外部信号通道：注册回调，等待主进程调用 __startBootWave
      heming.__onBootReady(() => {
        startAnimation();
      });
    } else {
      // 兜底：无可用外部信号通道（浏览器直接打开，或 contextBridge 冻结致注入未生效）直接开播
      startAnimation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startAnimation() {
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
