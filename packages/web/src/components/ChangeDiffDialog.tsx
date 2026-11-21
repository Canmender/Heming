import { useEffect, useState } from "react";
import { Button } from "./ui/Button.js";
import { Dialog } from "./ui/Dialog.js";
import type { SessionChange } from "../lib/fileEdit/sessionChanges.js";
import { diffLines, formatDiffStat } from "../lib/fileEdit/turnDiff.js";

/**
 * 「这一轮到底改了什么」对照弹窗（d.207.4.110；d.210 加会话文件列表）。
 *
 * ## 为什么要有它
 *
 * 撤回条已经能**撤**，但撤之前得先知道改了什么。d.176/d.185 之前用户只有两个选择：直接撤（赌一把）、
 * 或者去编辑器里翻——而改动往往发生在用户没打开的文件里。结果是「撤回」这个功能平时不敢用。
 *
 * ## 口径
 *
 * - 对照的两边都是**真实磁盘内容**：改动前那份来自主进程的写入备份（只读预览，不消费备份），
 *   改动后那份来自当前文件。不拿工具参数拼，因为参数可能是部分片段（`file_edit` 只给 old/new 串）。
 * - 读不到就说读不到：新建文件没有「改动前」、备份已撤销、桌面端太老——分别给一句话，不显示空弹窗。
 * - 二进制/截断如实说：看不懂的东西不要硬画成「改了 N 行」。
 * - 会话级回顾（d.210）：传了 `files` 就在左边列这个会话改过的文件，点一条换右边的内容；
 *   一条都不传时保持原来的单文件样子（`TurnUndoBar` 的入口不走列表）。
 */
export interface ChangeDiffState {
  /** 目标文件绝对路径（正斜杠）。 */
  path: string;
  /** 正在读备份/当前内容。 */
  loading: boolean;
  /** 读取失败的原因（一句话，直接给用户看）。 */
  error: string | null;
  /** 改动前内容；读不到为 null。 */
  before: string | null;
  /** 改动后（当前）内容；读不到为 null。 */
  after: string | null;
  /** 备份被主进程按上限截断（只回了前 256KB）。 */
  beforeTruncated?: boolean;
  /** 当前文件内容被截断（读超过 2MB 的文件时）。 */
  afterTruncated?: boolean;
}

