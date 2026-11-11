/**
 * 执行数据预览：JSON 树 / 表格 / 原始文本三种视图。
 *
 * 为什么不是一个 `<pre>`：节点数据有两类最常见形状——
 * - 单个对象（HTTP 响应、设置字段）：看树最直观；
 * - 一组对象（列表、解析结果）：看表格才看得出每行差在哪。
 * 提供「原始文本」是为了复制/对照，而不是让人在树里找字段。
 *
 * 数据可能被 `executions.ts` 裁剪过（单 item 超过 64KB 会被替换成截断标记），
 * 这里把标记翻译成用户能读懂的一句话，而不是显示一个莫名的 `__hemingTruncated`。
 */

import { useMemo, useState, type ReactNode } from "react";

/** 树里每层最多展开多少个键/项（防止一个几千键的对象把页面钉死）。 */
const MAX_TREE_CHILDREN = 100;
/** 树最大深度：再深就提示「已省略」。 */
const MAX_TREE_DEPTH = 6;
/** 表格最多展示多少行（其余提示省略）。 */
const MAX_TABLE_ROWS = 200;

export type DataPreviewView = "tree" | "table" | "raw";

export interface DataPreviewProps {
  /** 任意 JSON 数据（items、参数、响应体都行）。 */
  data: unknown;
  /** 标题（可选；只显示在头部）。 */
  title?: string;
  /** 空数据时显示的话。 */
  emptyText?: string;
  /** 超过这么多字节显示「已截断」提示（默认 64KB，与 WORKFLOW_LIMITS 同口径）。 */
  maxBytes?: number;
  /** 初始视图；默认按数据形状自动选（对象数组用表格）。 */
  defaultView?: DataPreviewView;
  /** 紧凑模式：减小内边距、树深度更浅（详情面板里用）。 */
  compact?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonText(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? "";
  } catch {
    return String(data);
  }
}

function byteSize(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

/** 数据里是否带「已被执行记录裁剪」的标记（深层扫描，最多 2000 个节点）。 */
export function hasTruncationMarker(data: unknown): boolean {
  let visited = 0;
  const scan = (value: unknown): boolean => {
    visited += 1;
    if (visited > 2000) return false;
    if (Array.isArray(value)) return value.some(scan);
    if (!isPlainObject(value)) return false;
    if (value.__hemingTruncated === true || value.__hemingBinaryDropped === true) return true;
    return Object.values(value).some(scan);
  };
  return scan(data);
}

function previewPrimitive(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function primitiveClass(value: unknown): string {
  if (value === null || value === undefined) return "text-muted";
  if (typeof value === "number") return "text-[#1d4ed8]";
  if (typeof value === "boolean") return "text-[#b45309]";
  return "text-ink";
}

function JsonTree({ value, depth, name }: { value: unknown; depth: number; name?: string }): ReactNode {
  const label = name !== undefined ? <span className="text-muted">{name}</span> : null;
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_TREE_CHILDREN);
    return (
      <details open={depth < 3} className="min-w-0">
        <summary className="cursor-pointer select-none text-[12px]">
          {label}
          {label ? ": " : null}
          <span className="text-muted">[{value.length}]</span>
        </summary>
        <div className="border-l border-line-soft pl-3">
          {shown.map((entry, index) => (
            <JsonTree key={index} value={entry} depth={depth + 1} name={`${index}`} />
          ))}
          {value.length > shown.length ? (
            <p className="ui-caption">已省略剩余 {value.length - shown.length} 项</p>
          ) : null}
        </div>
      </details>
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).slice(0, MAX_TREE_CHILDREN);
    return (
      <details open={depth < 3} className="min-w-0">
        <summary className="cursor-pointer select-none text-[12px]">
          {label}
          {label ? ": " : null}
          <span className="text-muted">{`{${Object.keys(value).length}}`}</span>
        </summary>
        <div className="border-l border-line-soft pl-3">
          {entries.map(([key, entry]) => (
            <JsonTree key={key} value={entry} depth={depth + 1} name={key} />
          ))}
          {Object.keys(value).length > entries.length ? (
            <p className="ui-caption">已省略剩余 {Object.keys(value).length - entries.length} 个键</p>
          ) : null}
        </div>
      </details>
    );
  }
  return (
    <div className="flex min-w-0 gap-1 text-[12px]">
      {label ? <span>{label}:</span> : null}
      <span className={`break-all ${primitiveClass(value)}`}>{previewPrimitive(value)}</span>
    </div>
  );
}

