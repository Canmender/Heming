import type { ReactNode } from "react";

/**
 * 键帽基元（2026-11-14 审计 C2）。
 *
 * 背景：全站 12 处手写 `<kbd>`，三种外观（有的 border + bg-subtle、有的只加底色、
 * 有的干脆把字号写到 10px 以下），快捷键页/命令面板/导航提示各写各的，同一个「⌘K」在三个
 * 地方长得不一样。键帽是**元信息**，不是按钮，尺寸固定一档：
 *   · 高 20px（h-5）、左右 4px（px-1），字符居中；
 *   · 等宽字体（font-mono）保证 ⌘ / Ctrl / 字母的组合键宽度可预期；
 *   · 11px 是白名单字号（键帽/徽标/时间戳这类不可再缩的元信息）。
 *
 * 组合键请用 `<Kbd>` 并列渲染（`<Kbd>Ctrl</Kbd><Kbd>K</Kbd>`），中间由父级 gap 分隔，
 * 不要在同一个人组件里拼「Ctrl+K」字符串——那会让不同字体的宽度对不齐。
 */
export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className = "" }: KbdProps) {
  return (
    <kbd
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-line-soft px-1 font-mono text-ui-xs font-medium leading-none text-muted ${className}`.trim()}
    >
      {children}
    </kbd>
  );
}
