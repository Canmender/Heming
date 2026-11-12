import { useEffect } from "react";
import type { JSX } from "react";
import { useUiStore, type PageId } from "../../store/ui.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";
import { PluginPageIcon } from "./PluginPageIcon.js";
import {
  pluginHomeCardsAvailable,
  refreshPluginHomeCards,
  subscribePluginHomeCards,
  usePluginHomeCardsStore,
  type PluginHomeCard,
} from "../../lib/plugins/homeCards.js";

/**
 * 首页 · 插件卡片区块（d.125）。
 *
 * 卡片数据来自插件清单与宿主桥（内置模块卡已随 modules 体系下线删除）。
 * 为什么整块做成「无桥即 null」：浏览器/旧版桌面端没有 `window.__heming_plugins`，
 * 这时既不能显示空卡也不能显示假入口，直接不渲染。
 */
export function PluginHomeCards(): JSX.Element | null {
  const cards = usePluginHomeCardsStore((state) => state.cards);
  const setPage = useUiStore((state) => state.setPage);
  const available = pluginHomeCardsAvailable();

  useEffect(() => {
    if (!available) return;
    void refreshPluginHomeCards();
    return subscribePluginHomeCards();
  }, [available]);

  if (!available || cards.length === 0) return null;

  return (
    <section aria-label="插件首页卡" className="grid grid-cols-2 gap-3 max-[1199px]:grid-cols-1">
      {cards.map((card) => (
        <PluginHomeCardTile key={`${card.pluginId}:${card.id}`} card={card} onOpen={setPage} />
      ))}
    </section>
  );
}

function PluginHomeCardTile({
  card,
  onOpen,
}: {
  card: PluginHomeCard;
  onOpen: (page: PageId) => void;
}) {
  // page 已在 store 层按「导航页 / 内置插件页 / 插件页」校验过，这里只剩类型收窄。
  const open = () => onOpen(card.page as PageId);
  return (
    <button
      type="button"
      onClick={open}
      className={`ui-card flex flex-col gap-1.5 p-3 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING}`}
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
      {card.detail ? <div className="ui-micro text-muted">{card.detail}</div> : null}
      {card.pluginName ? <div className="ui-micro text-muted">{card.pluginName}</div> : null}
    </button>
  );
}
