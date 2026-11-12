import { useMemo } from "react";
import { useChatStore } from "../../store/chat.js";
import { useHitlStore } from "../../store/hitl.js";
import { unreadCount, useNotificationStore } from "../../store/notifications.js";
import { useTaskStore } from "../../lib/tasks/store.js";
import { useUiStore } from "../../store/ui.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";

/**
 * 首页「需要你处理」（d.84）。
 *
 * 主页第一优先级不是「团队有几个人」，而是「现在有没有事在等你」。这里只列**可动作**的条目：
 * - 工具调用待确认（HITL，正在等用户裁决，不处理就卡住）；
 * - 正在运行的任务（跑没跑完、卡没卡）；
 * - 未读通知（任务收尾 / 幕僚简报 / 自动化失败），approval 类不重复列（HITL 已经覆盖）。
 *
 * 全部点一下直达对应位置：审批/任务 → 那个会话或任务；幕僚/自动化 → 对应页。
 * 没有可处理的事就整块不渲染，不占首屏。
 */

interface AttentionRow {
  key: string;
  title: string;
  detail: string;
  actionLabel: string;
  onOpen: () => void;
}

/** 正在运行多久（分钟）；数据本身在任务记录里。 */
function runningFor(startedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 1) return "刚开始";
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  return `已运行 ${Math.floor(minutes / 60)} 小时`;
}

export function NeedsAttention() {
  const conversations = useChatStore((s) => s.conversations);
  const hitlPending = useHitlStore((s) => s.pending);
  const notifications = useNotificationStore((s) => s.items);
  const tasks = useTaskStore((s) => s.tasks);

  const rows = useMemo<AttentionRow[]>(() => {
    const out: AttentionRow[] = [];
    const ui = useUiStore.getState();

    // ① 工具调用待确认：只处理卡片（HITL）里的实时 pending，不重复列 approval 通知
    if (hitlPending) {
      const toolName = hitlPending.calls[0]?.name;
      out.push({
        key: `hitl:${hitlPending.requestId}`,
        title: `「${hitlPending.agentName}」在等你确认${toolName ? ` ${toolName}` : "工具调用"}`,
        detail:
          hitlPending.calls.length > 1
            ? `共 ${hitlPending.calls.length} 个操作待确认`
            : "不处理的话这一轮会一直停着",
        actionLabel: "去确认",
        onOpen: () => ui.openConversation(hitlPending.conversationId),
      });
    }

    // ② 正在运行的任务：任务区的「进行中」在首页也要看得到
    const running = tasks.filter((t) => t.status === "running");
    const now = Date.now();
    for (const task of running.slice(0, 2)) {
      const conv = conversations.find((c) => c.id === task.conversationId);
      out.push({
        key: `task:${task.id}`,
        title: `任务正在运行：${task.title}`,
        detail: `${runningFor(task.createdAt, now)} · ${conv?.agent.name ?? task.agentName}`,
        actionLabel: "查看进度",
        onOpen: () => ui.focusTask(task.id, task.conversationId),
      });
    }
    if (running.length > 2) {
      out.push({
        key: "task:more",
        title: `还有 ${running.length - 2} 个任务在跑`,
        detail: "在团队页看板的「任务」里查看全部运行中的任务",
        actionLabel: "查看任务",
        // d.138：任务列表在团队页看板；原来指向 chat/tasks，对话页不认这个视图，
        // 点完整页几乎没变化（只是停在对话 Tab）。
        onOpen: () => ui.setPage("team", "board"),
      });
    }

    // ③ 未读通知（approval 由 ① 覆盖，不再列一遍）
    const unread = notifications.filter((n) => !n.read && n.kind !== "approval");
    for (const item of unread.slice(0, 2)) {
      const target = (() => {
        if (item.kind === "task" && item.taskId) {
          return () => ui.focusTask(item.taskId!, item.conversationId);
        }
        if (item.kind === "staff") return () => ui.setPage("staff");
        if (item.kind === "automation") return () => ui.setPage("automations");
        if (item.conversationId) return () => ui.openConversation(item.conversationId!);
        return null;
      })();
      if (!target) continue;
      out.push({
        key: `ntf:${item.id}`,
        title: item.title,
        detail: item.body || "打开查看",
        actionLabel: "查看",
        onOpen: target,
      });
    }

    return out.slice(0, 4);
  }, [conversations, hitlPending, notifications, tasks]);

  if (rows.length === 0) return null;

  return (
    <section aria-label="需要你处理" className="ui-card overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--warn)" }} aria-hidden="true" />
        <span className="text-[12px] font-bold">需要你处理</span>
        <span className="ui-micro rounded-sm border border-line px-1">{rows.length}</span>
        <span className="ml-auto ui-caption">处理完会自动消失</span>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.key} className="border-b border-line-soft last:border-b-0">
            <button
              type="button"
              onClick={row.onOpen}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{row.title}</span>
                <span className="block truncate ui-caption">{row.detail}</span>
              </span>
              <span className="shrink-0 ui-link">{row.actionLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
