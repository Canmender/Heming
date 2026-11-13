import { EmptyState } from "../ui/EmptyState.js";
import { FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";
import type { ChatExample } from "../../lib/onboarding.js";

/**
 * 对话空态（UX-A · U4）：标题 + 一句说明 + 3 条可点击示例。
 *
 * 关键约束：点击**只把文本填进输入框**，不发送、不发任何请求。
 * 空对话的第一句话最难写，给它一个能改的草稿比给一段「请开始对话」有用。
 *
 * 结构走 `ui/EmptyState` 的 `align="start"`（审计点名去掉「居中大标题 + 副标题 + 按钮」
 * 的自建空态模板与 40px 图标槽）；示例区是左对齐列表，跟输入框同一阅读方向。
 */
export interface ChatEmptyStateProps {
  examples: ChatExample[];
  /** 只填入输入框（由页面负责 setDraft/落盘/聚焦），不负责发送。 */
  onPick: (text: string) => void;
}

export function ChatEmptyState({ examples, onPick }: ChatEmptyStateProps) {
  return (
    <div className="flex h-full w-full flex-col justify-center px-6">
      <div className="mx-auto w-full max-w-[520px]">
        <EmptyState align="start" title="还没有消息" desc="发送第一条消息，开始这段对话。" />

        <div className="mt-3">
          <p className="ui-caption">点一条填进输入框，改完再发送。</p>
          <ul className="mt-1.5 flex flex-col gap-1.5" aria-label="对话示例">
            {examples.map((example) => (
              <li key={example.id}>
                <button
                  type="button"
                  onClick={() => onPick(example.text)}
                  className={`w-full rounded-lg border border-line bg-[var(--surface)] px-3 py-2 text-left ui-body-sm leading-5 text-[var(--body)] hover:border-[var(--line-strong)] hover:bg-[var(--subtle-2)] ${FOCUS_RING_TIGHT}`}
                >
                  {example.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}