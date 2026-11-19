import { useMemo, useState } from "react";
import type { ConversationProgress, ProgressStep, ProgressStepKind, ProgressStepStatus } from "../../lib/progress/model.js";
import { transcriptOf, useChatStore, type ToolTrace } from "../../store/chat.js";
import type { Message } from "@heming/shared";
import { STEP_TONES, formatDuration } from "../progress/status.js";
import { formatSeconds } from "../../lib/agentRuntime/turnProgress.js";
import { EmptyState } from "../ui/EmptyState.js";
import { WorkflowIcon } from "../icons.js";

/**
 * 「轨迹」页签（d.351，按 DSH 的轨迹 ledger 重做）。
 *
 * 旧版只画**本轮**：进度模型只描述正在跑的这一次，所以翻回上一轮就什么都看不到。
 * DSH 的轨迹页是**整段会话**的账本：按轮分组、每轮里列出步骤（用户说了什么、
 * 模型想了什么、调了什么工具、得了什么结果、最后答了什么），再配一条时间线与工具栏。
 *
 * 这里的数据有两条来源，合并规则：
 * - 历史：`messages` 里的 `transcript.steps`（d.350 起按「想—做—想」交错记录），
 *   旧消息没有 steps 就退化成「一段思考 + 工具列表」，不假装有顺序；
 * - 当前轮：`progress.steps`（正在跑的那一刻还没有收口成消息）。
 * 两处都不编时间戳：没有 `startedAt/endedAt` 就显示「—」，时间线按等宽分段。
 */

/** 行类别：比步骤模型多出「用户」——账本里没有这一行就不知道每轮从哪开始。 */
type LedgerKind = ProgressStepKind | "user";

const KIND_LABELS: Record<LedgerKind, string> = {
  user: "用户",
  think: "思考",
  tool: "工具",
  confirm: "确认",
  answer: "回答",
};

/** 类别配色：工具用 warn 系（与工具轨迹同色），用户用 accent，其余中性。 */
function kindClass(kind: LedgerKind): string {
  if (kind === "tool") return "border-warn-line bg-warn-soft text-warn";
  if (kind === "user") return "border-accent/40 bg-accent/10 text-accent";
  if (kind === "confirm") return "border-line-strong bg-subtle-2 text-ink";
  return "border-line-soft bg-subtle-1 text-muted";
}

/** 一行账本。 */
interface LedgerRow {
  id: string;
  kind: LedgerKind;
  label: string;
  detail?: string;
  status: ProgressStepStatus;
  startedAt?: number;
  endedAt?: number;
  /** 工具参数与结果全文（展开时看）。 */
  args?: string;
  result?: string;
  /** 思考/回答的全文（展开时看）。 */
  text?: string;
}

interface LedgerTurn {
  index: number;
  steps: LedgerRow[];
  running: boolean;
}

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function msOf(row: { startedAt?: number; endedAt?: number }): number | null {
  if (row.startedAt === undefined || row.endedAt === undefined) return null;
  return Math.max(0, row.endedAt - row.startedAt);
}

function statusOfTool(tool: ToolTrace): ProgressStepStatus {
  return tool.status;
}

