import { FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";

/**
 * 「未绑定模型」统一提示（UX-A · U2）。
 *
 * 为什么必须同源：对话页与任务区原来各写一句（措辞、按钮、是否前置拦截都不一样），
 * 用户在两处看到的是两套说法。现在文案、按钮、判定都收在这一个组件里，
 * 页面只负责「传不传 agentName」与「去设置怎么跳」。
 */

/** 通用场景（还不知道具体是哪个智能体：例如整站还没有任何绑定）。 */
export const UNBOUND_GLOBAL_TEXT = "还没有智能体绑定 LLM 连接";

/** 已选中具体智能体时的文案（带名字更好定位要修哪个）。 */
export const UNBOUND_AGENT_TEXT = "当前智能体还没有绑定模型连接";

/** 统一文案：有名字走「当前智能体…（名字）」，没有名字走全局说法。 */
export function unboundNoticeText(agentName?: string): string {
  const name = agentName?.trim();
  return name ? `${UNBOUND_AGENT_TEXT}（${name}）` : UNBOUND_GLOBAL_TEXT;
}

export interface UnboundModelNoticeProps {
  /** 指定具体智能体名；不传 = 通用场景。 */
  agentName?: string;
  /** 「去设置」的动作（跳设置页 / 打开设置弹窗）；不传则不渲染按钮。 */
  onGoSettings?: () => void;
  /**
   * 本机已有的模型连接。传了且非空时，提示条里直接给一个选择器——
   * 「本机明明有连接、只是这个智能体没绑」不该让用户再跳去设置找一遍（d.82）。
   */
  connections?: { id: string; label: string }[];
  /** 选中连接后的动作（写本机绑定）；不传则不渲染选择器。 */
  onBind?: (profileId: string) => void;
  /**
   * 视觉形态：
   * - `card`：任务区那种独立卡片（表单里的一整块提示）；
   * - `inline`：对话页输入区上方的一条提示（贴边、不抢版面）。
   */
  variant?: "card" | "inline";
  /** 供 `aria-describedby` 关联的 id（对话页把输入框挂上去）。 */
  id?: string;
}

export const UNBOUND_NOTICE_ID = "unbound-model-notice";

export function UnboundModelNotice({
  agentName,
  onGoSettings,
  connections,
  onBind,
  variant = "card",
  id = UNBOUND_NOTICE_ID,
}: UnboundModelNoticeProps) {
  const text = unboundNoticeText(agentName);
  const canQuickBind = Boolean(onBind) && (connections?.length ?? 0) > 0;
  const base =
    variant === "card"
      ? "rounded-lg border border-[var(--warn-line)] bg-[var(--warn-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--warn)]"
      : "border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-2 py-1.5 text-[12px] leading-5 text-[var(--warn)]";
  return (
    <div
      id={id}
      // 刻意**不用** role="status"/aria-live：这是一条常驻指引，不是一次性的状态变化。
      // 放进 live region 会在每次挂载时被读屏重复播报，也会和真正的状态提示（生成中/失败）
      // 抢同一个位置；输入框用 aria-describedby 指向这里，聚焦时自然会读到。
      className={`${base} flex flex-wrap items-center gap-2`}
    >
      <span className="min-w-0 flex-1">{text}</span>
      {canQuickBind && (
        <label className="flex shrink-0 items-center gap-1 text-[11px]">
          <span className="whitespace-nowrap">用本机连接</span>
          <select
            aria-label="选择要绑定的模型连接"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              e.target.value = "";
              onBind?.(id);
            }}
            className="ui-input w-auto"
          >
            <option value="">选择…</option>
            {connections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {onGoSettings && (
        <button
          type="button"
          onClick={onGoSettings}
          className={`shrink-0 rounded-sm border border-[var(--warn-line)] px-2 py-0.5 text-[11px] text-[var(--warn)] hover:bg-[var(--warn-soft)] ${FOCUS_RING_TIGHT}`}
        >
          {canQuickBind ? "管理连接" : "去设置"}
        </button>
      )}
    </div>
  );
}
