import { useEffect, useMemo, useRef, useState } from "react";
import { rolloutLog } from "../lib/rollout/index.js";
import {
  ROLLOUT_FILTERS,
  ROLLOUT_VERSION,
  buildRolloutExport,
  checkFork,
  counterpartIndex,
  filterRolloutItems,
  indexOfSeq,
  pairToolCalls,
  relativeLabel,
  turnCompletion,
  type RolloutFilter,
} from "../lib/rollout/index.js";
import type { RolloutItem } from "../lib/rollout/types.js";

/**
 * 任务区的「过程日志」：把一次执行重放出来，并给出唯一的两个动作入口（导出 / 分叉）。
 *
 * 为什么需要它：任务区的汇总（目标/结果/步骤）是**结论**，排查时真正要看的是
 * **过程**——模型先调了什么、参数是什么、工具回了什么、哪一步被拒绝。
 * 这些事实在 `lib/rollout` 里逐条记着，这个组件只负责读出来。
 *
 * 展示口径（d.56）：
 * - **相对时间**：距回合开始 `+3.2s`，排查时序比绝对时钟直观（绝对时间留在 title 里）；
 * - **类型筛选**：全部/工具/失败/被拒——不看全部时，四档足够回答「调了什么/哪步坏了」；
 * - **成对高亮**：悬停一条 `tool_result` 同时照亮它的 `tool_call`，配对判据与分叉前置同源；
 * - **未完成标注**：悬空调用与缺失 `turn_end` 是崩溃的唯一证据，必须标出来，不能当正常结束；
 * - **只读 + 有界**：没有删除/编辑入口；界面再截断到最近 60 条（全量用导出）。
 */

/** 界面最多渲染多少条（日志本身最多 200 条，这里只为阅读体验再收一次）。 */
export const MAX_VISIBLE_ITEMS = 60;

/** 运行中每 2s 重读一次：日志是外部写入的，没有订阅机制。 */
export const REFRESH_MS = 2_000;

const LABELS: Record<RolloutItem["type"], string> = {
  turn_start: "开始",
  tool_call: "调用工具",
  tool_result: "工具结果",
  assistant_final: "最终答案",
  turn_end: "结束",
};

/** 时间只显示时分秒：同一次执行里，先后顺序比日期重要。 */
export function clockOf(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function chipClass(item: RolloutItem): string {
  if (item.type === "turn_end") {
    return item.status === "ok"
      ? "border-[#abefc6] bg-[#ecfdf3] text-[#067647]"
      : item.status === "aborted"
        ? "border-[#e6e6e6] bg-[#fafafa] text-muted"
        : "border-[#fecdca] bg-[#fef3f2] text-[#b42318]";
  }
  if (item.type === "tool_result") {
    if (item.denied) return "border-[#fedf89] bg-[#fffaeb] text-[#b45309]";
    return item.ok
      ? "border-[#abefc6] bg-[#ecfdf3] text-[#067647]"
      : "border-[#fecdca] bg-[#fef3f2] text-[#b42318]";
  }
  return "border-[#e6e6e6] bg-[#fafafa] text-muted";
}

/** 一行标题（重要性从高到低：工具名 > 文本片段）。 */
export function titleOf(item: RolloutItem): string {
  switch (item.type) {
    case "turn_start":
      return "回合开始";
    case "tool_call":
      return item.name;
    case "tool_result":
      return `${item.name}${item.denied ? "（已拒绝，未执行）" : item.ok ? "" : "（失败）"}`;
    case "assistant_final":
      return "已给出最终答案";
    case "turn_end":
      return item.status === "ok" ? "正常结束" : item.status === "aborted" ? "已中断" : "出错结束";
    default:
      return "";
  }
}

/** 明细（参数 / 结果正文 / 错误原因）；空串表示这条没有明细。 */
export function detailOf(item: RolloutItem): string {
  switch (item.type) {
    case "turn_start":
      return item.userText;
    case "tool_call":
      return item.args;
    case "tool_result":
      return item.text;
    case "assistant_final":
      return item.text;
    case "turn_end":
      return item.error ?? "";
    default:
      return "";
  }
}

/** 复制到剪贴板：安全上下文缺失时退到 textarea + execCommand（与 MarkdownMessage 同口径）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export interface RolloutTimelineProps {
  /** 任务绑定的流 id（`TaskRecord.streamId`）。 */
  streamId: string;
  /** 运行中的任务：每 `REFRESH_MS` 重读一次。 */
  active?: boolean;
  /** 读取实现（测试注入；缺省读本机日志）。 */
  read?: (streamId: string) => RolloutItem[];
  /**
   * 日志格式版本（`readStream()` 带出）：v1 没有真序号、未来版本结构不可猜，
   * 这两种都不给分叉入口，并说明原因。
   */
  version?: number;
  /** 分叉入口（P2 由任务区接上）；不传则不渲染「从此处分叉」。 */
  onFork?: (targetSeq: number) => void;
  /** 任务仍在运行：分叉按钮置灰（正在跑的回合没有稳定前缀）。 */
  running?: boolean;
}

