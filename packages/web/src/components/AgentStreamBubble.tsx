import { useState } from "react";
import type { RouteAttempt } from "../lib/llmClient.js";
import type { ToolTrace } from "../store/chat.js";
import { FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";
import { humanizeProviderError } from "../lib/llmFailure.js";
import { toolNameLabel } from "../lib/toolName.js";
import { summarizeToolArgs, toolArgPath } from "../lib/toolArgsSummary.js";
import { failureNextStep, parseToolFailure } from "../lib/toolFailure.js";
import { previewToolResult } from "../lib/toolResultPreview.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { CheckIcon, ChevronIcon } from "./icons.js";
import { Button } from "./ui/Button.js";

/**
 * 流式生成气泡（M3 Task 8）：消息列表尾部的打字机行。
 * - streaming：思考过程（如有）+ 工具调用轨迹 + 累积文本 + 光标「▌」；
 * - error：署名 + 已累积文本（partial）+ 失败原因 + 可选「重试」（本机流才有；他机流由 store 定时自清）。
 * 文本走 React 文本节点输出（天然转义），与落定消息同款（无气泡底色、`px-0.5` 全宽）——
 * 流式结束后文字不能横向跳位（B 轨 E4）。
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
   * 在系统文件管理器里定位工具涉及的文件（d.235）。不传就不渲染「定位」。
   */
  onRevealPath?: (path: string) => void;
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
  onRevealPath,
  attempts,
}: AgentStreamBubbleProps) {
  const streaming = status === "streaming";
  return (
    <div className="mb-5 flex items-start gap-2">
      {/*
       * 粗粒度状态播报（③-2）：只报「开始/完成/失败」，**不含正文**——
       * 流式文本逐 token 变化，若放进 live region 会变成每 token 念一次。
       * 文本本身不设 aria-live（用户移动光标/读到时才见），这是刻意的。
       */}
      <p className="sr-only" role="status" aria-live="polite">
        {streaming ? `${name} 正在生成回复` : errorMessage ? `${name} 生成失败` : `${name} 已生成回复`}
      </p>
      <div className="min-w-0 flex-1 px-0.5 text-ui-md leading-relaxed">
        <div className="mb-1 flex items-baseline gap-2 text-ui-xs text-muted">
          <span>{name}</span>
          {streaming && <span>生成中…</span>}
        </div>

        {reasoning ? <ReasoningBlock text={reasoning} streaming={streaming} /> : null}
        {tools && tools.length > 0 ? (
          <ToolTraceList tools={tools} {...(onRevealPath ? { onRevealPath } : {})} />
        ) : null}
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
              <div className="mt-0.5 text-warn" title={errorMessage}>
                {humanizeProviderError(errorMessage)}
              </div>
            ) : null}
            {onRetry ? (
              <Button size="sm" variant="ghost" className="mt-1" onClick={onRetry}>
                继续生成
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** 思考过程：流式中默认展开，结束后自动收起（仍可手动展开）。历史消息里默认折叠。 */
export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  // 只处理「流式 → 结束」这一次切换：结束后自动收起，用户之后手动展开不再被干预
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    if (!streaming) setOpen(false);
  }
  return (
    <div className="mt-1 rounded-md border border-dashed border-line-soft bg-subtle-2 px-2 py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label="思考过程"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-1 text-left text-ui-xs text-muted hover:text-ink ${FOCUS_RING_TIGHT}`}
      >
        <ChevronIcon
          width={12}
          height={12}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-fast motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <span>思考过程</span>
        <span className="text-ui-xs text-muted">{text.length} 字</span>
        {streaming && <span className="text-ui-xs text-muted">· 进行中</span>}
      </button>
      {open && (
        // 不设内层 max-height（B 轨 E5）：轨迹区域整体只保留一层滚动，
        // 嵌套滚动条在触控板上会「卡在里层」，用户滚不到消息列表。
        <div className="mt-1 whitespace-pre-wrap break-words text-ui-sm italic leading-relaxed text-body">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * 历史消息里的工具调用块（d.126-C）：默认折叠成一行摘要，点击展开逐条轨迹。
 *
 * 与流式气泡里的 `ToolTraceList` 分开：流式时要实时看见每次调用，历史回看则先给
 * 「调用了几次、成没成」这一行，避免一条旧消息铺开一大片工具输出。
 */
export function ToolTraceGroup({ tools }: { tools: ToolTrace[] }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummaryLabel(tools);
  return (
    <div className="mt-1 rounded-md border border-dashed border-line-soft bg-subtle-2 px-2 py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label="工具调用"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 text-left text-ui-xs text-muted hover:text-ink ${FOCUS_RING_TIGHT}`}
      >
        <ChevronIcon
          width={12}
          height={12}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-fast motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <span>工具调用 · {tools.length} 次</span>
        {summary && <span className="text-ui-xs text-muted">{summary}</span>}
      </button>
      {open && (
        <div className="mt-1 border-t border-line-soft pt-1">
          <ToolTraceList tools={tools} />
        </div>
      )}
    </div>
  );
}

/** 工具调用轨迹：一行一个工具，展开看参数与结果。 */
export function ToolTraceList({
  tools,
  onRevealPath,
}: {
  tools: ToolTrace[];
  /**
   * 在系统文件管理器里定位这次调用涉及的文件（d.235）。
   *
   * 历史回看时「它当时读/改的是哪个文件」常常要落到资源管理器里核对；不给入口就得
   * 让用户从参数 JSON 里把路径抠出来。不传就不渲染按钮（老安装包没有 reveal 通道）。
   */
  onRevealPath?: (path: string) => void;
}) {
  return (
    // 单层滚动（B 轨 E5）：此前 参数/结果 各自 max-h（120/140px）叠加外层，出现三层嵌套滚动条。
    // 现在只在这里限高，内层全部自然展开。
    <div className="mt-1 flex max-h-[60vh] flex-col gap-1 overflow-y-auto pr-1">
      {tools.map((t) => {
        // d.220：失败/被拒的调用，折叠行先说「为什么」——参数再清楚也不如错误码有用；
        // 完整原文与契约行仍在展开区与 title 里，一个字段都不吞。
        const failure =
          t.status === "error" || t.status === "denied" ? parseToolFailure(t.result) : null;
        const nextStep = failure === null ? null : failureNextStep(failure);
        return (
        <details key={t.id} className="rounded-md border border-line-soft bg-surface px-2 py-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-ui-xs">
            <StatusDot status={t.status} />
            <span className="font-mono text-ui-xs text-ink" title={t.name}>
              {toolNameLabel(t.name)}
            </span>
            {/* d.216：默认折叠时也看得出「这次调用干了什么」，原始 JSON 仍留在展开区与 title 里 */}
            {failure ? (
              <span
                className="min-w-0 flex-1 truncate text-ui-xs text-danger"
                data-testid="tool-failure-headline"
                title={t.result || undefined}
              >
                {failure.headline}
              </span>
            ) : (
              summarizeToolArgs(t.name, t.args) && (
                <span
                  className="min-w-0 flex-1 truncate text-ui-xs text-muted"
                  data-testid="tool-arg-summary"
                  title={t.args || "{}"}
                >
                  {summarizeToolArgs(t.name, t.args)}
                </span>
              )
            )}
            {onRevealPath
              ? (() => {
                  const target = toolArgPath(t.name, t.args);
                  if (target === null) return null;
                  const label = target.split("/").pop() ?? target;
                  return (
                    <button
                      type="button"
                      className="ui-hit rounded-sm px-1 text-ui-xs text-muted hover:text-ink"
                      aria-label={`在文件夹里定位 ${label}`}
                      onClick={(event) => {
                        event.preventDefault();
                        onRevealPath(target);
                      }}
                    >
                      定位
                    </button>
                  );
                })()
              : null}
            <span className={`text-ui-xs ${statusColor(t.status)}`}>{statusLabel(t.status)}</span>
            {t.endedAt ? (
              <span className="text-ui-xs text-muted">{formatDuration(t.endedAt - t.startedAt)}</span>
            ) : null}
          </summary>
          <div className="mt-1 border-t border-line-soft pt-1">
            <div className="text-ui-xs text-muted">参数</div>
            <pre className="mt-0.5 whitespace-pre-wrap break-words rounded-sm bg-subtle-2 px-1.5 py-1 font-mono text-ui-xs text-body">
              {t.args || "{}"}
            </pre>
            {t.status !== "running" && (
              <>
                <div className="mt-1 text-ui-xs text-muted">结果</div>
                {/* d.234：几万字的工具结果不再一股脑塞进 DOM——先头后尾，明写藏了多少字 */}
                <ToolResultText text={t.result} danger={t.status === "error" || t.status === "denied"} />
                {/* d.220：把契约里的「一句出路」抬到结果下面，不用用户自己从原文里找 */}
                {nextStep === null ? null : (
                  <p
                    className="mt-1 rounded-sm bg-subtle-2 px-1.5 py-1 text-ui-xs text-body"
                    data-testid="tool-failure-next"
                  >
                    下一步：{nextStep}
                  </p>
                )}
              </>
            )}
          </div>
        </details>
        );
      })}
    </div>
  );
}

/**
 * 工具结果的展示块（d.234）：长结果先给「开头 + 结尾」，并给一个「展开全部」。
 *
 * 为什么不是一直全量渲染：一次 `run_command` 的构建日志、`file_read` 读的几千行文件，
 * 全塞进 `<pre>` 会让展开这张卡片卡上半秒；而真正要看的部分通常就两处——开头的错误码/契约行、
 * 结尾的结论。隐藏了多少字写清楚，谁都能点开看全部（不丢任何信息，只是不默认铺满）。
 */
function ToolResultText({ text, danger }: { text: string | undefined; danger: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const preview = previewToolResult(text);
  const body = text && text.length > 0 ? text : "（无返回）";
  const tone = danger ? "bg-danger-soft text-danger" : "bg-subtle-2 text-body";
  if (!preview.truncated || showAll) {
    return (
      <>
        <pre
          className={`mt-0.5 whitespace-pre-wrap break-words rounded-sm px-1.5 py-1 font-mono text-ui-xs ${tone}`}
          data-testid="tool-result-full"
        >
          {body}
        </pre>
        {preview.truncated ? (
          <button
            type="button"
            className="mt-0.5 text-ui-xs text-muted underline-offset-2 hover:underline"
            onClick={() => setShowAll(false)}
          >
            收起（只看开头和结尾）
          </button>
        ) : null}
      </>
    );
  }
  return (
    <>
      <pre
        className={`mt-0.5 whitespace-pre-wrap break-words rounded-sm px-1.5 py-1 font-mono text-ui-xs ${tone}`}
        data-testid="tool-result-preview"
      >
        {preview.preview}
      </pre>
      <button
        type="button"
        className="mt-0.5 text-ui-xs text-muted underline-offset-2 hover:underline"
        onClick={() => setShowAll(true)}
      >
        展开全部（还有 {preview.hiddenChars} 字未显示）
      </button>
    </>
  );
}

/**
 * 一组工具调用的一行摘要（历史消息里折叠块用）：「2 完成 · 1 失败」。
 * 空摘要返回空串（调用方据此省略状态段）。
 */
export function toolSummaryLabel(tools: ToolTrace[]): string {
  const count = (status: ToolTrace["status"]) => tools.filter((t) => t.status === status).length;
  const parts: string[] = [];
  const ok = count("ok");
  const failed = count("error");
  const denied = count("denied");
  const running = count("running");
  if (ok > 0) parts.push(`${ok} 完成`);
  if (failed > 0) parts.push(`${failed} 失败`);
  if (denied > 0) parts.push(`${denied} 已拒绝`);
  if (running > 0) parts.push(`${running} 进行中`);
  return parts.join(" · ");
}

/**
 * 候选链留痕（d.48）：一次运行问过哪些候选、各自为什么被换走。
 * 全成功（没换过人）就不显示——用户不需要知道「第一次就问对了」这件事。
 */
function RouteTraceLine({ attempts }: { attempts: RouteAttempt[] }) {
  if (!attempts.some((a) => !a.ok)) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-ui-xs">
      <span className="shrink-0 text-muted">候选链</span>
      {attempts.map((a, i) => (
        <span
          key={`${i}-${a.profileId}`}
          title={a.error}
          className={`max-w-[180px] truncate rounded-sm border px-1 py-0.5 ${
            a.ok
              ? "border-success-line bg-success-soft text-success"
              : "border-warn-line bg-warn-soft text-warn"
          }`}
        >
          {a.profileLabel}
          {a.ok ? (
            <CheckIcon width={12} height={12} className="inline-block align-[-1px] text-success" aria-hidden="true" />
          ) : (
            ` · ${a.kind ?? "失败"}`
          )}
          {a.usage ? ` ${formatTokens(a.usage.totalTokens ?? 0)}` : ""}
        </span>
      ))}
    </div>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 工具耗时人类化：120ms / 1.2s / 1m5s（此前一律裸毫秒，1 万毫秒读不出来）。 */
function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function StatusDot({ status }: { status: ToolTrace["status"] }) {
  const color =
    status === "running"
      ? "bg-warn"
      : status === "ok"
        ? "bg-success"
        : status === "denied"
          ? "bg-danger"
          : "bg-danger";
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${color}${
        status === "running" ? " animate-pulse motion-reduce:animate-none" : ""
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
  if (status === "running") return "text-warn";
  if (status === "ok") return "text-success";
  return "text-danger";
}