import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

/**
 * 输入框基元（d.138 · 阶段 2 的第二块）。
 *
 * 现在表单各写各的：`<label className="ui-caption">昵称<input className="mt-1 block w-full ui-input"/></label>`
 * 写对了是运气，写漏了没人发现——错误行有的用 `text-red-600`、有的用 `--danger`，
 * 而且绝大多数**没有**把错误行和输入框连起来（`aria-describedby` / `aria-invalid`），
 * 读屏只会说「编辑框」，不会说「哪里错了」。
 *
 * 这一层只做三件事：可见 label 与控件绑定、hint / error 用同一套排版档、
 * 出错时自动接好 `aria-invalid` + `aria-describedby`（读屏能念出原因）。
 * 样式仍落在 `.ui-input` / `.ui-caption` 上——不引入第二套输入框样式。
 */
export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  /** 可见标签；同时作为控件的可访问名（不靠 placeholder）。 */
  label: string;
  /** 常驻说明（格式、限制、后果）；出错时让位给 error，避免两句话打架。 */
  hint?: ReactNode;
  /** 错误说明；非空时设置 `aria-invalid` 并让读屏跟随。 */
  error?: string | null;
  /** 追加在字段容器上的布局类（宽、间距等）；不要用它改字号或颜色。 */
  className?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className = "", id, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? `field-${reactId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <div className={className}>
      <label htmlFor={inputId} className="ui-caption block">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className="mt-1 block w-full ui-input"
        {...rest}
      />
      {error ? (
        <p id={errorId} role="alert" className="ui-caption mt-1 text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="ui-caption mt-1">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  /** 可见标签；同时作为控件的可访问名（不靠 placeholder）。 */
  label: string;
  /** 常驻说明（格式、限制、后果）；出错时让位给 error。 */
  hint?: ReactNode;
  /** 错误说明；非空时设置 `aria-invalid` 并让读屏跟随。 */
  error?: string | null;
  /** 追加在字段容器上的布局类；不要用它改字号或颜色。 */
  className?: string;
}

/**
 * 多行输入框（d.367）：和 `TextField` 同一套 label / hint / error 语义，只是控件换成
 * `<textarea>`。给「一行一条」这类输入用——请求头、规则列表——用单行框填第二个就得清空重来。
 */
export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ label, hint, error, className = "", id, rows = 2, ...rest }, ref) {
    const reactId = useId();
    const inputId = id ?? `field-${reactId}`;
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;

    return (
      <div className={className}>
        <label htmlFor={inputId} className="ui-caption block">
          {label}
        </label>
        <textarea
          ref={ref}
          id={inputId}
          rows={rows}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className="mt-1 block w-full ui-input"
          {...rest}
        />
        {error ? (
          <p id={errorId} role="alert" className="ui-caption mt-1 text-danger">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="ui-caption mt-1">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

