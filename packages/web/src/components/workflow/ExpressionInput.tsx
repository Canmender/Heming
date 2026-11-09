/**
 * 表达式输入框：在普通文本输入外面加一层「`{{ }}` 提示」。
 *
 * 为什么不做成富文本高亮编辑器：参数输入的核心是「填对值」，不是写代码。
 * 这里做三件小事就够用：
 * 1. 插入常用变量（`$json` / `$now` / `$workflow` …），不用背语法；
 * 2. 把识别到的表达式显示成小标签，写错了能一眼看到（例如只写了 `{{`）；
 * 3. 当整段就是一个表达式时提示「结果保留原始类型」，避免用户以为被转成字符串。
 *
 * 高亮本身用「下方标签」而不是改动 textarea 的颜色：textarea 无法局部着色，
 * 用 contenteditable 又要自己接管光标/输入法，得不偿失。
 */

import { useMemo, useRef, useState } from "react";
import { isSingleExpression } from "../../lib/workflow/expressions/index.js";

/** 常用变量（插入时保留 `}}` 之前的光标位置不太现实，直接插入完整占位）。 */
const COMMON_VARIABLES: ReadonlyArray<{ label: string; value: string; hint: string }> = [
  { label: "当前字段", value: "{{ $json.field }}", hint: "取当前 item 的字段" },
  { label: "全部 items", value: "{{ $items.length }}", hint: "当前输入口的条数" },
  { label: "上游节点", value: '{{ $node["节点名"].json.field }}', hint: "按节点名取上游输出" },
  { label: "现在", value: '{{ $now.format("yyyy-MM-dd HH:mm:ss") }}', hint: "本机当前时间" },
  { label: "今天", value: '{{ $today.format("yyyy-MM-dd") }}', hint: "今天 0 点" },
  { label: "工作流名", value: "{{ $workflow.name }}", hint: "当前工作流名字" },
  { label: "执行 id", value: "{{ $execution.id }}", hint: "本次执行 id" },
  { label: "全局变量", value: "{{ $vars.变量名 }}", hint: "模块设置里的全局变量" },
  { label: "序号", value: "{{ $itemIndex }}", hint: "当前 item 下标（0 起）" },
];

export interface ExpressionInputProps {
  id?: string;
  /** 字段标签（必填标记由调用方渲染或传 required）。 */
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** 多行（textarea）还是单行。 */
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** 外部错误（例如 JSON 解析失败）。 */
  error?: string;
  /** 字段说明（显示在输入框下方）。 */
  hint?: string;
  /** 是否允许表达式（JSON/代码字段也允许；DATE 之类不需要时可关掉变量条）。 */
  allowExpression?: boolean;
  /** 额外类（宽度控制）。 */
  className?: string;
  /** 失焦回调：需要校验 JSON 的字段用。 */
  onBlur?: () => void;
}

const EXPRESSION_PATTERN = /\{\{([\s\S]+?)\}\}/g;

/** 提取字符串里的表达式体（去重、最多 6 个用于展示）。 */
export function extractExpressions(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(EXPRESSION_PATTERN)) {
    const body = match[1]?.trim();
    if (body && !found.includes(body)) found.push(body);
    if (found.length >= 6) break;
  }
  return found;
}

/** 是否像「写了一半的表达式」（有 `{{` 但没有闭合的 `}}`）。 */
export function hasUnclosedExpression(value: string): boolean {
  const opens = (value.match(/\{\{/g) ?? []).length;
  const closes = (value.match(/\}\}/g) ?? []).length;
  return opens > closes;
}

export function ExpressionInput({
  id,
  label,
  value,
  onChange,
  multiline = false,
  rows = 3,
  placeholder,
  disabled = false,
  required = false,
  error,
  hint,
  allowExpression = true,
  className = "",
  onBlur,
}: ExpressionInputProps) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [showVariables, setShowVariables] = useState(false);
  const expressions = useMemo(() => extractExpressions(value), [value]);
  const unclosed = useMemo(() => hasUnclosedExpression(value), [value]);
  const single = useMemo(() => isSingleExpression(value), [value]);
  const inputId = id ?? `expr-${Math.random().toString(36).slice(2, 8)}`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;

  function insert(text: string): void {
    const element = ref.current;
    if (!element) {
      onChange(`${value}${text}`);
      return;
    }
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    onChange(next);
    setShowVariables(false);
    // 光标落在插入内容末尾；React 重渲染后打断点再设置。
    window.setTimeout(() => {
      const position = start + text.length;
      element.focus();
      element.setSelectionRange(position, position);
    }, 0);
  }

  const describedBy = [hint ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ");

  return (
    <div className={className}>
      {label ? (
        <label htmlFor={inputId} className="ui-caption mb-1 block font-medium text-ink">
          {label}
          {required ? (
            <span className="ml-0.5 text-[#b42318]" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      <div className="relative">
        {multiline ? (
          <textarea
            id={inputId}
            ref={(element) => {
              ref.current = element;
            }}
            value={value}
            rows={rows}
            placeholder={placeholder}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy || undefined}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            className="ui-input w-full resize-y font-mono text-[12px] leading-5"
          />
        ) : (
          <input
            id={inputId}
            ref={(element) => {
              ref.current = element;
            }}
            type="text"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy || undefined}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            className="ui-input w-full font-mono text-[12px]"
          />
        )}
        {allowExpression ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <button
              type="button"
              disabled={disabled}
              aria-expanded={showVariables}
              onClick={() => setShowVariables((current) => !current)}
              className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-muted hover:bg-[#f5f5f5] disabled:opacity-40"
            >
              插入变量
            </button>
            {expressions.map((expression) => (
              <span
                key={expression}
                className="ui-chip max-w-full truncate font-mono text-[10px]"
                title={`表达式：{{ ${expression} }}`}
              >
                {`{{ ${expression} }}`}
              </span>
            ))}
          </div>
        ) : null}
        {allowExpression && showVariables ? (
          <div
            role="listbox"
            aria-label="常用变量"
            className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line-soft bg-white p-1 shadow-card"
          >
            {COMMON_VARIABLES.map((variable) => (
              <button
                key={variable.value}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => insert(variable.value)}
                className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1 text-left hover:bg-[#f5f5f5]"
              >
                <span className="text-[12px]">{variable.label}</span>
                <span className="ui-caption font-mono text-[10px]">{variable.value}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {single ? (
        <p className="ui-caption mt-1">整段就是一个表达式：求值结果保留原始类型（数字/数组/对象）。</p>
      ) : null}
      {unclosed ? (
        <p className="mt-1 ui-body-sm text-[#b45309]">
          {"表达式少了右括号 `}}`，请补全。"}
        </p>
      ) : null}
      {hint ? (
        <p id={helpId} className="ui-caption mt-1">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 ui-body-sm text-[#b42318]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
