/**
 * 开关基元（d.138 · 阶段 2）。
 *
 * 起因：`ContextSettingsCard.tsx:34`、`MemoryPage.tsx:311`、`SkillsPage.tsx:344` 各写了
 * 一份**逐字节相同**的 `Switch`——18×32 的圆角按钮、`role="switch"`、`aria-checked`、
 * 滑块用 inline style 取 `--switch-knob` / `--heming-on-accent`。
 * 三份拷贝意味着改一次开关（尺寸、动效、禁用态、打印样式）要改三个文件，
 * 而且只要有一处漏改，同一个应用里就会出现两种开关。
 *
 * 尺寸与配色刻意保持原样（18×32 / 滑块 14 / `bg-ink`）：这是「收口」不是「重设计」，
 * 统一之后视觉上应该看不出变化。
 *
 * 可访问名走 `aria-label`——调用方给的是「和小鸣 短期记忆」这类完整句子，
 * 所以这里不渲染可见文字标签；需要可见标签时由调用方在外部排版。
 *
 * d.140 R4：视觉尺寸仍是 18×32，但用 `after:` 伪元素把**可点击区**撑到 32×48 ——
 * 原先按钮本体只有 18px 高，远低于 32px 触摸目标标尺（审计 C-S2-18）。
 * 伪元素属于按钮盒子，点击/触摸会命中按钮本身，不改变布局也不用额外包裹层。
 */
export interface SwitchProps {
  /** 可访问名（读屏播报的就是这句）。 */
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 禁用：仍然可聚焦但不可切换，语义交给 `aria-disabled`。 */
  disabled?: boolean;
  /** 额外容器类（对齐、间距）。 */
  className?: string;
}

export function Switch({ label, checked, onChange, disabled = false, className = "" }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150 after:absolute after:-inset-x-2 after:-inset-y-[7px] after:content-[''] ${
        checked ? "bg-ink" : "bg-[color:var(--switch-off)]"
      }${disabled ? " cursor-not-allowed opacity-50" : ""}${className ? ` ${className}` : ""}`}
    >
      <span
        style={{ backgroundColor: checked ? "var(--heming-on-accent)" : "var(--switch-knob)" }}
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all duration-150 ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}
