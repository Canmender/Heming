import { FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";
import type { ChatExample } from "../../lib/onboarding.js";

/**
 * 对话空态（极简化视觉）：居中问候 + 一行弱说明 + 可点击示例 chips。
 *
 * 关键约束不变：点击**只把文本填进输入框**，不发送、不发任何请求。
 * 空对话的第一句话最难写，给它一个能改的草稿比给一段「请开始对话」有用。
 *
 * 结构从「左对齐列表 + 卡片式示例」改成「居中问候 + rounded-full chips」，
 * 与 ChatGPT / Claude 的空态观感一致；「还没有消息」「发送第一条消息，开始这段对话。」
 * 两句文案与 `aria-label="对话示例"` 原样保留（读屏与既有测试依赖）。
 */
export interface ChatEmptyStateProps {
  examples: ChatExample[];
  /** 只填入输入框（由页面负责 setDraft/落盘/聚焦），不负责发送。 */
  onPick: (text: string) => void;
}

export function ChatEmptyState({ examples, onPick }: ChatEmptyStateProps) {
  return (
    <div className="flex min-h-[420px] w-full items-start justify-center px-6 py-10">
      {/*
       * 简约 · 大气 · 有层次：左对齐的大标题 + 一行说明 + 示例，
       * 靠字号差与留白建立层次，不用装饰线。文案与 aria-label 全部原样保留。
       */}
      <div className="w-full max-w-[600px] py-10 sm:py-14">
        <h2 className="text-ui-xl font-semibold leading-9 text-ink">有什么可以帮你的？</h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-md text-muted">
          <span>还没有消息</span>
          <span aria-hidden="true">·</span>
          <span>发送第一条消息，开始这段对话。</span>
        </div>

        <p className="mt-10 text-ui-sm text-muted">点一条填进输入框，改完再发送。</p>
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="对话示例">
          {examples.map((example) => (
            <li key={example.id}>
              <button
                type="button"
                onClick={() => onPick(example.text)}
                className={`rounded-full border border-line bg-surface px-3.5 py-1.5 text-ui-sm leading-5 text-body transition-colors hover:border-ink hover:text-ink ${FOCUS_RING_TIGHT}`}
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