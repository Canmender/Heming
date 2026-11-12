import { useEffect } from "react";
import type { JSX } from "react";
import { useUiStore, type PageId } from "../../store/ui.js";
import { FOCUS_RING, FOCUS_RING_TIGHT } from "../../lib/a11y/focus.js";
import { PluginPageIcon } from "./PluginPageIcon.js";
import {
  pluginHomeCardsAvailable,
  refreshPluginHomeCards,
  subscribePluginHomeCards,
  usePluginHomeCardsStore,
  type PluginHomeCard,
  type PluginHomeCardAction,
} from "../../lib/plugins/homeCards.js";

/**
 * 首页 · 插件卡片区块（d.125，d.139 扩展 items/actions）。
 *
 * 卡片数据来自插件清单与宿主桥（内置模块卡已随 modules 体系下线删除）。
 * 为什么整块做成「无桥即 null」：浏览器/旧版桌面端没有 `window.__heming_plugins`，
 * 这时既不能显示空卡也不能显示假入口，直接不渲染。
 */
export function PluginHomeCards(): JSX.Element | null {
  const cards = usePluginHomeCardsStore((state) => state.cards);
  const setPage = useUiStore((state) => state.setPage);
  const setPluginPageIntent = useUiStore((state) => state.setPluginPageIntent);
  const available = pluginHomeCardsAvailable();

  useEffect(() => {
    if (!available) return;
    void refreshPluginHomeCards();
    return subscribePluginHomeCards();
  }, [available]);

  /**
   * 快捷入口：**先导航、再投递意图**。
   *
   * 顺序不能反：`setPage` 按「切页即清跨页瞬态」的口径会清掉 `pluginPageIntent`，
   * 先设意图再导航等于刚投就被自己抹掉（插件页挂载时便拿不到）。
   */
  const runAction = (card: PluginHomeCard, action: PluginHomeCardAction): void => {
    setPage(card.page as PageId);
    setPluginPageIntent(card.pluginId, action.intent);
  };

  if (!available || cards.length === 0) return null;

  return (
    <section aria-label="插件首页卡" className="grid grid-cols-2 gap-3 max-[1199px]:grid-cols-1">
      {cards.map((card) => (
        <PluginHomeCardTile
          key={`${card.pluginId}:${card.id}`}
          card={card}
          onOpen={setPage}
          onAction={runAction}
        />
      ))}
    </section>
  );
}

function PluginHomeCardTile({
  card,
  onOpen,
  onAction,
}: {
  card: PluginHomeCard;
  onOpen: (page: PageId) => void;
  onAction: (card: PluginHomeCard, action: PluginHomeCardAction) => void;
}) {
  // page 已在 store 层按「导航页 / 内置插件页 / 插件页」校验过，这里只剩类型收窄。
  const open = () => onOpen(card.page as PageId);
  const hasActions = card.actions.length > 0;
  return (
    // 外层必须是 div 而不是 button：action 本身就是按钮，button 嵌 button 既非法
    // 也会让内层点击冒泡成「打开卡片」。所以拆成「卡片容器 + 主区 button + 按钮行」。
    <div className="ui-card flex flex-col">
      <button
        type="button"
        onClick={open}
        className={`flex flex-col gap-1.5 p-3 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING} ${
          hasActions ? "rounded-t-xl" : "rounded-xl"
        }`}
        aria-label={`打开 ${card.title}`}
      >
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-muted">
          <PluginPageIcon icon={card.icon} size={14} />
          <span className="truncate">{card.title}</span>
          {card.badge ? (
            <span className="ml-auto shrink-0 rounded-full bg-[var(--subtle)] px-1.5 py-0.5 text-[10px] font-semibold">
              {card.badge}
            </span>
          ) : null}
        </div>
        {card.text ? <div className="text-[15px] font-semibold">{card.text}</div> : null}
        {card.summary ? <div className="ui-caption line-clamp-2">{card.summary}</div> : null}
        {card.items.length > 0 ? (
          // 纯展示文本：不省行、不做点击，最多 3 条（归一化时已截断）。
          <div className="flex flex-col gap-0.5">
            {card.items.map((item, index) => (
              <div key={`${index}:${item}`} className="ui-micro text-muted">
                {item}
              </div>
            ))}
          </div>
        ) : null}
        {card.detail ? <div className="ui-micro text-muted">{card.detail}</div> : null}
        {card.pluginName ? <div className="ui-micro text-muted">{card.pluginName}</div> : null}
      </button>
      {hasActions ? (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
          {card.actions.map((action) => (
            <button
              key={`${action.intent}:${action.label}`}
              type="button"
              onClick={() => onAction(card, action)}
              // 沿用既有 ui-chip（h-5 / 11px / subtle 底）：小按钮行，不引入新配色。
              className={`ui-chip transition-colors hover:bg-[var(--subtle-2)] hover:text-ink ${FOCUS_RING_TIGHT}`}
              aria-label={`${action.label}：${card.title}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
