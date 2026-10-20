import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { BootWave, easeOutCubic, revealMaskImage } from "./BootWave.js";
import { WRITE_DRAW_MS, WRITE_TOTAL_MS } from "./WordmarkWrite.js";

/** 与 splash-config.js 的 WAVE_MS / FALLBACK_MS 语义对齐的测试常量。 */
const WAVE_MS = 1300;
const FALLBACK_MS = 7000;

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
    // 白底 + 中心透明洞；洞沿有羽化带（内容随扩散渐显，不是硬边跳变）
    expect(css).toContain("background: #ffffff");
    expect(css).toContain("mask-image: var(--reveal-mask, radial-gradient(circle at 50% 50%, transparent 0%");
    expect(css).toContain("-webkit-mask-image: var(--reveal-mask, radial-gradient(circle at 50% 50%, transparent 0%");
    expect(css).toContain(".boot-wave-front");
    // 关键：开播前没有任何 --reveal 内联值 → 回落到 0% → 完全遮住主界面
    expect(revealValue()).toBe("");
    // 未开播也不渲染波纹（避免信号没来时白板上漂着几圈线）
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);

    channel.fire(); // 用完信号通道，避免 watch 噪声
  });

  // 规格 §7：动画不可跳过（不响应点击/键盘）。遮罩必须吞掉指针事件，
  // 否则点击会落在「看得见但被盖住」的主界面按钮上。
  it("遮罩叠在最上层且吞掉指针事件（动画期间不可点击穿透）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    render(
      <>
        <button type="button">被遮住的主界面</button>
        <BootWave onDone={vi.fn()} />
      </>,
    );
    const css = document.querySelector(".boot-wave style")!.textContent!;
    expect(css).toContain("pointer-events: auto");
    // 只有装饰用的波前光晕显式退出命中测试，遮罩本身仍吞事件
    expect(css.match(/pointer-events: none/g)).toHaveLength(1);
    expect(css).toMatch(/\.boot-wave-front \{[^}]*pointer-events: none/);
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
  it("有信号通道但信号 7s 内不到：遮罩保持不透明，第 7s 才兜底开播", () => {
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

  // 回归（真机复现）：splash 是覆盖整个工作区的 alwaysOnTop 窗口，Chromium 可能据此
  // 判定主窗口被遮挡并暂停其 rAF。若完成只依赖 rAF，揭示会永远停在 0%、遮罩永不卸载，
  // 主界面被永久盖住 —— 此时必须由定时器兜底完成。
  it("rAF 被暂停（从不回调）时仍由定时器完成，遮罩不会永久盖住界面", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const onDone = vi.fn();
    // rAF 一帧都不给：模拟渲染进程被节流
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    render(<BootWave onDone={onDone} />);
    channel.fire();
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);

    // rAF 从未跑过：揭示仍停在 0%（遮罩完全不透明）
    expect(revealValue()).toBe("");

    // 定时器兜底：动画时长 + 余量之后必须收尾
    act(() => {
      vi.advanceTimersByTime(WAVE_MS + 80);
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    // 再推进也不会重复回调
    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS * 2);
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it("rAF 正常时不依赖兜底定时器（定时器被清掉，只回调一次）", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    channel.fire();

    act(() => {
      vi.advanceTimersByTime(WAVE_MS + 200);
    });
    expect(revealValue()).toBe("100.00%");
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

/**
 * 回归（真机复现）：React 18 StrictMode 在开发模式下会把 effect 跑两遍
 * （挂载 → cleanup → 再挂载）。现象：`vite` 开发模式下白遮罩永不卸载——
 * `--reveal` 从未被写入、`#root > div` 仍带 inert、整页白屏；而同一份代码
 * `vite build` + `vite preview` 完全正常（生产不双跑 effect）。
 *
 * 根因：第一轮 startAnimation() 置 startedRef=true 并挂上 rAF + 收尾定时器；
 * cleanup 的 stopTimers() 把它们全取消；第二轮 startAnimation() 命中
 * `if (startedRef.current || finishedRef.current) return;` 直接早退
 * → 没有任何东西再推进 --reveal，finish() 永远不会被调用，遮罩永久停在 0%。
 *
 * 修复方向：cleanup 复位「本轮已开播」的即时标记（startedRef）使第二轮能重播，
 * 但不复位 finishedRef（它保证 onDone 只回调一次）。
 */
describe("BootWave（React.StrictMode 双跑 effect）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.heming = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("StrictMode 双跑后仍能开播并推进到 100%，onDone 恰好调用 1 次", () => {
    useWaveFakeTimers();
    const onDone = vi.fn();
    render(
      <StrictMode>
        <BootWave onDone={onDone} />
      </StrictMode>,
    );

    // 无信号通道 → 直接开播；双跑后波纹仍在（第二轮必须重新开播，而不是静默早退）
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);

    // 推进定时器与帧：揭示必须真的往前走（修复前这里永远停在 ""，即 0%）
    act(() => {
      vi.advanceTimersByTime(WAVE_MS / 2);
    });
    expect(parseFloat(revealValue())).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(WAVE_MS);
    });
    expect(revealValue()).toBe("100.00%");
    expect(onDone).toHaveBeenCalledTimes(1);

    // 继续推进：不会重复回调
    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS * 2);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 下首轮已 finish（减弱动态）时，第二轮不重复回调 onDone 也不重新开播", () => {
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
    render(
      <StrictMode>
        <BootWave onDone={onDone} />
      </StrictMode>,
    );

    // finishedRef 不随 cleanup 复位 → 第二轮（及后续）不会再回调
    expect(onDone).toHaveBeenCalledTimes(1);
    // 已完成就不再开播：白遮罩上没有波纹，也没有揭示进度
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);
    expect(revealValue()).toBe("");
  });
});