/** 历史消息 → 账本行。空消息也要留一行，否则那一轮会凭空消失。 */
function rowsOfMessage(message: Message, index: number): LedgerRow[] {
  const transcript = transcriptOf(message);
  const text = message.payload?.text ?? "";
  if (message.senderType === "user") {
    return [
      {
        id: `u-${message.id}`,
        kind: "user",
        label: oneLine(text, 120) || "（空消息）",
        status: "ok",
        text,
        startedAt: Date.parse(message.createdAt) || undefined,
      },
    ];
  }
  const rows: LedgerRow[] = [];
  const toolsById = new Map((transcript?.tools ?? []).map((tool) => [tool.id, tool]));
  const steps = transcript?.steps ?? [];
  if (steps.length > 0) {
    for (const [i, step] of steps.entries()) {
      const tool = step.kind === "tool" && step.toolId ? toolsById.get(step.toolId) : undefined;
      rows.push({
        id: `h-${message.id}-${i}`,
        kind: step.kind,
        label: tool ? `调用 ${tool.name}` : step.kind === "think" ? "思考" : oneLine(step.text ?? "", 90) || KIND_LABELS[step.kind],
        detail: step.kind === "think" ? oneLine(step.text ?? "") : tool?.result ? oneLine(tool.result) : undefined,
        status: tool ? statusOfTool(tool) : "ok",
        startedAt: tool?.startedAt,
        endedAt: tool?.endedAt,
        args: tool?.args,
        result: tool?.result,
        text: step.text,
      });
    }
  } else {
    // 旧消息：没有分步记录，只还原「思考 + 工具」的粗粒度事实。
    if (transcript?.thinking) {
      rows.push({
        id: `h-${message.id}-think`,
        kind: "think",
        label: "思考",
        detail: oneLine(transcript.thinking),
        status: "ok",
        text: transcript.thinking,
      });
    }
    for (const tool of transcript?.tools ?? []) {
      rows.push({
        id: `h-${message.id}-${tool.id}`,
        kind: "tool",
        label: `调用 ${tool.name}`,
        detail: tool.result ? oneLine(tool.result) : undefined,
        status: statusOfTool(tool),
        startedAt: tool.startedAt,
        endedAt: tool.endedAt,
        args: tool.args,
        result: tool.result,
      });
    }
  }
  if (text.trim().length > 0) {
    rows.push({
      id: `h-${message.id}-answer-${index}`,
      kind: "answer",
      label: oneLine(text, 120),
      status: "ok",
      text,
    });
  }
  return rows;
}

/** 正在跑的那一轮 → 账本行。 */
function rowsOfProgress(progress: ConversationProgress): LedgerRow[] {
  const toolsById = new Map(progress.tools.map((tool) => [tool.id, tool]));
  return progress.steps.map((step: ProgressStep, i) => {
    const tool = toolsById.get(step.id);
    return {
      id: `live-${i}-${step.id}`,
      kind: step.kind,
      label: step.label,
      detail: step.detail,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      args: tool?.args,
      result: tool?.result,
      text: step.kind === "think" ? progress.thinking : undefined,
    };
  });
}

/** 会话 → 轮（用户消息开新轮；连续 agent 消息归入当前轮）。 */
function buildTurns(messages: Message[], live: ConversationProgress | null): LedgerTurn[] {
  const turns: LedgerTurn[] = [];
  let current: LedgerTurn | null = null;
  for (const [index, message] of messages.entries()) {
    const rows = rowsOfMessage(message, index);
    if (message.senderType === "user") {
      if (current && current.steps.length > 0) turns.push(current);
      current = { index: turns.length + 1, steps: [...rows], running: false };
      continue;
    }
    if (!current) current = { index: turns.length + 1, steps: [], running: false };
    current.steps.push(...rows);
  }
  if (current && current.steps.length > 0) turns.push(current);
  if (live) {
    const liveRows = rowsOfProgress(live);
    if (liveRows.length > 0) {
      const last = turns[turns.length - 1];
      if (last && last.steps.length > 0) {
        last.steps.push(...liveRows);
        last.running = !live.hasData ? false : live.phase !== "done";
      } else {
        turns.push({ index: turns.length + 1, steps: liveRows, running: live.phase !== "done" });
      }
    }
  }
  return turns;
}

