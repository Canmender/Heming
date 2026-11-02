import { useEffect, useState } from "react";
import { rolloutLog } from "../lib/rollout/index.js";
import type { RolloutItem } from "../lib/rollout/types.js";

/**
 * 任务区的「过程日志」：只读展示一次执行到底发生了什么。
 *
 * 为什么需要它：任务区的汇总（目标/结果/步骤）是**结论**，排查时真正要看的是
 * **过程**——模型先调了什么、参数是什么、工具回了什么、哪一步被拒绝。
 * 这些事实在 `lib/rollout` 里逐条记着，这个组件只负责读出来，不提供任何编辑：
 * 日志是证据，不是可以回头改写的东西。
 *
 * 三条展示口径：
 * - **只读**：没有删除/编辑入口（清理由设置层统一做，避免在证据上动手）；
 * - **本机**：日志只在本机，界面必须写明，否则用户会以为它会随账号同步；
 * - **有界**：日志本身有上限（200 条），界面再截断到最近 60 条——一次任务的过程
 *   没人会往下翻两百行，真要看全部请用导出的 JSON。
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

export interface RolloutTimelineProps {
  /** 任务绑定的流 id（`TaskRecord.streamId`）。 */
  streamId: string;
  /** 运行中的任务：每 `REFRESH_MS` 重读一次。 */
  active?: boolean;
  /** 读取实现（测试注入；缺省读本机日志）。 */
  read?: (streamId: string) => RolloutItem[];
}

export function RolloutTimeline({ streamId, active = false, read }: RolloutTimelineProps) {
  const load = read ?? ((id: string) => rolloutLog.read(id));
  const [items, setItems] = useState<RolloutItem[]>(() => load(streamId));

  useEffect(() => {
    setItems(load(streamId));
    if (!active) return;
    const timer = setInterval(() => setItems(load(streamId)), REFRESH_MS);
    return () => clearInterval(timer);
    // load 每次渲染都是新函数时不该重建定时器：以 streamId/active 为界即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamId, active]);

  const shown = items.slice(-MAX_VISIBLE_ITEMS);
  const hidden = items.length - shown.length;

  return (
    <section aria-label="过程日志">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted">过程日志</h3>
        <span className="text-[10px] text-muted">
          {items.length ? `${items.length} 条 · 只读 · 仅本机` : "只读 · 仅本机"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-[12px] leading-5 text-muted">
          这次任务没有过程日志。日志只在本机记录，且只从有日志能力的版本开始。
        </p>
      ) : (
        <>
          {hidden > 0 && (
            <p className="mb-1 text-[10px] text-muted">仅显示最近 {MAX_VISIBLE_ITEMS} 条</p>
          )}
          <ol className="flex flex-col gap-1">
            {shown.map((item, i) => {
              const detail = detailOf(item);
              const title = titleOf(item);
              return (
                <li
                  key={`${item.at}-${item.type}-${i}`}
                  className="rounded-lg border border-line-soft px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
                      {clockOf(item.at)}
                    </span>
                    <span
                      className={`shrink-0 rounded-full border px-1.5 text-[10px] ${chipClass(item)}`}
                    >
                      {LABELS[item.type]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{title}</span>
                  </div>
                  {detail && (
                    <details className="mt-0.5">
                      <summary className="cursor-pointer list-none text-[10px] text-muted hover:text-[#333]">
                        查看明细
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-[#fafafa] p-1.5 font-mono text-[10px] leading-4">
                        {detail}
                      </pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
