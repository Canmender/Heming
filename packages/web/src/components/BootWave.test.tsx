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
});
