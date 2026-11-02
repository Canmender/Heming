import { useEffect, useRef, useState } from "react";
import {
  unreadCount,
  useNotificationStore,
  type AppNotification,
} from "../store/notifications.js";
import { useUiStore } from "../store/ui.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useModalA11y } from "./useModalA11y.js";

/**
 * 通知中心入口：铃铛 + 右侧浮层。
 *
 * 放在导航轨底部而不是标题栏：桌面端标题栏只有拖拽带（无系统按钮），
 * 浏览器端干脆不渲染——铃铛得在这两种形态下都在同一个位置。
 */

/** 相对时间（列表里比绝对时间好扫）：刚 / N 分钟前 / N 小时前 / 日期。 */
export function formatRelativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const KIND_LABEL: Record<AppNotification["kind"], string> = {
  task: "任务",
  // d.34：等待裁决的工具确认——点开跳回来源智能体会话，弹窗在那儿等着。
  approval: "确认",
  // d.48：常驻幕僚的主动简报——点开去幕僚页看完整证据。
  staff: "幕僚",
};

export function NotificationCenter() {
  const items = useNotificationStore((s) => s.items);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const remove = useNotificationStore((s) => s.remove);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const openConversation = useUiStore((s) => s.openConversation);
  const focusTask = useUiStore((s) => s.focusTask);

  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 非模态浮层（aria-modal=false）：不屏蔽背景。屏蔽会把铃铛自己一起 inert 掉，
  // 「点面板外关闭」就失效了——背景可点、Esc 可关才是这个浮层的契约。
  useModalA11y(panelRef, () => setOpen(false), { active: open, blockBackground: false });

  // 点面板外关闭：与导出菜单同一个口径（pointerdown，不用遮罩也能收）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const unread = unreadCount(items);
  // 时间基准取打开时一次：列表里「3 分钟前」不该每秒重排，重排交给下一次打开。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (open) setNow(Date.now());
  }, [open]);

  const jump = (item: AppNotification) => {
    markRead(item.id);
    setOpen(false);
    if (item.kind === "staff") {
      useUiStore.getState().setPage("staff");
      return;
    }
    if (item.kind === "task" && item.taskId) {
      focusTask(item.taskId, item.conversationId);
      return;
    }
    if (item.conversationId) openConversation(item.conversationId);
  };

  return (
    <div ref={wrapRef} className="group relative">
      <button
        type="button"
        aria-label={`通知中心${unread > 0 ? ` ${unread} 条未读` : ""}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          // 打开即视为「已看到有通知」：列表项的未读点保留到逐条点击/全部已读，
          // 但角标不清——清了用户就没法知道哪几条还没细看。
        }}
        className={`flex h-[30px] w-[30px] items-center justify-center rounded-[9px] transition-colors duration-150 ${
          open ? "bg-ink text-white" : "text-[#666] hover:bg-[#f0f0f0] hover:text-ink"
        }`}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.2 5.4 2 6.2H4c.8-.8 2-2.2 2-6.2z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full border border-white bg-ink px-1 text-center text-[9px] font-semibold leading-[14px] text-white">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="通知中心"
          className="absolute bottom-0 left-full z-40 ml-2 flex max-h-[70vh] w-[320px] flex-col overflow-hidden rounded-xl border border-[#ececec] bg-white shadow-card"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
            <span className="text-[12px] font-bold">通知中心</span>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={markAllRead}
                disabled={unread === 0}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-[#f0f0f0] hover:text-ink disabled:opacity-40"
              >
                全部已读
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={items.length === 0}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-[#f0f0f0] hover:text-ink disabled:opacity-40"
              >
                清空
              </button>
              <button
                type="button"
                aria-label="关闭通知中心"
                onClick={() => setOpen(false)}
                className="rounded px-1.5 py-0.5 text-[13px] leading-none text-muted hover:bg-[#f0f0f0] hover:text-ink"
              >
                ×
              </button>
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] leading-5 text-muted">
                还没有通知。
                <br />
                任务收尾、待确认的工具调用与幕僚简报会在这里汇总。
              </p>
            ) : (
              <ul className="divide-y divide-[#f0f0f0]">
                {items.map((item) => (
                  <li key={item.id} className={`px-3 py-2 ${item.read ? "" : "bg-[#fbfbfb]"}`}>
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        aria-label={`打开通知：${item.title}`}
                        onClick={() => jump(item)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-baseline gap-1.5">
                          <span className="shrink-0 rounded border border-[#ececec] px-1 text-[10px] text-muted">
                            {KIND_LABEL[item.kind]}
                          </span>
                          <span
                            className={`truncate text-[12px] ${item.read ? "text-ink" : "font-bold text-ink"}`}
                          >
                            {item.title}
                          </span>
                        </div>
                        {item.body && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">
                            {item.body}
                          </p>
                        )}
                        <span className="mt-0.5 block text-[10px] text-[#999]">
                          {formatRelativeTime(item.createdAt, now)}
                        </span>
                      </button>
                      <span className="flex shrink-0 items-center gap-1">
                        {!item.read && (
                          <button
                            type="button"
                            aria-label={`标记已读：${item.title}`}
                            onClick={() => markRead(item.id)}
                            className="rounded px-1 py-0.5 text-[10px] text-muted hover:bg-[#f0f0f0] hover:text-ink"
                          >
                            已读
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`删除通知：${item.title}`}
                          onClick={() => remove(item.id)}
                          className="rounded px-1 py-0.5 text-[12px] leading-none text-muted hover:bg-[#f0f0f0] hover:text-ink"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {confirmClear && (
            <ConfirmDialog
              title="清空通知"
              onCancel={() => setConfirmClear(false)}
              footer={
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearAll();
                      setConfirmClear(false);
                    }}
                    className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#912018]"
                  >
                    清空
                  </button>
                </>
              }
            >
              <p className="text-[12px] leading-6">
                清空全部 {items.length} 条通知？未读的也会一起清掉；
                会话本身的消息与未读角标不受影响，通知只是提醒的副本。
              </p>
            </ConfirmDialog>
          )}
        </div>
      )}
    </div>
  );
}