/** 一组对象 → 表格（列取并集，最多 20 列）。 */
function ObjectTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = useMemo(() => {
    const union: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!union.includes(key)) union.push(key);
        if (union.length >= 20) break;
      }
      if (union.length >= 20) break;
    }
    return union;
  }, [rows]);
  if (columns.length === 0) return <p className="ui-caption">没有可展示的字段。</p>;
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead className="sticky top-0 bg-[color:var(--panel)]">
          <tr>
            <th className="border-b border-line-soft px-2 py-1 font-medium text-muted">#</th>
            {columns.map((column) => (
              <th key={column} className="border-b border-line-soft px-2 py-1 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_TABLE_ROWS).map((row, index) => (
            <tr key={index} className="align-top">
              <td className="border-b border-line-soft px-2 py-1 text-muted">{index}</td>
              {columns.map((column) => (
                <td key={column} className="border-b border-line-soft px-2 py-1">
                  <span className="line-clamp-3 break-all">
                    {typeof row[column] === "object" && row[column] !== null
                      ? jsonText(row[column]).replace(/\s+/g, " ").slice(0, 200)
                      : previewPrimitive(row[column])}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_TABLE_ROWS ? (
        <p className="ui-caption mt-1">表格只显示前 {MAX_TABLE_ROWS} 行，共 {rows.length} 行。</p>
      ) : null}
    </div>
  );
}

/** 把 items 形状的数据拍平成「对象数组」供表格视图用。 */
function tableRowsOf(data: unknown): Array<Record<string, unknown>> | null {
  const list = Array.isArray(data) ? data : isPlainObject(data) && data.main ? [] : null;
  if (!list) return null;
  if (list.length === 0) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of list) {
    if (isPlainObject(entry) && isPlainObject(entry.json)) rows.push(entry.json);
    else if (isPlainObject(entry)) rows.push(entry);
    else if (typeof entry !== "object") rows.push({ value: entry });
    else return null;
  }
  return rows;
}

export function DataPreview({
  data,
  title,
  emptyText = "没有数据",
  maxBytes = 64 * 1024,
  defaultView,
  compact = false,
}: DataPreviewProps) {
  const text = useMemo(() => jsonText(data), [data]);
  const rows = useMemo(() => tableRowsOf(data), [data]);
  const initialView: DataPreviewView =
    defaultView ?? (rows && rows.length > 0 ? "table" : "tree");
  const [view, setView] = useState<DataPreviewView>(initialView);
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const empty = data === undefined || data === null || text === "" || text === "{}" || text === "[]";
  const truncated = byteSize(text) > maxBytes || hasTruncationMarker(data);

  async function copy(): Promise<void> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyState("done");
      } else {
        setCopyState("failed");
      }
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1500);
  }

  return (
    <div className={`rounded-lg border border-line-soft ${compact ? "p-2" : "p-3"}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {title ? <span className="ui-section-title">{title}</span> : null}
          <div role="group" aria-label="数据视图" className="flex gap-1">
            {(
              [
                ["tree", "树形"],
                ["table", "表格"],
                ["raw", "原始"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${
                  view === key
                    ? "border-[color:var(--line)] bg-[color:var(--panel)] font-medium"
                    : "border-transparent text-muted hover:bg-[#f5f5f5]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void copy();
          }}
          className="ui-btn ui-btn-sm ui-btn-ghost"
          aria-label={copyState === "done" ? "已复制" : "复制数据"}
        >
          {copyState === "done" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
        </button>
      </div>

      {truncated ? (
        <p className="ui-alert ui-alert-muted mb-2 text-[11px]">
          数据较大或已被执行记录裁剪：单条超过 64KB 时只保留预览，二进制超限会被丢弃。
        </p>
      ) : null}

      {empty ? (
        <p className="ui-caption py-2">{emptyText}</p>
      ) : view === "raw" ? (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[color:var(--panel)] p-2 text-[11px] leading-5">
          {text}
        </pre>
      ) : view === "table" ? (
        rows && rows.length > 0 ? (
          <ObjectTable rows={rows} />
        ) : (
          <p className="ui-caption py-2">这组数据不是对象数组，切到「树形」看更清楚。</p>
        )
      ) : (
        <div className={`max-h-[420px] overflow-auto ${compact ? "text-[11px]" : ""}`}>
          <JsonTree value={data} depth={0} />
        </div>
      )}
    </div>
  );
}
