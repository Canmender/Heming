/**
 * 统一骨架块（d.63 · T3）。
 *
 * 视觉走 `index.css` 的 `.ui-skeleton`（`bg-line-soft` + pulse；`prefers-reduced-motion`
 * 下由 index.css 已有规则关掉动画）。组件只负责几何：
 * `SkeletonLine` 一行、`SkeletonBlock` 一块、`SkeletonCard` 卡片轮廓 + 若干行。
 *
 * 为什么 `aria-hidden`：骨架是「加载中」的视觉占位，页面应在外层用一个
 * `role="status" aria-label="正在加载"` 的容器播报一次；块本身再被读屏念一遍就是噪音。
 * 这也让页面既有用例的「正在加载」状态查询保持有效。
 */
export interface SkeletonProps {
  /** 额外类（尺寸/间距由使用处决定，例如 `h-7 rounded-lg`）。 */
  className?: string;
}

/** 一行骨架。默认 h-3；需要块状时传 `className="h-7"`。 */
export function SkeletonLine({ className = "" }: SkeletonProps) {
  return <div aria-hidden="true" className={`ui-skeleton h-3 w-full${className ? ` ${className}` : ""}`} />;
}

/** 一块骨架（方形/矩形占位）。默认 h-24 通栏。 */
export function SkeletonBlock({ className = "h-24 w-full rounded-lg" }: SkeletonProps) {
  return <div aria-hidden="true" className={`ui-skeleton${className ? ` ${className}` : ""}`} />;
}

/** 卡片骨架：卡片边框 + 标题行 + `lines` 行正文。 */
export function SkeletonCard({
  lines = 3,
  className = "",
}: SkeletonProps & { lines?: number }) {
  return (
    <div
      aria-hidden="true"
      // d.138：走 .ui-card，别再手写 border + bg-white + shadow-card——
      // 骨架也是卡片，暗色下必须跟真卡片同底色（写死 bg-white 会闪一块白）。
      className={`ui-card p-3${className ? ` ${className}` : ""}`}
    >
      <SkeletonLine className="mb-2 h-4 w-2/5" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: Math.max(0, lines) }, (_, i) => (
          <SkeletonLine key={i} className={i === lines - 1 ? "w-3/5" : ""} />
        ))}
      </div>
    </div>
  );
}