/**
 * 手写段（`writeFirst`）：桌面端由 splash 窗口写字，浏览器/预览没有 splash，
 * 必须由 BootWave 自己在遮罩上先写「Heming」再进入声波揭示——否则网页上看到的是
 * 「一上来就是白屏 + 波纹」，用户会以为写字动画丢了（2026-10-18 用户反馈）。
 */
describe("BootWave 手写段（浏览器/预览：无 splash 窗口）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.heming = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writeFirst：先逐笔写字，写完才进入声波揭示", () => {
    useWaveFakeTimers();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} writeFirst />);

    // 手写段已挂载，声波段尚未开始（--reveal 未写入 = 遮罩全白）
    expect(document.querySelector(".wordmark-write")).toBeTruthy();
    expect(revealValue()).toBe("");
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(0);

    // 运笔中：仍是手写段，遮罩没动
    act(() => {
      vi.advanceTimersByTime(WRITE_DRAW_MS / 2);
    });
    expect(document.querySelector(".wordmark-write")).toBeTruthy();
    expect(revealValue()).toBe("");

    // 手写段整段结束 → 手写层卸载、声波段开播（+300ms 余量吸收 rAF 帧对齐误差）
    act(() => {
      vi.advanceTimersByTime(WRITE_TOTAL_MS + 300);
    });
    expect(document.querySelector(".wordmark-write")).toBeNull();
    expect(document.querySelectorAll(".boot-wave .ripple")).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(parseFloat(revealValue())).toBeGreaterThan(0);

    // 声波段收尾：onDone 恰好一次
    act(() => {
      vi.advanceTimersByTime(WAVE_MS + 200);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("writeFirst 且减弱动态：不播手写段也不播声波，立刻完成", () => {
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
    render(<BootWave onDone={onDone} writeFirst />);

    expect(document.querySelector(".wordmark-write")).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("默认（桌面端 splash 已写字）不播手写段，直接声波揭示", () => {
    useWaveFakeTimers();
    installSignalChannel();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);

    expect(document.querySelector(".wordmark-write")).toBeNull();
  });
});

describe("revealMaskImage（波前羽化：内容随扩散渐显）", () => {
  it("洞内透明、带内 alpha 递增、带外不透明 —— 而不是硬边跳变", () => {
    const css = revealMaskImage(40);
    expect(css.startsWith("radial-gradient(circle at 50% 50%")).toBe(true);
    expect(css).toContain("transparent 40.00%"); // 洞内：完全露出主界面
    // 羽化带：alpha 由 0 递增到 1，位置在洞沿之后
    expect(css).toContain("rgba(0, 0, 0, 0) 40.00%");
    expect(css).toContain("rgba(0, 0, 0, 0.35)");
    expect(css).toContain("rgba(0, 0, 0, 0.7)");
    expect(css).toContain("rgba(0, 0, 0, 1) 62.00%");
    expect(css.endsWith("#000 100%)")).toBe(true); // 带外完全不透明，白板收尾
  });

  it("羽化带宽度固定（FEATHER_SPAN_PCT），推进时整体平移", () => {
    const a = revealMaskImage(0);
    const b = revealMaskImage(50);
    expect(a).toContain("rgba(0, 0, 0, 1) 22.00%");
    expect(b).toContain("rgba(0, 0, 0, 1) 72.00%");
  });

  it("越界输入夹到 [0,100]，不会产出非法渐变", () => {
    expect(revealMaskImage(-10)).toContain("transparent 0.00%");
    expect(revealMaskImage(999)).toContain("transparent 100.00%");
  });
});

describe("BootWave 波前渐显接线", () => {
  it("开播推进时遮罩含羽化带，并驱动波前的缩放与淡出", () => {
    useWaveFakeTimers();
    const channel = installSignalChannel();
    render(<BootWave onDone={vi.fn()} />);
    channel.fire();

    act(() => {
      vi.advanceTimersByTime(WAVE_MS / 2);
    });

    const reveal = revealLayer();
    // 遮罩是一条带 alpha 渐变的渐变（内容随之渐显），不再是 0.5% 硬边
    expect(reveal.style.getPropertyValue("--reveal-mask")).toContain("rgba(0, 0, 0, 0.35)");
    expect(reveal.style.getPropertyValue("--reveal-mask")).not.toContain("+ 0.5%");
    // 波前跟着推进：缩放值已离开 0，透明度随推进下降
    const scale = Number(reveal.style.getPropertyValue("--reveal-scale"));
    expect(scale).toBeGreaterThan(0);
    const frontOpacity = Number(reveal.style.getPropertyValue("--reveal-front-opacity"));
    expect(frontOpacity).toBeGreaterThan(0);
    expect(frontOpacity).toBeLessThan(0.9);
    expect(document.querySelector(".boot-wave-front")).toBeTruthy();
  });
});
