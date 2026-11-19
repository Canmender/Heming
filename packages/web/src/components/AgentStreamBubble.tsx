import { useState } from "react";
import type { RouteAttempt } from "../lib/llmClient.js";
import type { ToolTrace, TranscriptStep } from "../store/chat.js";
import { FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";
import { humanizeProviderError } from "../lib/llmFailure.js";
import { toolNameLabel } from "../lib/toolName.js";
import { summarizeToolArgs, toolArgPath } from "../lib/toolArgsSummary.js";
import { failureNextStep, parseToolFailure } from "../lib/toolFailure.js";
import { previewToolResult } from "../lib/toolResultPreview.js";
import { foldToolTraces } from "../lib/toolTraceFold.js";
import { describeReasoningClip, previewReasoning } from "../lib/reasoningPreview.js";
import { ARG_DIFF_MAX_ROWS, argDiff, formatArgDiffStat } from "../lib/fileEdit/argDiff.js";
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
   * 分步记录（d.350）：思考与工具按发生顺序交错。
   *
   * 传了就按它渲染「想一段 → 做一步 → 再想一段」，不再把整段思考堆在最上面。
   * 不传（旧消息）时回落到 `reasoning` + `tools` 的旧版式。
   */
  steps?: TranscriptStep[];
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
  steps,
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
        {/* d.248：气泡里不再显示「我」/智能体名——名字在同一段对话里是恒定信息，
            每条都重复一遍只会挤占正文宽度、也让人误以为在强调「谁说的」。
            d.346：连「生成中…」也不再显形；运行状态交给正文末尾的光标与输入框下方的
            进度行，读屏仍由上面的 sr-only 播报，视觉上不重复。 */}

        {steps && steps.length > 0 ? (
          <MessageSteps steps={steps} tools={tools ?? []} streaming={streaming} />
        ) : (
          <>
            {reasoning ? <ReasoningBlock text={reasoning} streaming={streaming} /> : null}
            {tools && tools.length > 0 ? (
              <ToolTraceList
                tools={tools}
                fold
                {...(onRevealPath ? { onRevealPath } : {})}
              />
            ) : null}
          </>
        )}
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

/**
 * 分步渲染（d.350）：按「想 → 做 → 再想」的顺序把一段段思考与一次次工具调用交错铺开。
 *
 * 为什么不能只靠两个大块：模型在工具轮里是「想一步、调一次、拿到结果再想」，
 * 旧版式把整段思考堆在最上面、所有工具堆在下面，用户看到的是「先想很久、再一口气做很多」，
 * 与真实过程不符，也没法把某段推理对上某次调用。
 *
 * 工具 id 在上层已被裁到 `tools` 里的子集；这里找不到就跳过，不渲染空行。
 */
export function MessageSteps({
  steps,
  tools,
  streaming,
}: {
  steps: TranscriptStep[];
  tools: ToolTrace[];
  streaming: boolean;
}) {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return (
    <div data-testid="agent-steps" className="flex flex-col gap-0.5">
      {steps.map((step, index) => {
        if (step.kind === "tool") {
          const tool = step.toolId ? byId.get(step.toolId) : undefined;
          if (!tool) return null;
          // 一次调用一行：失败/被拒的仍用同一套状态点与错误头，不并排折叠，
          // 否则「哪一步出的错」在分步视图里反而看不清。
          return <ToolTraceList key={`tool:${tool.id}`} tools={[tool]} />;
        }
        if (!step.text?.trim()) return null;
        return (
          <ReasoningBlock
            key={`think:${index}`}
            text={step.text}
            // 只有最后一段、且整条还在流式时才显示「进行中」；
            // 前面的段已经结束，不该继续跳「· 进行中」。
            streaming={streaming && index === steps.length - 1}
          />
        );
      })}
    </div>
  );
}

/**
 * 落定后的处理过程（d.352，对齐 DSH 的 turn-process）。
 *
 * 为什么不再直接摊开：一轮长任务动辄十几次调用，历史里每条消息都把步骤全铺开，
 * 会话会被「过程」淹掉，翻找答案反而更慢。DSH 的做法是收成一行「已完成，用时 …」，
 * 想看再点开；这里只收「过程」，正文始终可见。
 */
export function MessageProcess({ steps, tools }: { steps: TranscriptStep[]; tools: ToolTrace[] }) {
  const [open, setOpen] = useState(false);
  let toolCalls = 0;
  let thinkChars = 0;
  for (const step of steps) {
    if (step.kind === "tool") toolCalls += 1;
    else thinkChars += step.text?.length ?? 0;
  }
  const parts = [
    toolCalls > 0 ? `${toolCalls} 次工具调用` : null,
    thinkChars > 0 ? `思考 ${thinkChars} 字` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div data-testid="message-process" className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label="处理过程"
        onClick={() => setOpen((value) => !value)}
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
        <span className="shrink-0">处理过程</span>
        {parts.length > 0 ? (
          <span className="truncate text-ui-xs text-muted">· {parts.join(" · ")}</span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1">
          <MessageSteps steps={steps} tools={tools} streaming={false} />
        </div>
      ) : null}
    </div>
  );
}

/** 思考过程：流式中默认展开，结束后自动收起（仍可手动展开）。历史消息里默认折叠。 */
export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {  const [open, setOpen] = useState(streaming);
  // 只处理「流式 → 结束」这一次切换：结束后自动收起，用户之后手动展开不再被干预
  const [wasStreaming, setWasStreaming] = useState(streaming);
  // d.247：思考片段默认只渲染一段（流式中留尾巴、回看留开头），展开才看全文。
  const [showAll, setShowAll] = useState(false);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    if (!streaming) {
      setOpen(false);
      // 收起时把「看全文」也复位：下次展开回到「只看一段」，别一打开就是几万字。
      setShowAll(false);
    }
  }
  const preview = previewReasoning(text, { mode: streaming ? "tail" : "head" });
  const clipped = preview.clipped && !showAll;
  const body = clipped ? preview.text : text;
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
        <span className="shrink-0">思考过程</span>
        <span className="shrink-0 text-ui-xs text-muted">{text.length} 字</span>
        {streaming && <span className="shrink-0 text-ui-xs text-muted">· 进行中</span>}
      </button>
      {open && (
        // 不设内层 max-height（B 轨 E5）：轨迹区域整体只保留一层滚动，
        // 嵌套滚动条在触控板上会「卡在里层」，用户滚不到消息列表。
        // d.247 的「控制大小」因此靠**截断内容**实现，而不是加第二个滚动容器。
        <div
          data-testid="reasoning-body"
          className="mt-1 whitespace-pre-wrap break-words text-ui-sm italic leading-relaxed text-body"
        >
          {clipped && preview.mode === "tail" ? <span className="text-muted">…</span> : null}
          {body}
          {clipped && preview.mode === "head" ? <span className="text-muted">…</span> : null}
        </div>
      )}
      {open && (preview.clipped || showAll) && (
        <div className="mt-1 flex items-center gap-2">
          {clipped && <span className="text-ui-xs text-muted">{describeReasoningClip(preview)}</span>}
          <button
            type="button"
            data-testid={showAll ? "reasoning-collapse" : "reasoning-expand"}
            onClick={() => setShowAll((v) => !v)}
            className={`shrink-0 rounded-sm text-ui-xs text-muted underline underline-offset-2 hover:text-ink ${FOCUS_RING_TIGHT}`}
          >
            {showAll ? "只看开头一段" : `展开全部（还有 ${preview.hiddenChars} 字）`}
          </button>
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
  fold = false,
}: {
  tools: ToolTrace[];
  /**
   * 在系统文件管理器里定位这次调用涉及的文件（d.235）。
   *
   * 历史回看时「它当时读/改的是哪个文件」常常要落到资源管理器里核对；不给入口就得
   * 让用户从参数 JSON 里把路径抠出来。不传就不渲染按钮（老安装包没有 reveal 通道）。
   */
  onRevealPath?: (path: string) => void;
  /**
   * 折叠早先的调用（d.243）：流式气泡里传 true——长任务连跑十几条命令时，
   * 一屏工具行会把正文挤没；失败/被拒的调用不折（那才是要立刻看见的行）。
   * 历史回看与进度面板不折（前者外层已整体折叠，后者是用户主动打开的详情）。
   */
  fold?: boolean;
}) {
  const [showAllTraces, setShowAllTraces] = useState(false);
  const folded = fold && !showAllTraces ? foldToolTraces(tools) : null;
  const shown = folded === null ? tools : folded.visible;
  return (
    // 单层滚动（B 轨 E5）：此前 参数/结果 各自 max-h（120/140px）叠加外层，出现三层嵌套滚动条。
    // 现在只在这里限高，内层全部自然展开。
    <div className="mt-1 flex max-h-[60vh] flex-col gap-1 overflow-y-auto pr-1">
      {folded !== null && folded.hidden.length > 0 ? (
        <button
          type="button"
          className="ui-hit shrink-0 rounded-md border border-dashed border-line-soft bg-subtle-2 px-2 py-1 text-left text-ui-xs text-muted hover:text-ink"
          data-testid="tool-trace-hidden"
          onClick={() => setShowAllTraces(true)}
        >
          还有 {folded.hidden.length} 次工具调用已收起
          {folded.hiddenFailed > 0 ? `（其中 ${folded.hiddenFailed} 次出错）` : ""} · 展开
        </button>
      ) : null}
      {folded === null && fold ? (
        <button
          type="button"
          className="ui-hit shrink-0 self-start rounded-sm px-1 text-ui-xs text-muted hover:text-ink"
          data-testid="tool-trace-collapse"
          onClick={() => setShowAllTraces(false)}
        >
          收起早先的调用
        </button>
      ) : null}
      {shown.map((t) => {
        // d.220：失败/被拒的调用，折叠行先说「为什么」——参数再清楚也不如错误码有用；
        // 完整原文与契约行仍在展开区与 title 里，一个字段都不吞。
        const failure =
          t.status === "error" || t.status === "denied" ? parseToolFailure(t.result) : null;
        const nextStep = failure === null ? null : failureNextStep(failure);
        // d.239：成功的写/改，展开区先给「一眼能看的增删对照」——不用再点开「查看改动」。
        const inlineDiff = t.status === "ok" ? argDiff(t.name, t.args) : null;
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
            {inlineDiff === null ? null : (
              <div className="mb-1" data-testid="tool-inline-diff">
                <div className="text-ui-xs text-muted">
                  这次改动：{formatArgDiffStat(inlineDiff)}
                  {inlineDiff.truncated ? `（下面只画前 ${ARG_DIFF_MAX_ROWS} 行）` : ""}
                </div>
                <div className="mt-0.5 overflow-auto rounded-sm bg-panel font-mono text-ui-xs leading-5">
                  {inlineDiff.rows.map((row, index) => (
                    <div
                      // 行内容可能重复，但「第几行 + 类型」在这一次渲染里唯一，够用
                      key={`${index}-${row.kind}`}
                      data-testid={`tool-diff-row-${row.kind}`}
                      className={`flex gap-1 px-1.5 ${
                        row.kind === "add"
                          ? "bg-success-soft text-success"
                          : row.kind === "del"
                            ? "bg-danger-soft text-danger"
                            : "text-muted"
                      }`}
                    >
                      <span className="w-3 shrink-0 select-none">
                        {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
                      </span>
                      <span className="whitespace-pre-wrap break-words">{row.text || " "}</span>
                    </div>
                  ))}
                </div>
                {inlineDiff.truncated ? (
                  <p className="mt-0.5 text-ui-xs text-warn">
                    对照太长，这里只画了前 {ARG_DIFF_MAX_ROWS} 行；完整对照在「本轮改动 → 查看改动」里。
                  </p>
                ) : null}
              </div>
            )}
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