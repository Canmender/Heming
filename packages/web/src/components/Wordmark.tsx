import { WORDMARK_STROKES, WORDMARK_VIEWBOX } from "./wordmarkGlyphs.js";

interface WordmarkProps {
  /** 渲染宽度（px）；高度按 viewBox 比例（8:3）自动。 */
  width?: number;
  className?: string;
}

/**
 * 「Heming」手写字样（静态）。
 *
 * 字形数据来自 `wordmark.ts`（单一真源）。颜色取 `currentColor`，
 * 由使用处用 text-* 类决定；笔画为等宽圆头细线，与项目图标语言一致。
 *
 * 登录页用它作右侧品牌字样。启动动画的手写段在 splash 窗口里另有一份
 * 会逐笔描出的实现（桌面端原生页要求自包含，无法 import 本模块）。
 */
export function Wordmark({ width = 320, className }: WordmarkProps) {
  const height = Math.round((width * 150) / 400);
  return (
    <svg
      role="img"
      aria-label="Heming"
      viewBox={WORDMARK_VIEWBOX}
      width={width}
      height={height}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {WORDMARK_STROKES.map((s, i) => (
        <path key={i} d={s.d} />
      ))}
    </svg>
  );
}
