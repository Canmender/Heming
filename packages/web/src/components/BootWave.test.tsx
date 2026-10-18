import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { BootWave } from "./BootWave.js";

describe("BootWave", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 清理 window.heming
    (window as any).heming = undefined;
  });

  it("渲染波纹元素", () => {
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    expect(document.querySelector(".boot-wave")).toBeTruthy();
  });

  it("动画完成后调用 onDone", async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    act(() => { vi.advanceTimersByTime(1300); });
    await vi.waitFor(() => { expect(onDone).toHaveBeenCalled(); });
    vi.useRealTimers();
  });

  it("prefers-reduced-motion 时直接调用 onDone", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as any);
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    expect(onDone).toHaveBeenCalled();
  });

  it("注入 __onBootReady 到 window.heming", () => {
    render(<BootWave onDone={vi.fn()} />);
    expect((window as any).heming?.__onBootReady).toBeDefined();
  });

  it("__startBootWave 触发已注册回调", async () => {
    let callback: (() => void) | null = null;
    (window as any).heming = {
      __onBootReady: (cb: () => void) => { callback = cb; },
      __startBootWave: () => { callback?.(); }
    };
    render(<BootWave onDone={vi.fn()} />);
    expect(callback).not.toBeNull();
    act(() => { (window as any).heming.__startBootWave(); });
    // 波纹应该出现
    expect(document.querySelector(".boot-wave .ripple")).toBeTruthy();
  });

  // 回归：真实 Electron 下 window.heming 由 contextBridge 暴露，对象被冻结、属性不可写。
  // 组件注入默认实现会抛 TypeError（严格模式），必须容错并走兜底直接开播，不得崩溃。
  it("contextBridge 冻结对象（不可写）不崩溃且兜底开播", () => {
    const frozen = Object.freeze({ platform: "win32", __onBootReady: null, __startBootWave: null });
    (window as any).heming = frozen;
    const onDone = vi.fn();
    expect(() => render(<BootWave onDone={onDone} />)).not.toThrow();
    // 无可用外部通道 → 直接开播，波纹渲染
    expect(document.querySelector(".boot-wave .ripple")).toBeTruthy();
  });
});
