/**
 * 会话任务清单（`todo_write` 的可见落点，d.158）。
 *
 * 为什么要有它：d.155 把清单写进了会话状态、d.157 让智能体在清单没做完时自动接着做，
 * 但**用户始终看不见这份清单**——只能从工具调用气泡里逐条拼。长任务跑 36 轮时，
 * 用户最需要的是「它计划做什么、现在到第几步、还剩几条」，这一屏就是这个答案。
 *
 * 四条口径：
 * - **清单为空时什么都不渲染**：没写清单的会话不该多出一块空壳，不占输入区高度。
 * - **进度与状态同源**：计数走 `countTodos`，与工具回显、提示词同一份算法，不另算一套。
 * - **默认展开**：长任务进行中用户要看细节；全部完成时仍显示（让用户核对），可手动折叠。
 * - **只读**：清单的所有权在模型（整份替换），这里不给用户编辑入口——两处都能改会导致
 *   「模型以为自己在做 A、清单显示 B」的分裂。用户要改就下一句话告诉它。
 */
import { useState } from "react";
import { countTodos, type TodoItem } from "../lib/todo/store.js";
import { useTodos } from "../lib/todo/useTodos.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";

/** 状态标记：与 `formatTodos` 的 `[x]/[>]/[ ]` 同语义，只是这里用字形（读屏念得出来）。 */
function statusGlyph(status: TodoItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▸";
  return "○";
}

function statusLabel(status: TodoItem["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  return "待开始";
}

export function TodoPanel({ conversationId }: { conversationId?: string }) {
  const items = useTodos(conversationId);
  const [open, setOpen] = useState(true);

  // 没清单 = 这个会话没在做多步任务：不渲染任何东西（含空占位）。
  if (items.length === 0) return null;

  const counts = countTodos(items);
  const allDone = counts.completed === counts.total;
  const percent = counts.total === 0 ? 0 : Math.round((counts.completed / counts.total) * 100);

  return (
    <section
      aria-label="任务清单"
      className="mx-2 mb-1 mt-1 rounded-lg border border-line-soft bg-subtle-1 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="todo-panel-list"
          onClick={() => setOpen((v) => !v)}
          className={`ui-hit -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left text-ui-sm text-ink hover:bg-subtle-4 ${FOCUS_RING}`}
        >
          <span aria-hidden="true" className="shrink-0 text-muted">
            {open ? "▾" : "▸"}
          </span>
          <span className="shrink-0 font-medium">任务清单</span>
          {/* aria-live：模型每完成一步，读屏用户能听见进度变化（不需要抢焦点）。 */}
          <span role="status" aria-live="polite" className="shrink-0 tabular-nums text-muted">
            已完成 {counts.completed}/{counts.total}
            {counts.inProgress > 0 ? ` · 进行中 ${counts.inProgress}` : ""}
          </span>
          {allDone ? (
            <span className="shrink-0 rounded-sm bg-success-soft px-1 text-ui-sm text-success">
              全部完成
            </span>
          ) : null}
        </button>
      </div>
      {/* 进度条：始终显示（折叠时它是唯一的进度信息），纯装饰，读屏走上面那行数字。 */}
      <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-subtle-4">
        <div
          className={`h-full rounded-full transition-all ${allDone ? "bg-success" : "bg-ink"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {open ? (
        <ul
          id="todo-panel-list"
          className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto pr-1"
        >
          {items.map((item, index) => (
            <li
              key={`${index}-${item.content}`}
              className="flex items-start gap-1.5 text-ui-md leading-5"
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 shrink-0 ${
                  item.status === "completed"
                    ? "text-success"
                    : item.status === "in_progress"
                      ? "text-ink"
                      : "text-muted"
                }`}
              >
                {statusGlyph(item.status)}
              </span>
              <span className="sr-only">{statusLabel(item.status)}：</span>
              <span
                title={item.content}
                className={`min-w-0 break-words ${
                  item.status === "completed" ? "text-muted line-through" : "text-ink"
                }`}
              >
                {item.content}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