/** 时间线：一轮一根条，段宽按耗时比例；没有时间戳就等宽。 */
function Timeline({
  turns,
  selected,
  onSelect,
  equal,
}: {
  turns: LedgerTurn[];
  selected: number | null;
  onSelect: (index: number) => void;
  equal: boolean;
}) {
  return (
    <div className="mb-3 flex items-end gap-1.5" data-testid="trajectory-timeline" aria-hidden="true">
      {turns.map((turn) => {
        const durations = turn.steps.map((row) => (equal ? 1 : (msOf(row) ?? 0)));
        const total = durations.reduce((sum, value) => sum + value, 0) || turn.steps.length || 1;
        return (
          <button
            key={turn.index}
            type="button"
            tabIndex={-1}
            onClick={() => onSelect(turn.index)}
            title={`第 ${turn.index} 轮 · ${turn.steps.length} 步`}
            className={`group flex min-w-0 flex-1 flex-col gap-1 rounded-sm p-0.5 text-left transition-colors ${
              selected === turn.index ? "bg-subtle-2" : "hover:bg-subtle-1"
            }`}
          >
            <span className="flex h-2 w-full overflow-hidden rounded-full bg-subtle-3">
              {turn.steps.map((row, i) => {
                const width = ((durations[i] ?? 0) / total) * 100;
                const tone =
                  row.kind === "tool"
                    ? "bg-warn"
                    : row.kind === "user"
                      ? "bg-accent"
                      : row.kind === "confirm"
                        ? "bg-line-strong"
                        : "bg-muted/50";
                return <span key={row.id} className={`${tone} h-full`} style={{ width: `${Math.max(width, 0.5)}%` }} />;
              })}
            </span>
            <span className="truncate text-ui-xs leading-3 tabular-nums text-muted">第 {turn.index} 轮</span>
          </button>
        );
      })}
    </div>
  );
}

