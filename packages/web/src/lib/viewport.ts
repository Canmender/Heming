/**
 * 视口宽度（d.67 T4 · 窄窗响应式）。
 *
 * 为什么单独抽一个文件而不是各页面自己 `window.innerWidth`：
 *   · 断点只有一处定义，App/PageShell/后续页面都从这里拿，不会出现 1199/1200 写歪；
 *   · 监听器只有一份（`resize`），不会每个组件各挂一个；
 *   · SSR / 单测（没有 window）有确定的宽度回落，纯函数 `isNarrow` 可单测。
 *
 * 断点口径：**<1200 即窄窗**（含 1199），与 Tailwind arbitrary variants
 * `max-[1199px]:` / `min-[1200px]:` 严格对齐；不新增 Tailwind breakpoint，
 * 避免动既有 `md:` / `lg:` 语义。
 */
import { useEffect, useState } from "react";

/** 窄窗断点：视口宽度 < 该值即为窄窗。 */
export const NARROW_BREAKPOINT = 1200;

/** 无 window（SSR / node 单测）时的回落宽度：按宽窗处理，保证既有布局不抖。 */
const FALLBACK_WIDTH = 1280;

/** 纯函数：宽度是否属于窄窗（边界值 1200 属于宽窗）。 */
export function isNarrow(width: number): boolean {
  if (!Number.isFinite(width)) return false;
  return width < NARROW_BREAKPOINT;
}

/** 读当前视口宽度；无 window / 非法值回落 1280（宽窗）。 */
export function readViewportWidth(): number {
  if (typeof window === "undefined") return FALLBACK_WIDTH;
  const width = window.innerWidth;
  return Number.isFinite(width) && width > 0 ? width : FALLBACK_WIDTH;
}

/**
 * 订阅视口宽度：返回 `{ width, narrow }`。
 *
 * 只监听 `resize`（拖窗口/最大化/分屏都会触发）；挂载时主动读一次，
 * 避免「首帧 state 与真实宽度不一致」时窄/宽布局错一帧。
 */
export function useViewport(): { width: number; narrow: boolean } {
  const [width, setWidth] = useState(readViewportWidth);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(readViewportWidth());
    onResize(); // 挂载即对齐（测试桩/首帧后改宽度都能收敛）
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, narrow: isNarrow(width) };
}
