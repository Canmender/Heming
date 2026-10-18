import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { BootWave, easeOutCubic } from "./BootWave.js";

/** 与 splash-config.js 的 WAVE_MS / FALLBACK_MS 语义对齐的测试常量。 */
const WAVE_MS = 1300;
const FALLBACK_MS = 5000;

/**
 * rAF 揭示循环需要 requestAnimationFrame + 时钟一起被伪造才能确定性推进：
 * vitest 的默认 toFake 不含 rAF，故此处显式列出。
 */
function useWaveFakeTimers(): void {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
      "performance",
    ],
  });
}

/** 遮罩揭示层：`--reveal` 未写入 = 回落到 0%（完全不透明白底）。 */
function revealLayer(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".boot-wave-reveal");
  expect(el).toBeTruthy();
  return el!;
}

function revealValue(): string {
  return revealLayer().style.getPropertyValue("--reveal");
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".boot-wave");
}

/** 模拟 preload：可控启动信号通道。 */
function installSignalChannel() {
  let callback: (() => void) | null = null;
  const heming = {
    platform: "win32",
    __onBootReady: vi.fn((cb: () => void) => {
      callback = cb;
    }),
    __startBootWave: vi.fn(() => {
      callback?.();
    }),
  };
  window.heming = heming;
  return {
    heming,
    fire: () => act(() => heming.__startBootWave()),
  };
}

describe("easeOutCubic", () => {
  it("端点固定：0 → 0、1 → 1，并夹住越界输入", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("缓出：前段推进快于线性，全程单调不减", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = easeOutCubic(i / 10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("BootWave", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 清理 window.heming（前一用例残留会误判「有信号通道」）
    window.heming = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 遮罩常驻：信号到达前必须是一块完全不透明的白板（否则启动帧会闪真实 UI） ──
  it("挂载即渲染全屏遮罩，且揭示层在开播前完全不透明（--reveal 未写入）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    render(<BootWave onDone={vi.fn()} />);

    expect(overlay()).toBeTruthy();
    // 遮罩铺满视口 + 置顶
    const css = document.querySelector(".boot-wave style")!.textContent!;
    expect(css).toContain("position: fixed");
    expect(css).toContain("inset: 0");
    // 白底 + 由 --reveal 驱动的中心透明洞
    expect(css).toContain("background: #ffffff");
    expect(css).toContain("mask-image: radial-gradient(circle at 50% 50%, transparent var(--reveal, 0%)");
    expect(css).toContain("-webkit-mask-image: radial-gradient(circle at 50% 50%, transparent var(--reveal, 0%)");
    // 关键：开播前没有任何 --reveal 内联值 → 回落到 0% → 完全遮住主界面
    expect(revealValue()).toBe("");
    // 未开播也不渲染波纹（避免信号没来时白板上漂着几圈线）
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);

    channel.fire(); // 用完信号通道，避免 watch 噪声
  });

  it("主界面内容在遮罩之下（遮罩不拦截鼠标事件）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    render(
      <>
        <button type="button">被遮住的主界面</button>
        <BootWave onDone={vi.fn()} />
      </>,
    );
    const css = document.querySelector(".boot-wave style")!.textContent!;
    expect(css).toContain("pointer-events: none");
    expect(overlay()!.nextSibling).toBeNull(); // 遮罩是最后一个节点 → 叠在最上层
    channel.fire();
  });

  it("只调用 preload 的 __onBootReady 注册回调，不覆盖 window.heming", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    render(<BootWave onDone={vi.fn()} />);

    expect(channel.heming.__onBootReady).toHaveBeenCalledTimes(1);
    expect(typeof channel.heming.__onBootReady.mock.calls[0][0]).toBe("function");
    expect(window.heming).toBe(channel.heming);
  });

  // ── 揭示：从中心向外涨到 100%，完成后回调 onDone（且只回调一次） ──
  it("收到启动信号后波纹出现，揭示半径随时间单调增长直到 100%，onDone 只调用一次", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);

    channel.fire();
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);

    // 推进半个动画：洞已明显张开，但还没走完
    act(() => {
      vi.advanceTimersByTime(WAVE_MS / 2);
    });
    const mid = parseFloat(revealValue());
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    expect(onDone).not.toHaveBeenCalled();

    // 推进到动画结束：洞涨到 100%，遮罩完全揭开
    act(() => {
      vi.advanceTimersByTime(WAVE_MS);
    });
    expect(revealValue()).toBe("100.00%");
    expect(onDone).toHaveBeenCalledTimes(1);

    // 继续推进：rAF 循环已停，不会重复回调
    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS * 2);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("揭示进度逐帧增长（不是一次性跳变）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    render(<BootWave onDone={vi.fn()} />);
    channel.fire();

    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      act(() => {
        vi.advanceTimersByTime(WAVE_MS / 8);
      });
      samples.push(parseFloat(revealValue()));
    }
    // 严格递增（每个采样点都比上一帧更开）
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(90);
  });

  // ── 信号通道的各种退化情形 ──
  it("prefers-reduced-motion 时立即揭开并回调（不播动画）", () => {
    useWaveFakeTimers();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
    // 未开播：没有波纹，也没有 rAF 揭示
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);
    expect(revealValue()).toBe("");
  });

  it("无信号通道（浏览器直接打开）时直接开播，不空等遮罩", () => {
    useWaveFakeTimers();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(WAVE_MS + 100);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("contextBridge 冻结对象（__onBootReady 为 null）不崩溃且兜底开播", () => {
    useWaveFakeTimers();
    // 模拟只有 platform、两个内部通道缺失/为 null 的桥接对象（冻结，不可写）
    window.heming = Object.freeze({
      platform: "win32",
      __onBootReady: null,
      __startBootWave: null,
    }) as unknown as Window["heming"];
    const onDone = vi.fn();
    expect(() => render(<BootWave onDone={onDone} />)).not.toThrow();
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);
  });

  // 回归：真实信号是 did-finish-load + 静默间隔后才到，远端慢时可远超 1s。
  // 兜底必须足够宽，否则波纹会在 splash 还开着时就播完（用户只看到白屏）。
  it("有信号通道但信号 5s 内不到：遮罩保持不透明，第 5s 才兜底开播", () => {
    useWaveFakeTimers();
    installSignalChannel(); // 通道存在，但测试从不 fire
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);

    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS - 1);
    });
    // 仍在等信号：白板完整，没有波纹，没有揭示
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);
    expect(revealValue()).toBe("");
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);
  });

  it("信号到达时清掉兜底定时器，两者互斥不重复开播", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);

    channel.fire();
    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS * 2);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("重复信号只开播一次（rAF 循环与 onDone 都不翻倍）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);

    channel.fire();
    channel.fire();
    channel.fire();
    act(() => {
      vi.advanceTimersByTime(WAVE_MS * 2);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("卸载时停掉 rAF/定时器，不再回调 onDone", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const onDone = vi.fn();
    const { unmount } = render(<BootWave onDone={onDone} />);
    channel.fire();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(WAVE_MS * 3);
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("挂载即渲染遮罩与揭示层（开播前无波纹）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const { container } = render(<BootWave onDone={vi.fn()} />);
    expect(container.querySelectorAll(".boot-wave")).toHaveLength(1);
    expect(container.querySelectorAll(".boot-wave-reveal")).toHaveLength(1);
    expect(container.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);
    channel.fire();
  });
});
