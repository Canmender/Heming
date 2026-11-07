import { useEffect } from "react";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useUiStore } from "../store/ui.js";

/**
 * 首页「本机归档」卡（d.46）。
 *
 * 只做露出：日程摘要 + 归档规模 + 两个入口。真正的检索/同步仍在信息中枢页，
 * 这里不复制那套状态机。浏览器端没有本机桥，整张卡不渲染。
 */

const CARD = "rounded-xl border border-[#ececec] bg-white p-3 shadow-card";
const LINK = "ui-link";

export function InfohubHomeCard() {
  const available = useInfohubStore((s) => s.available);
  const running = useInfohubStore((s) => s.running);
  const status = useInfohubStore((s) => s.status);
  const agenda = useInfohubStore((s) => s.agenda);
  const busy = useInfohubStore((s) => s.busy);
  const error = useInfohubStore((s) => s.error);
  const connect = useInfohubStore((s) => s.connect);
  const openInfohub = useUiStore((s) => s.openInfohub);

  // App 已 boot 过一次；这里兜底，保证单独渲染首页时也能拿到桥状态。
  useEffect(() => {
    void useInfohubStore.getState().boot();
  }, []);

  if (!available) return null;

  if (!running) {
    return (
      <section className={CARD} aria-label="本机归档">
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-bold text-muted">本机归档</div>
          <span className="rounded-sm border border-line px-1.5 text-[10px] text-muted">未连接</span>
          <button
            type="button"
            disabled={busy === "connecting"}
            onClick={() => void connect()}
            className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[#fafafa] disabled:opacity-50"
          >
            {busy === "connecting" ? "连接中…" : "连接"}
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          读本机的 QQ / 微信聊天记录；连接后智能体能检索归档、看日程。
        </p>
        {error && <p role="alert" className="mt-1 text-[11px] text-[#b42318]">{error}</p>}
      </section>
    );
  }

  const summary = agenda?.summary;
  const items = [...(agenda?.items ?? [])].sort((a, b) => a.dueTs - b.dueTs).slice(0, 3);
  const stats = status?.stats;

  return (
    <section className={CARD} aria-label="本机归档">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="text-[12px] font-bold text-muted">本机归档</div>
        <span className="rounded-sm border border-line bg-[#fafafa] px-1.5 text-[10px] text-muted">已连接</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className={LINK} onClick={() => openInfohub({ tab: "search" })}>
            检索归档
          </button>
          <button type="button" className={LINK} onClick={() => openInfohub({ tab: "agenda" })}>
            全部日程
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`rounded-full border border-line px-2 py-0.5 ${summary && summary.overdue > 0 ? "text-[#b42318]" : "text-muted"}`}>
          逾期 {summary?.overdue ?? 0}
        </span>
        <span className="rounded-full border border-line px-2 py-0.5 text-muted">今天 {summary?.today ?? 0}</span>
        <span className="rounded-full border border-line px-2 py-0.5 text-muted">本周 {summary?.week ?? 0}</span>
        {busy === "status" || busy === "agenda" ? (
          <span className="text-[10px] text-muted">读取中…</span>
        ) : null}
        <span className="ml-auto text-[10px] text-muted">
          {stats
            ? `${stats.conversations.toLocaleString("zh-CN")} 个会话 · ${stats.messages.toLocaleString("zh-CN")} 条消息`
            : ""}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted">近期没有待办。</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openInfohub({ tab: "agenda" })}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-[#f7f7f7]"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{item.title}</span>
                {item.detail ? <span className="ml-1 text-muted">{item.detail}</span> : null}
              </span>
              <span className="shrink-0 text-[10px] text-muted">{item.dueText}</span>
              <span className="shrink-0 text-[10px] text-muted">{item.convName}</span>
            </button>
          ))}
        </div>
      )}

      {error && <p role="alert" className="mt-1.5 text-[11px] text-[#b42318]">{error}</p>}
    </section>
  );
}
