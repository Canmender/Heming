/**
 * d.67 T4 · 视口断点纯函数与 hook 的定向用例。
 */
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { NARROW_BREAKPOINT, isNarrow, readViewportWidth, useViewport } from "./viewport.js";

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

describe("viewport · 断点边界", () => {
  afterEach(() => {
    setWidth(1280);
  });

  it("断点常量为 1200（与 arbitrary variants 同口径）", () => {
    expect(NARROW_BREAKPOINT).toBe(1200);
  });

  it("isNarrow：1199 窄、1200 宽、1280 宽（边界含在本侧）", () => {
    expect(isNarrow(1199)).toBe(true);
    expect(isNarrow(1200)).toBe(false);
    expect(isNarrow(1280)).toBe(false);
    expect(isNarrow(0)).toBe(true);
    expect(isNarrow(-1)).toBe(true);
  });

  it("isNarrow：非法宽度不误判为窄窗", () => {
    expect(isNarrow(Number.NaN)).toBe(false);
    expect(isNarrow(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("readViewportWidth 读 window.innerWidth；0/非法回落 1280", () => {
    setWidth(1024);
    expect(readViewportWidth()).toBe(1024);
    setWidth(0);
    expect(readViewportWidth()).toBe(1280);
  });
});

describe("viewport · useViewport", () => {
  afterEach(() => {
    setWidth(1280);
  });

  it("初始渲染读取当前宽度并按断点给出 narrow", () => {
    setWidth(1024);
    const { result } = renderHook(() => useViewport());
    expect(result.current).toEqual({ width: 1024, narrow: true });
  });

  it("resize 后更新宽度与 narrow（1199→1200 跨边界）", () => {
    setWidth(1199);
    const { result } = renderHook(() => useViewport());
    expect(result.current.narrow).toBe(true);

    act(() => {
      setWidth(1200);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toEqual({ width: 1200, narrow: false });

    act(() => {
      setWidth(1024);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toEqual({ width: 1024, narrow: true });
  });

  it("卸载后移除 resize 监听（不再 setState）", () => {
    setWidth(1024);
    const { result, unmount } = renderHook(() => useViewport());
    expect(result.current.width).toBe(1024);
    unmount();
    expect(() => {
      act(() => {
        setWidth(1280);
        window.dispatchEvent(new Event("resize"));
      });
    }).not.toThrow();
  });
});
