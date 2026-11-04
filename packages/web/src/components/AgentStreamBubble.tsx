import { useState } from "react";
import type { RouteAttempt } from "../lib/llmClient.js";
import type { ToolTrace } from "../store/chat.js";
import { FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";
import { humanizeProviderError } from "../lib/llmFailure.js";
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
  /**
   * 候选链留痕（d.48 路由组）：只有问过不止一个候选才有内容，且**只在本机**。
   * 没有失败候选时这一行不显示（第一次就问对了没什么好解释的）。
   */
  attempts?: RouteAttempt[];
}

export function AgentStreamBubble({
  name,
  text,
  status,
  errorMessage,
  onRetry,
  reasoning,
  tools,
  attempts,
}: AgentStreamBubbleProps) {
  const streaming = status === "streaming";
  return (
    <div className="mb-3 flex items-start gap-2">
      {/*
       * 粗粒度状态播报（③-2）：只报「开始/完成/失败」，**不含正文**——
       * 流式文本逐 token 变化，若放进 live region 会变成每 token 念一次。
       * 文本本身不设 aria-live（用户移动光标/读到时才见），这是刻意的。
       */}
      <p className="sr-only" role="status" aria-live="polite">
        {streaming ? `${name} 正在生成回复` : errorMessage ? `${name} 生成失败` : `${name} 已生成回复`}
      </p>
      <div className="max-w-[78%] rounded-lg border border-line bg-[#f7f7f7] px-3 py-2 text-[13px] shadow-card">
        <div className="mb-0.5 flex items-center gap-2 text-[10px] text-muted">
          <span>{name}</span>
          {streaming && <span className="text-[#6f6f6f]">生成中…</span>}
        </div>

        {reasoning ? <ReasoningBlock text={reasoning} streaming={streaming} /> : null}
        {tools && tools.length > 0 ? <ToolTraceList tools={tools} /> : null}
        {attempts && attempts.length > 0 ? <RouteTraceLine attempts={attempts} /> : null}

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
            {/* 失败原因：把 `provider_error: HTTP 429 {json}` 翻成人话；原文留在 title 里排障用 */}
            {errorMessage ? (
              <div className="mt-0.5 text-[#b45309]" title={errorMessage}>
                {humanizeProviderError(errorMessage)}
              </div>
            ) : null}
            {onRetry ? (
              <button
                type="button"
                className={`mt-1 rounded-sm border border-line px-2 py-0.5 text-[12px] text-muted hover:bg-[#f3f3f3] ${FOCUS_RING_TIGHT}`}
                onClick={onRetry}
              >
                继续生成
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
        className={`flex w-full items-center gap-1 text-left text-[11px] text-[#6f6f6f] hover:text-[#555] ${FOCUS_RING_TIGHT}`}
      >
        <span className="text-[9px]" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span>思考过程</span>
        <span className="text-[10px] text-[#6f6f6f]">{text.length} 字</span>
        {streaming && <span className="text-[10px] text-[#6f6f6f]">· 进行中</span>}
      </button>
      {open && (
        <div className="mt-1 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-[#555]">
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
              <span className="text-[10px] text-[#6f6f6f]">{Math.max(0, t.endedAt - t.startedAt)}ms</span>
            ) : null}
          </summary>
          <div className="mt-1 border-t border-[#f1f1f1] pt-1">
            <div className="text-[10px] text-[#6f6f6f]">参数</div>
            <pre className="mt-0.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[#fafafa] px-1.5 py-1 font-mono text-[10px] text-[#555]">
              {t.args || "{}"}
            </pre>
            {t.status !== "running" && (
              <>
                <div className="mt-1 text-[10px] text-[#6f6f6f]">结果</div>
                <pre
                  className={`mt-0.5 max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-sm px-1.5 py-1 font-mono text-[10px] ${
                    t.status === "error" || t.status === "denied"
                      ? "bg-[#fef3f2] text-[#b42318]"
                      : "bg-[#f7f7f7] text-[#555]"
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

/**
 * 候选链留痕（d.48）：一次运行问过哪些候选、各自为什么被换走。
 * 全成功（没换过人）就不显示——用户不需要知道「第一次就问对了」这件事。
 */
function RouteTraceLine({ attempts }: { attempts: RouteAttempt[] }) {
  if (!attempts.some((a) => !a.ok)) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
      <span className="shrink-0 text-[#6f6f6f]">候选链</span>
      {attempts.map((a, i) => (
        <span
          key={`${i}-${a.profileId}`}
          title={a.error}
          className={`max-w-[180px] truncate rounded-sm border px-1 py-0.5 ${
            a.ok
              ? "border-[#cfe3cf] bg-[#f4faf4] text-[#1d6b3a]"
              : "border-[#eadfc8] bg-[#fdfaf3] text-[#8a7a55]"
          }`}
        >
          {a.profileLabel}
          {a.ok ? " ✓" : ` · ${a.kind ?? "失败"}`}
          {a.usage ? ` ${formatTokens(a.usage.totalTokens ?? 0)}` : ""}
        </span>
      ))}
    </div>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function StatusDot({ status }: { status: ToolTrace["status"] }) {
  const color =
    status === "running"
      ? "bg-[#c98a00]"
      : status === "ok"
        ? "bg-[#1d6b3a]"
        : status === "denied"
          ? "bg-[#b42318]"
          : "bg-[#b42318]";
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
  if (status === "running") return "调用中";
  if (status === "ok") return "完成";
  if (status === "denied") return "已拒绝";
  return "失败";
}

function statusColor(status: ToolTrace["status"]): string {
  if (status === "running") return "text-[#c98a00]";
  if (status === "ok") return "text-[#1d6b3a]";
  return "text-[#b42318]";
}