/** 未完成时「停在哪儿」：悬空调用优先，其次缺收尾时的最后一条。 */
function stoppedLabel(items: RolloutItem[]): string | null {
  const completion = turnCompletion(items);
  if (!completion.incomplete) return null;
  const index = completion.stoppedAtSeq === null ? -1 : indexOfSeq(items, completion.stoppedAtSeq);
  if (index >= 0) return titleOf(items[index] as RolloutItem) || `第 ${completion.stoppedAtSeq} 条`;
  return null;
}

/** 未完成的说明文字（如实说是崩溃，而不是「已结束」）。 */
function incompleteText(items: RolloutItem[]): string | null {
  const completion = turnCompletion(items);
  if (!completion.incomplete) return null;
  const parts: string[] = [];
  if (completion.reasons.includes("dangling_call")) parts.push("有工具调用没等到结果");
  if (completion.reasons.includes("missing_turn_end")) parts.push("没有收尾记录（可能是崩溃或强制退出）");
  if (completion.reasons.includes("no_turn_start")) parts.push("缺少回合开始记录");
  const where = stoppedLabel(items);
  return `未完成：${parts.join("；")}${where ? `。停在「${where}」` : ""}`;
}

export function RolloutTimeline({
  streamId,
  active = false,
  read,
  version,
  onFork,
  running = false,
}: RolloutTimelineProps) {
  const load = read ?? ((id: string) => rolloutLog.read(id));
  const [items, setItems] = useState<RolloutItem[]>(() => load(streamId));
  /**
   * 日志版本的兜底检测：父层没传 `version` 且用本机日志时自己读一次——
   * v1 日志的「从此处分叉」必须置灰，这件事不能依赖调用方记得传参。
   */
  const [storageVersion, setStorageVersion] = useState(ROLLOUT_VERSION);
  const [filter, setFilter] = useState<RolloutFilter>("all");
  /** 悬停/聚焦的那一行的下标：用来把配对的另一条也照亮。 */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /**
   * 导出的三种状态：idle / copied / failed。
   *
   * 为什么要专门有 failed：剪贴板在无权限、非安全上下文、`execCommand` 也失败时是**静默失败**，
   * 用户会以为导出成功了、然后粘到 issue 里一团空。失败时必须给可见反馈，并把 JSON
   * 摊在一个只读 textarea 里自动选中，让用户能手动复制。
   */
  const [exportState, setExportState] = useState<"idle" | "copied" | "failed">("idle");
  const [exportText, setExportText] = useState("");
  const exportAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  // 失败态出现时自动选中 JSON：用户直接 Ctrl+C 就好，不用自己去拖选。
  useEffect(() => {
    if (exportState !== "failed") return;
    exportAreaRef.current?.focus();
    exportAreaRef.current?.select();
  }, [exportState]);

  useEffect(() => {
    setItems(load(streamId));
    if (!read) {
      try {
        setStorageVersion(rolloutLog.readStream(streamId).version);
      } catch {
        setStorageVersion(ROLLOUT_VERSION);
      }
    }
    if (!active) return;
    const timer = setInterval(() => setItems(load(streamId)), REFRESH_MS);
    return () => clearInterval(timer);
    // load 每次渲染都是新函数时不该重建定时器：以 streamId/active 为界即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamId, active]);

  useEffect(() => {
    setHoverIndex(null);
    setExportState("idle");
    setExportText("");
  }, [streamId]);

  const startAt = items[0]?.at ?? "";
  const effectiveVersion = version ?? storageVersion;
  const pairing = useMemo(() => pairToolCalls(items), [items]);
  const completion = useMemo(() => turnCompletion(items), [items]);
  const filtered = useMemo(() => filterRolloutItems(items, filter), [items, filter]);
  // 先筛选再截断：筛「失败」时不该因为最近 60 条里没失败就显示空。
  const shown = filtered.slice(-MAX_VISIBLE_ITEMS);
  const hidden = filtered.length - shown.length;
  const highlightIndex =
    hoverIndex === null ? null : counterpartIndex(pairing, hoverIndex);
  const danglingIds = new Set(pairing.danglingCalls.map((call) => call.id));
  const danglingSeqs = new Set(pairing.danglingCalls.map((call) => call.seq));
  const incomplete = incompleteText(items);

  const exportJson = async () => {
    const text = buildRolloutExport(items, { streamId, version: effectiveVersion });
    const ok = await copyText(text);
    if (!ok) {
      // 剪贴板不可用（权限/安全上下文/execCommand 也被禁）：把文本摊出来给手动复制，
      // 并明确说「复制失败」——静默失败等于让用户以为导出成功。
      setExportText(text);
      setExportState("failed");
      return;
    }
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    setExportText("");
    setExportState("copied");
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setExportState("idle");
    }, 1500);
  };

  /** 每条的未完成标注：悬空调用 / 缺 turn_end 时的最后一条。 */
  const incompleteTagOf = (item: RolloutItem, isLastOfAll: boolean): string | null => {
    if (item.type === "tool_call" && danglingSeqs.has(item.seq)) return "未完成";
    if (isLastOfAll && !completion.ended) return "未完成";
    return null;
  };

  return (
    <section aria-label="过程日志">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted">过程日志</h3>
        <span className="text-[10px] text-muted">
          {items.length ? `${items.length} 条 · 只读 · 仅本机` : "只读 · 仅本机"}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            aria-label="导出本回合 JSON"
            title="复制本回合的完整过程（含被拒调用的参数），便于附到问题单里"
            onClick={() => void exportJson()}
            className="ml-auto rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-muted hover:bg-[#fafafa]"
          >
            {exportState === "copied" ? "已复制" : exportState === "failed" ? "复制失败" : "导出 JSON"}
          </button>
        )}
      </div>

      {exportState === "failed" && (
        <div className="mb-1">
          <p
            role="status"
            className="rounded-lg border border-[#fedf89] bg-[#fffaeb] px-2 py-1 text-[11px] leading-5 text-[#b45309]"
          >
            复制失败：浏览器未授权剪贴板。已展开 JSON 文本并选中，可直接复制。
          </p>
          <textarea
            ref={exportAreaRef}
            readOnly
            aria-label="本回合 JSON（可手动复制）"
            value={exportText}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 h-24 w-full resize-y rounded-sm border border-line-strong bg-[#fafafa] p-1.5 font-mono text-[10px] leading-4 outline-hidden"
          />
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-[12px] leading-5 text-muted">
          这次任务没有过程日志。日志只在本机记录，且只从有日志能力的版本开始。
        </p>
      ) : (
        <>
          {incomplete && (
            <p
              role="status"
              className="mb-1 rounded-lg border border-[#fedf89] bg-[#fffaeb] px-2 py-1 text-[11px] leading-5 text-[#b45309]"
            >
              {incomplete}
            </p>
          )}

          <div className="mb-1 flex items-center gap-1" role="group" aria-label="按类型筛选日志">
            {ROLLOUT_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                  filter === f.key
                    ? "border-ink bg-ink text-white"
                    : "border-line text-muted hover:bg-[#fafafa]"
                }`}
              >
                {f.label}
              </button>
            ))}
            {hidden > 0 && (
              <span className="ml-auto text-[10px] text-muted">仅显示最近 {MAX_VISIBLE_ITEMS} 条</span>
            )}
          </div>

          {shown.length === 0 ? (
            <p className="text-[12px] leading-5 text-muted">当前筛选下没有记录。</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {shown.map((item) => {
                // shown 是 filtered 的尾部：用原始下标做配对与高亮，避免筛选后串行
                const index = items.indexOf(item);
                const isLastOfAll = index === items.length - 1;
                const detail = detailOf(item);
                const title = titleOf(item);
                const tag = incompleteTagOf(item, isLastOfAll);
                const paired = highlightIndex === index;
                return (
                  <li
                    key={`${item.seq}-${item.type}`}
                    onMouseEnter={() => setHoverIndex(index)}
                    onMouseLeave={() => setHoverIndex((cur) => (cur === index ? null : cur))}
                    className={`rounded-lg border px-2 py-1.5 ${
                      paired ? "border-[#c7d2fe] bg-[#f5f8ff]" : "border-line-soft"
                    } ${tag ? "border-[#fedf89]" : ""}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="shrink-0 font-mono text-[10px] tabular-nums text-muted"
                        title={`绝对时间 ${clockOf(item.at)}`}
                      >
                        {relativeLabel(startAt, item.at) || clockOf(item.at)}
                      </span>
                      <span
                        className={`shrink-0 rounded-full border px-1.5 text-[10px] ${chipClass(item)}`}
                      >
                        {LABELS[item.type]}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{title}</span>
                      {tag && (
                        <span className="shrink-0 rounded-full border border-[#fedf89] bg-[#fffaeb] px-1.5 text-[10px] text-[#b45309]">
                          {tag}
                        </span>
                      )}
                    </div>
                    {detail && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer list-none text-[10px] text-muted hover:text-[#333]">
                          查看明细
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line-soft bg-[#fafafa] p-1.5 font-mono text-[10px] leading-4">
                          {detail}
                        </pre>
                      </details>
                    )}
                    {item.type === "tool_result" && onFork && (
                      <ForkButton
                        items={items}
                        item={item}
                        version={effectiveVersion}
                        running={running}
                        onFork={onFork}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

/**
 * 单条「从此处分叉」：能不能点由 `checkFork` 决定（与面板标注、分叉执行同源）。
 *
 * v1 日志、运行中、已给最终答案、前缀悬空/含 denied 等情况一律置灰并说明原因——
 * 允许点、点了才报错，是最让人恼火的交互。
 */
function ForkButton({
  items,
  item,
  version,
  running,
  onFork,
}: {
  items: RolloutItem[];
  item: RolloutItem;
  version: number;
  running: boolean;
  onFork: (targetSeq: number) => void;
}) {
  const check = checkFork(items, { targetSeq: item.seq, version, running });
  const first = check.rejections[0];
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`从此处分叉（第 ${item.seq} 条之后）`}
        disabled={!check.ok}
        title={first?.message ?? "复用这一步及之前的工具结果，换条路继续"}
        onClick={() => {
          if (check.ok) onFork(item.seq);
        }}
        className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40"
      >
        从此处分叉
      </button>
      {first && <span className="text-[10px] leading-4 text-muted">{first.message}</span>}
    </div>
  );
}