export function ChangeDiffDialog({
  state,
  onClose,
  files,
  onPick,
}: {
  state: ChangeDiffState;
  onClose: () => void;
  /** 会话级入口：这个会话改过的文件（最近改的在前）。 */
  files?: readonly SessionChange[];
  /** 会话级入口：点了左边某个文件。 */
  onPick?: (path: string) => void;
}) {
  const name = state.path.split("/").pop() ?? state.path;
  const dir = state.path.slice(0, Math.max(0, state.path.length - name.length)).replace(/\/$/, "");
  const readable = state.before !== null && state.after !== null && state.error === null;
  const result = readable ? diffLines(state.before ?? "", state.after ?? "") : null;
  const list = files ?? [];
  const pickable = list.length > 0 && typeof onPick === "function";
  // d.239：改动往往只占长文件里十来行——给一个「只看改动」，避免用户在上下文里翻找。
  const [onlyChanges, setOnlyChanges] = useState(false);
  // 会话级入口会在弹窗挂载期间换文件（点左边列表）；换新文件时回到「完整上下文」，
  // 否则上一个文件勾的「只看改动」会让新文件的上下文行一直藏着。
  useEffect(() => setOnlyChanges(false), [state.path]);
  const rows = result === null ? [] : onlyChanges ? result.rows.filter((row) => row.kind !== "same") : result.rows;
  const hasContext = result !== null && result.rows.some((row) => row.kind === "same");

  const content = (
    <div data-testid="change-diff" className="space-y-2">
      {state.loading ? (
        <p role="status" className="text-ui-sm text-muted">
          正在读改动前的版本…
        </p>
      ) : null}

      {!state.loading && state.error !== null ? (
        <p role="alert" className="text-ui-sm text-danger">
          {state.error}
        </p>
      ) : null}

      {!state.loading && readable && result ? (
        <>
          <p role="status" className="text-ui-sm text-muted">
            {formatDiffStat(result)}
            {result.identical ? "（可能新建后又改回了原样）" : null}
          </p>
          {state.beforeTruncated ? (
            <p className="text-ui-xs text-warn">改动前的备份只读了前 256KB，下面只是其中一部分。</p>
          ) : null}
          {state.afterTruncated ? (
            <p className="text-ui-xs text-warn">当前文件太大，只读了前 2MB，下面只是其中一部分。</p>
          ) : null}
          {result.truncated ? (
            <p className="text-ui-xs text-warn">对照太长，这里只显示前面一部分（统计仍按全量算）。</p>
          ) : null}
          {result.identical ? null : (
            <>
              {hasContext ? (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={onlyChanges}
                    onClick={() => setOnlyChanges((value) => !value)}
                  >
                    {onlyChanges ? "显示上下文" : "只看改动"}
                  </Button>
                  <span className="text-ui-xs text-muted" data-testid="diff-row-count">
                    {onlyChanges ? `已隐藏未改动的行（共 ${result.rows.length} 行）` : `共 ${result.rows.length} 行（含上下文）`}
                  </span>
                </div>
              ) : null}
            <div
              data-testid="diff-scroll"
              className={`overflow-auto rounded-md border border-line-soft bg-panel font-mono text-ui-xs ${
                pickable ? "max-h-[52vh]" : "max-h-[60vh]"
              }`}
            >
              {rows.map((row, index) => {
                const rowClass =
                  row.kind === "add"
                    ? "bg-success-soft text-success"
                    : row.kind === "del"
                      ? "bg-danger-soft text-danger"
                      : "text-muted";
                const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
                const oldNo = row.kind === "add" ? "" : String(row.oldNo);
                const newNo = row.kind === "del" ? "" : String(row.newNo);
                return (
                  <div
                    key={`${row.kind}-${index}`}
                    data-testid={`diff-row-${row.kind}`}
                    className={`flex items-start gap-2 px-2 py-[1px] ${rowClass}`}
                  >
                    <span className="w-8 shrink-0 select-none text-right opacity-60">{oldNo}</span>
                    <span className="w-8 shrink-0 select-none text-right opacity-60">{newNo}</span>
                    <span className="w-3 shrink-0 select-none">{sign}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-all">{row.text || " "}</span>
                  </div>
                );
              })}
            </div>
            </>
          )}
        </>
      ) : null}
    </div>
  );

  return (
    <Dialog
      ariaLabel="文件改动"
      title={pickable ? `本会话改过的文件 · ${list.length} 个` : `改动对照 · ${name}`}
      description={pickable ? state.path : dir || undefined}
      size="xl"
      maxHeightVh={86}
      onClose={onClose}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          知道了
        </Button>
      }
      bodyClassName="p-4"
    >
      {pickable ? (
        <div className="flex gap-3">
          <aside
            aria-label="本会话改过的文件"
            data-testid="change-diff-files"
            className="max-h-[60vh] w-56 shrink-0 overflow-auto rounded-md border border-line-soft"
          >
            {list.map((item) => {
              const itemName = item.path.split("/").pop() ?? item.path;
              const active = item.path === state.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  title={item.path}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onPick?.(item.path)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-line-soft px-2 py-1.5 text-left text-ui-xs last:border-b-0 ${
                    active ? "bg-subtle-2 text-body" : "text-muted hover:bg-subtle-2 hover:text-body"
                  }`}
                >
                  <span className="max-w-full truncate">{itemName}</span>
                  <span className="max-w-full truncate opacity-70">
                    {item.writes > 1 ? `改过 ${item.writes} 次` : "改过 1 次"}
                  </span>
                </button>
              );
            })}
          </aside>
          <div className="min-w-0 flex-1">{content}</div>
        </div>
      ) : (
        content
      )}
    </Dialog>
  );
}
