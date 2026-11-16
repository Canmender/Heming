/**
 * 输入框的模型切换（d.195）。
 *
 * 为什么要做：之前点输入框右下角的模型名会**跳到设置页**，用户要切一次模型得离开对话、
 * 找到模型页、再回来——长任务里「换一个更便宜的模型接着做」是很常见的动作。
 * codex / Claude Code 都是就地切换。这里做成一个小弹窗：列出可用模型、点一下即绑定，
 * 「更多设置…」仍留给真的要去改网关/Key 的时刻。
 *
 * 只负责展示与回传选择：绑定写在哪、生效于哪一轮，由调用方（ChatPage → `setBinding`）决定。
 */

import type { ReactNode } from "react";
import { Button } from "./ui/Button.js";
import { Dialog } from "./ui/Dialog.js";

export interface ModelChoice {
  id: string;
  label: string;
  /** 一行补充说明（如模型名或来源），可为空。 */
  hint?: string;
}

export interface ModelSwitcherProps {
  /** 弹窗是否打开。 */
  open: boolean;
  /** 当前会话的智能体名，用来说明「你在给谁换模型」。 */
  agentName: string;
  /** 可选模型（来自 llm store 的 profiles）。 */
  choices: readonly ModelChoice[];
  /** 当前绑定；未绑定传 null。 */
  boundId: string | null;
  onPick: (profileId: string) => void;
  onClose: () => void;
  /** 「更多设置…」：去模型页。 */
  onOpenSettings: () => void;
  /** 弹窗底部追加的说明（可选）。 */
  footerNote?: ReactNode;
}

export function ModelSwitcher({
  open,
  agentName,
  choices,
  boundId,
  onPick,
  onClose,
  onOpenSettings,
  footerNote,
}: ModelSwitcherProps) {
  if (!open) return null;
  return (
    <Dialog
      ariaLabel="切换模型"
      title="切换模型"
      description={`当前智能体：${agentName}。选中后下一轮对话生效，历史与本机文件不受影响。`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenSettings}>
            更多设置…
          </Button>
        </>
      }
    >
      {choices.length === 0 ? (
        <p className="m-0 text-ui-sm leading-6 text-muted">
          还没有可用模型：先在「设置 → 模型」里配置网关与模型，再回来这里切换。
        </p>
      ) : (
        <div role="radiogroup" aria-label="可选模型" className="flex flex-col gap-1">
          {choices.map((choice) => {
            const selected = choice.id === boundId;
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`ui-hit flex w-full items-center gap-2 rounded-sm border px-3 py-2 text-left transition-colors ${
                  selected
                    ? "border-line bg-subtle-2 text-ink"
                    : "border-transparent text-ink hover:bg-subtle-2"
                }`}
                onClick={() => onPick(choice.id)}
              >
                <span aria-hidden="true" className="w-3 shrink-0 text-ui-sm text-muted">
                  {selected ? "✓" : ""}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-ui-sm leading-5">{choice.label}</span>
                  {choice.hint ? (
                    <span className="block truncate text-ui-xs leading-4 text-muted">{choice.hint}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {footerNote ? <div className="mt-3 text-ui-xs leading-4 text-muted">{footerNote}</div> : null}
    </Dialog>
  );
}
