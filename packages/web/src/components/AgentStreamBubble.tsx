/**
 * 流式生成气泡（M3 Task 8）：消息列表尾部的打字机行。
 * - streaming：署名 + 累积文本 + 光标「▌」；
 * - error：署名 + 已累积文本（partial）+ 失败原因 + 可选「重试」（本机流才有；他机流由 store 定时自清）。
 * 文本走 React 文本节点输出（天然转义），与消息气泡同款浅灰令牌样式。
 */
export interface AgentStreamBubbleProps {
  name: string;
  text: string;
  status: "streaming" | "error";
  errorMessage?: string;
  onRetry?: () => void;
}

export function AgentStreamBubble({
  name,
  text,
  status,
  errorMessage,
  onRetry,
}: AgentStreamBubbleProps) {
  return (
    <div className="mb-3 flex items-start gap-2">
      <div className="max-w-[70%] rounded-lg border border-line bg-[#f7f7f7] px-3 py-2 text-[13px] shadow-card">
        <div className="mb-0.5 text-[10px] text-muted">{name}</div>
        {status === "streaming" ? (
          <div>
            {text}
            <span>▌</span>
          </div>
        ) : (
          <>
            {text ? <div>{text}</div> : null}
            {errorMessage ? (
              <div className="mt-0.5 text-[#b45309]">{errorMessage}</div>
            ) : null}
            {onRetry ? (
              <button
                type="button"
                className="mt-1 rounded border border-line px-2 py-0.5 text-[12px] text-muted hover:bg-[#f3f3f3]"
                onClick={onRetry}
              >
                重试
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
