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

  it("调用 preload 的 __onBootReady 注册回调（不注入、不覆盖 heming）", () => {
    const heming: any = { __onBootReady: vi.fn() };
    (window as any).heming = heming;
    render(<BootWave onDone={vi.fn()} />);
    // 组件「调用」preload 注册接口并传入回调；window.heming 原对象未被覆盖
    expect(heming.__onBootReady).toHaveBeenCalledTimes(1);
    expect(typeof heming.__onBootReady.mock.calls[0][0]).toBe("function");
    expect((window as any).heming).toBe(heming);
    // 未收到启动信号前不渲染波纹
    expect(document.querySelector(".boot-wave")).toBeNull();
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
  // 组件只「调用」__onBootReady（不注入），故冻结对象不崩溃；此处 __onBootReady 为 null
  //（无可用信号通道）时走兜底直接开播。
  it("contextBridge 冻结对象（不可写）不崩溃且兜底开播", () => {
    const frozen = Object.freeze({ platform: "win32", __onBootReady: null, __startBootWave: null });
    (window as any).heming = frozen;
    const onDone = vi.fn();
    expect(() => render(<BootWave onDone={onDone} />)).not.toThrow();
    // 无可用信号通道 → 直接开播，波纹渲染
    expect(document.querySelector(".boot-wave .ripple")).toBeTruthy();
  });

  // 回归：信号通道存在但主进程迟迟不发信号（如远程加载极慢、did-finish-load 晚于门禁翻转）
  // 时，防御性兜底定时器（1700ms）自动开播，避免 BootWave 停在 null。
  it("有信号通道但信号未到：1700ms 兜底定时器自动开播（不再空等）", () => {
    vi.useFakeTimers();
    try {
      // __onBootReady 是函数（信号通道存在），但测试从不调用回调 → 模拟信号迟迟不到
      (window as any).heming = { __onBootReady: vi.fn(), __startBootWave: vi.fn() };
      const onDone = vi.fn();
      render(<BootWave onDone={onDone} />);
      // 信号未到前不渲染波纹
      expect(document.querySelector(".boot-wave")).toBeNull();
      // 推进到兜底窗口边界：自动开播，波纹出现
      act(() => { vi.advanceTimersByTime(1700); });
      expect(document.querySelector(".boot-wave .ripple")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // 回归：真实信号到达时清掉兜底定时器，两者互斥，不会重复开播。
  it("信号到达时清掉兜底定时器，随后再推进时间不重复开播", () => {
    vi.useFakeTimers();
    try {
      let callback: (() => void) | null = null;
      (window as any).heming = {
        __onBootReady: (cb: () => void) => { callback = cb; },
        __startBootWave: () => { callback?.(); },
      };
      const onDone = vi.fn();
      render(<BootWave onDone={onDone} />);
      // 信号先到（<1700ms），开播
      act(() => { (window as any).heming.__startBootWave(); });
      expect(document.querySelector(".boot-wave .ripple")).toBeTruthy();
      // 兜底定时器已被清除：继续推进远超 1700ms，onDone 只应被调用一次
      act(() => { vi.advanceTimersByTime(5000); });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
