import { useRef, useState } from "react";
import { ConfirmDialog } from "../ConfirmDialog.js";

/**
 * 知识库里的单行输入弹窗（新建笔记 / 新建文件夹 / 重命名）。
 *
 * 为什么复用 `ConfirmDialog` 而不是自己写一层遮罩：焦点陷阱、Esc、点遮罩取消、
 * 关闭后焦点归还这些行为在仓库里只有一份（`useModalA11y`），第三处再写一遍
 * 迟早出现「这个弹窗 Esc 关不掉」的不一致。
 */
export interface PromptDialogProps {
  /** 弹窗标题（读屏软件读它）。 */
  title: string;
  /** 输入框的可见标签。 */
  label: string;
  /** 初始值（重命名时是当前名字）。 */
  initialValue?: string;
  /** 确认按钮文案。 */
  confirmText?: string;
  /** 输入区域下方的补充说明（例如「文件名会自动补 .md」）。 */
  hint?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export function PromptDialog({
  title,
  label,
  initialValue = "",
  confirmText = "确定",
  hint,
  onCancel,
  onConfirm,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();

  const submit = () => {
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <ConfirmDialog
      title={title}
      onCancel={onCancel}
      initialFocusRef={inputRef}
      footer={
        <>
          <button type="button" onClick={onCancel} className="ui-btn ui-btn-md ui-btn-ghost">
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!trimmed}
            className="ui-btn ui-btn-md ui-btn-primary"
          >
            {confirmText}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="ui-caption mb-1 block" htmlFor="knowledge-prompt-input">
          {label}
        </label>
        <input
          id="knowledge-prompt-input"
          ref={inputRef}
          className="ui-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={label}
        />
        {hint ? <p className="ui-caption mt-1.5">{hint}</p> : null}
      </form>
    </ConfirmDialog>
  );
}