export function TrajectoryView({
  progress,
  conversationId,
}: {
  progress: ConversationProgress;
  /** 会话 id：轨迹按整段会话铺，不只是当前轮。 */
  conversationId?: string | null;
}) {
  const messages = useChatStore((s) => (conversationId ? s.messages[conversationId] : undefined)) ?? [];
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);
  const [equal, setEqual] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const live = progress.hasData ? progress : null;
  const turns = useMemo(() => buildTurns(messages, live), [messages, live]);
  const allSteps = useMemo(() => turns.flatMap((turn) => turn.steps), [turns]);
  const toolCalls = allSteps.filter((row) => row.kind === "tool").length;
  // d.381：把「工具一共干了多久 / 整段对话跨了多久」也摆出来。上一轮小结（d.380）只看得到最近一轮，
  // 这里看得到整段会话；两者都以各步的起止时间为准，没有时间戳的老消息不编。
  const toolMs = allSteps.reduce((sum, row) => (row.kind === "tool" ? sum + (msOf(row) ?? 0) : sum), 0);
  const spanMs = (() => {
    let first: number | null = null;
    let last: number | null = null;
    for (const row of allSteps) {
      // 只按「有起止两端的步骤」算：用户消息、思考段、正在跑的那一步都只有起点或都没有，
      // 拿它们参与会算出荒唐的数字（刚发的消息与十分钟前的工具之间差了好几天）。
      if (row.startedAt === undefined || row.endedAt === undefined) continue;
      if (first === null || row.startedAt < first) first = row.startedAt;
      if (last === null || row.endedAt > last) last = row.endedAt;
    }
    return first !== null && last !== null && last > first ? last - first : 0;
  })();

  const needle = query.trim().toLowerCase();
  const visibleTurns = useMemo(() => {
    return turns
      .map((turn) => {
        if (selectedTurn !== null && turn.index !== selectedTurn) return null;
        const steps = needle
          ? turn.steps.filter((row) =>
              [row.label, row.detail ?? "", row.args ?? "", row.result ?? "", row.text ?? ""]
                .join("\n")
                .toLowerCase()
                .includes(needle),
            )
          : turn.steps;
        return steps.length > 0 ? { ...turn, steps } : null;
      })
      .filter((turn): turn is LedgerTurn => turn !== null);
  }, [turns, needle, selectedTurn]);

  const filtering = needle.length > 0 || selectedTurn !== null;
  const visibleCount = visibleTurns.reduce((sum, turn) => sum + turn.steps.length, 0);

  if (turns.length === 0) {
    return (
      <section aria-label="会话轨迹" data-view-panel="trail">
        <h3 className="ui-section-title mb-3">轨迹</h3>
        <EmptyState
          icon={<WorkflowIcon width={24} height={24} />}
          titleAs="h2"
          title="还没有轨迹"
          desc="发送一条消息后，用户输入、思考、工具调用与回答会按轮记在这里。"
          framed
        />
      </section>
    );
  }

  return (
    <section aria-label="会话轨迹" data-view-panel="trail">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="ui-section-title">轨迹</h3>
        <p className="text-ui-xs tabular-nums text-muted" data-testid="trajectory-summary">
          {turns.length} 轮 · {allSteps.length} 步
          {toolCalls > 0 ? ` · ${toolCalls} 次工具调用` : ""}
          {toolMs >= 500 ? ` · 工具 ${formatSeconds(toolMs)}` : ""}
          {spanMs >= 1000 ? ` · 全程 ${formatSeconds(spanMs)}` : ""}
        </p>
      </div>

      {/* 工具栏（DSH 的 TrajectoryToolbar）：搜索、折叠全部轮次、时长/等宽。 */}
      <div role="toolbar" aria-label="轨迹工具栏" className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索轨迹"
          placeholder="搜索步骤、工具、参数或结果"
          className="ui-input h-8 w-64 text-ui-sm"
        />
        <button
          type="button"
          aria-pressed={collapsed.size > 0 && visibleTurns.every((turn) => collapsed.has(turn.index))}
          onClick={() => {
            setCollapsed((current) => {
              const allCollapsed = visibleTurns.every((turn) => current.has(turn.index));
              const next = new Set(current);
              for (const turn of visibleTurns) {
                if (allCollapsed) next.delete(turn.index);
                else next.add(turn.index);
              }
              return next;
            });
          }}
          className="ui-chip h-7 text-muted"
        >
          {collapsed.size > 0 && visibleTurns.every((turn) => collapsed.has(turn.index)) ? "⊞ 展开轮次" : "⊟ 折叠轮次"}
        </button>
        <button
          type="button"
          aria-pressed={equal}
          aria-label="时长按等宽显示"
          title={equal ? "按等宽显示（无时间戳的步骤）" : "按真实耗时显示"}
          onClick={() => setEqual((v) => !v)}
          className="ui-chip h-7 text-muted"
        >
          {equal ? "等宽" : "时长"}
        </button>
        {selectedTurn !== null ? (
          <button type="button" onClick={() => setSelectedTurn(null)} className="ui-chip h-7 text-muted">
            看全部轮次
          </button>
        ) : null}
        {filtering ? (
          <span className="text-ui-xs tabular-nums text-muted" data-testid="trajectory-filter-count">
            {visibleCount} / {allSteps.length} 步
          </span>
        ) : null}
      </div>

      <Timeline turns={visibleTurns} selected={selectedTurn} onSelect={(index) => setSelectedTurn((current) => (current === index ? null : index))} equal={equal} />

      <div className="overflow-hidden rounded-lg border border-line-soft">
        <table className="w-full table-fixed border-collapse text-ui-sm">
          <caption className="sr-only">按轮分组的会话轨迹：步骤、类型、内容、状态与耗时</caption>
          <thead>
            <tr className="border-b border-line-soft bg-subtle-1 text-left text-ui-xs text-muted">
              <th scope="col" className="w-10 py-1.5 pl-3 font-medium">步</th>
              <th scope="col" className="w-16 py-1.5 font-medium">类型</th>
              <th scope="col" className="py-1.5 font-medium">内容</th>
              <th scope="col" className="w-16 py-1.5 font-medium">状态</th>
              <th scope="col" className="w-16 py-1.5 pr-3 font-medium">耗时</th>
            </tr>
          </thead>
          <tbody>
            {visibleTurns.map((turn) => {
              const isCollapsed = collapsed.has(turn.index);
              return [
                <tr key={`turn-${turn.index}`} className="border-b border-line-soft bg-subtle-1/60">
                  <th colSpan={5} scope="rowgroup" className="py-1.5 pl-3 pr-3 text-left font-normal">
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(turn.index)) next.delete(turn.index);
                          else next.add(turn.index);
                          return next;
                        })
                      }
                      className="flex w-full items-baseline gap-2 text-left"
                    >
                      <span className="text-ui-xs tabular-nums text-muted">{isCollapsed ? "⊞" : "⊟"}</span>
                      <span className="text-ui-xs font-medium text-ink">第 {turn.index} 轮</span>
                      <span className="text-ui-xs tabular-nums text-muted">
                        {turn.steps.length} 步
                        {turn.running ? " · 进行中" : ""}
                      </span>
                    </button>
                  </th>
                </tr>,
                isCollapsed ? (
                  <tr key={`collapsed-${turn.index}`} className="border-b border-line-soft">
                    <td colSpan={5} className="py-1.5 pl-3 pr-3 text-ui-xs text-muted">
                      本轮已折叠：点上面的「⊞」展开 {turn.steps.length} 步。
                    </td>
                  </tr>
                ) : (
                  turn.steps.map((row, i) => {
                    const tone = STEP_TONES[row.status];
                    const ms = msOf(row);
                    const duration = ms !== null ? formatDuration(ms) : "—";
                    const expanded = openRow === row.id;
                    const expandable = Boolean(row.args || row.result || row.text || row.detail);
                    return [
                      <tr
                        key={row.id}
                        className="cursor-pointer border-b border-line-soft align-baseline last:border-b-0 hover:bg-subtle-1"
                        onClick={() => setOpenRow(expanded ? null : row.id)}
                      >
                        <td className="py-1.5 pl-3 text-ui-xs tabular-nums text-muted">#{i + 1}</td>
                        <td className="py-1.5">
                          <span className={`inline-block rounded border px-1 text-ui-xs leading-4 ${kindClass(row.kind)}`}>
                            {KIND_LABELS[row.kind]}
                          </span>
                        </td>
                        <td className="min-w-0 py-1.5 pr-2">
                          <span className="block truncate text-ink" title={row.label}>
                            {row.label}
                          </span>
                          {row.detail ? (
                            <span className="mt-0.5 block truncate text-ui-xs text-muted" title={row.detail}>
                              {row.detail}
                            </span>
                          ) : null}
                        </td>
                        <td className={`whitespace-nowrap py-1.5 text-ui-xs ${tone.text}`}>{tone.label}</td>
                        <td className="whitespace-nowrap py-1.5 pr-3 text-right text-ui-xs tabular-nums text-muted">
                          {duration ?? "—"}
                        </td>
                      </tr>,
                      expanded && expandable ? (
                        <tr key={`${row.id}-detail`} className="border-b border-line-soft bg-subtle-1/40">
                          <td colSpan={5} className="px-3 py-2">
                            {row.args ? (
                              <div className="mb-1">
                                <span className="text-ui-xs text-muted">参数</span>
                                <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-surface p-1.5 text-ui-xs leading-4 text-ink">
                                  {row.args}
                                </pre>
                              </div>
                            ) : null}
                            {row.result ? (
                              <div>
                                <span className="text-ui-xs text-muted">结果</span>
                                <pre className="mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-surface p-1.5 text-ui-xs leading-4 text-ink">
                                  {row.result}
                                </pre>
                              </div>
                            ) : null}
                            {!row.result && (row.text || row.detail) ? (
                              <p className="whitespace-pre-wrap break-words text-ui-xs leading-5 text-ink">
                                {row.text ?? row.detail}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      {visibleTurns.length === 0 ? (
        <p className="mt-3 text-ui-sm text-muted" data-testid="trajectory-no-match">
          没有匹配的步骤：换个关键词，或清掉筛选看回整段会话。
        </p>
      ) : null}
    </section>
  );
}




