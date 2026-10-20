import { useState } from "react";
import type { ToolTrace } from "../store/chat.js";
import { MarkdownMessage } from "./MarkdownMessage.js";

/**
 * 流式生成气泡（M3 Task 8）：消息列表尾部的打字机行。
 * - streaming：思考过程（如有）+ 工具调用轨迹 + 累积文本 + 光标「▌」；
 * - error：署名 + 已累积文本（partial）+ 失败原因 + 可选「重试」（本机流才有；他机流由 store 定时自清）。
 * 文本走 React 文本节点输出（天然转义），与消息气泡同款浅灰令牌样式。
 */
export interface AgentStreamBubbleProps {
  name: string;
  text: string;
  status: "streaming" | "error";
  errorMessage?: string;
  onRetry?: () => void;
  /** 模型的思考过程（reasoning/thinking 累积全文）；不支持该能力的模型为空。 */
  reasoning?: string;
  /** 本轮发生过的工具调用（按时间顺序）。 */
  tools?: ToolTrace[];
}

export function AgentStreamBubble({
  name,
  text,
  status,
  errorMessage,
  onRetry,
  reasoning,
  tools,
}: AgentStreamBubbleProps) {
  const streaming = status === "streaming";
  return (
    <div className="mb-3 flex items-start gap-2">
      <div className="max-w-[78%] rounded-lg border border-line bg-[#f7f7f7] px-3 py-2 text-[13px] shadow-card">
        <div className="mb-0.5 flex items-center gap-2 text-[10px] text-muted">
          <span>{name}</span>
          {streaming && <span className="text-[#bbb]">生成中…</span>}
        </div>

        {reasoning ? <ReasoningBlock text={reasoning} streaming={streaming} /> : null}
        {tools && tools.length > 0 ? <ToolTraceList tools={tools} /> : null}

        {streaming ? (
          // 光标拼进正文末尾而不是另起一行：markdown 渲染后块级元素会把尾随的
          // 独立 span 挤到下一行，看起来像"光标本该在那却掉下去了"。
          <div className="mt-1 break-words">
            <MarkdownMessage text={text ? `${text}▌` : "▌"} streaming />
          </div>
        ) : (
          <>
            {text ? (
              <div className="mt-1 break-words">
                <MarkdownMessage text={text} />
              </div>
            ) : null}
            {errorMessage ? <div className="mt-0.5 text-[#b45309]">{errorMessage}</div> : null}
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

/** 思考过程：流式中默认展开，结束后自动收起（仍可手动展开）。 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  // 只处理「流式 → 结束」这一次切换：结束后自动收起，用户之后手动展开不再被干预
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    if (!streaming) setOpen(false);
  }
  return (
    <div className="mt-1 rounded-md border border-dashed border-[#e4e4e4] bg-white/70 px-2 py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label="思考过程"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left text-[11px] text-[#888] hover:text-[#555]"
      >
        <span className="text-[9px]">{open ? "▾" : "▸"}</span>
        <span>思考过程</span>
        <span className="text-[10px] text-[#bbb]">{text.length} 字</span>
        {streaming && <span className="text-[10px] text-[#bbb]">· 进行中</span>}
      </button>
      {open && (
        <div className="mt-1 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-[#777]">
          {text}
        </div>
      )}
    </div>
  );
}

/** 工具调用轨迹：一行一个工具，展开看参数与结果。 */
function ToolTraceList({ tools }: { tools: ToolTrace[] }) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {tools.map((t) => (
        <details key={t.id} className="rounded-md border border-[#e4e4e4] bg-white px-2 py-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px]">
            <StatusDot status={t.status} />
            <span className="font-mono text-[11px] text-[#444]">{t.name}</span>
            <span className={`text-[10px] ${statusColor(t.status)}`}>{statusLabel(t.status)}</span>
            {t.endedAt ? (
              <span className="text-[10px] text-[#bbb]">{Math.max(0, t.endedAt - t.startedAt)}ms</span>
            ) : null}
          </summary>
          <div className="mt-1 border-t border-[#f1f1f1] pt-1">
            <div className="text-[10px] text-[#999]">参数</div>
            <pre className="mt-0.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded bg-[#fafafa] px-1.5 py-1 font-mono text-[10px] text-[#555]">
              {t.args || "{}"}
            </pre>
            {t.status !== "running" && (
              <>
                <div className="mt-1 text-[10px] text-[#999]">结果</div>
                <pre
                  className={`mt-0.5 max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded px-1.5 py-1 font-mono text-[10px] ${
                    t.status === "error" ? "bg-[#fef3f2] text-[#b42318]" : "bg-[#f7f7f7] text-[#555]"
                  }`}
                >
                  {t.result || "（无返回）"}
                </pre>
              </>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function StatusDot({ status }: { status: ToolTrace["status"] }) {
  const color =
    status === "running" ? "bg-[#c98a00]" : status === "ok" ? "bg-[#1d6b3a]" : "bg-[#b42318]";
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${color}${
        status === "running" ? " animate-pulse" : ""
      }`}
    />
  );
}

function statusLabel(status: ToolTrace["status"]): string {
  return status === "running" ? "调用中" : status === "ok" ? "完成" : "失败";
}

function statusColor(status: ToolTrace["status"]): string {
  return status === "running" ? "text-[#c98a00]" : status === "ok" ? "text-[#1d6b3a]" : "text-[#b42318]";
}
