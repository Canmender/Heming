import { FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";
import type { ChatExample } from "../../lib/onboarding.js";

/**
 * 对话空态（UX-A · U4）：标题 + 一句说明 + 3 条可点击示例。
 *
 * 关键约束：点击**只把文本填进输入框**，不发送、不发任何请求。
 * 空对话的第一句话最难写，给它一个能改的草稿比给一段「请开始对话」有用。
 */
export interface ChatEmptyStateProps {
  examples: ChatExample[];
  /** 只填入输入框（由页面负责 setDraft/落盘/聚焦），不负责发送。 */
  onPick: (text: string) => void;
}

export function ChatEmptyState({ examples, onPick }: ChatEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="rounded-2xl border border-line-soft bg-[var(--surface)] p-3 text-muted" aria-hidden="true">
        <svg
          width={22}
          height={22}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 5h16v11H8l-4 3z" />
        </svg>
      </div>
      <div className="mt-3 text-[13px] font-bold text-[var(--body)]">还没有消息</div>
      <div className="mt-1 text-[11px] text-muted">发送第一条消息，开始这段对话。</div>

      <div className="mt-4 w-full max-w-[520px]">
        <p className="text-left text-[11px] text-muted">不知道说什么？点一条填进输入框，改完再发送：</p>
        <ul className="mt-2 flex flex-col gap-1.5" aria-label="对话示例">
          {examples.map((example) => (
            <li key={example.id}>
              <button
                type="button"
                onClick={() => onPick(example.text)}
                className={`w-full rounded-lg border border-line bg-[var(--surface)] px-3 py-2 text-left text-[12px] leading-5 text-[var(--body)] hover:border-[var(--line-strong)] hover:bg-[var(--subtle-2)] ${FOCUS_RING_TIGHT}`}
              >
                {example.text}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
