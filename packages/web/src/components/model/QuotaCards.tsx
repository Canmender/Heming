import { WindowBar } from "./WindowBar.js";
import { engineText } from "../../lib/engineText.js";
import {
  cardSummary,
  quotaKindLabel,
  type QuotaCard,
} from "../../lib/magpieQuotaCards.js";
import { formatReadAt, resetsText, windowLeftPercent, windowTone } from "../../lib/magpieQuota.js";

/**
 * 订阅以外的额度（模型页 → 来源 → 其余来源）：按量付费的 Key、套餐、钱包余额。
 *
 * 这些数字原先在页面上根本看不到：`accounts --json` 只讲订阅账号，用户买的 Key
 * 花到哪儿去了、还剩多少，得开终端敲命令才知道。这里按来源一行一个，窗口条
 * 与订阅账号共用同一个 `WindowBar`，所以同一种额度在两处长得一样。
 */

export interface QuotaCardsProps {
  cards: readonly QuotaCard[];
  now: number;
}

/** 这张卡最紧的那个窗口决定色调：余额/套餐花完时整行先红起来。 */
function cardTone(card: QuotaCard): "ok" | "warn" | "danger" {
  if (card.error) return "danger";
  if (card.windows.length === 0) return "ok";
  const tightest = card.windows.reduce((worst, window) =>
    windowLeftPercent(window) < windowLeftPercent(worst) ? window : worst,
  );
  return windowTone(tightest);
}

const DOT_TONE: Record<"ok" | "warn" | "danger", string> = {
  ok: "bg-muted",
  warn: "bg-warn",
  danger: "bg-danger",
};

export function QuotaCards({ cards, now }: QuotaCardsProps) {
  if (cards.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2" aria-label="其余来源的额度">
      {cards.map((card, index) => {
        const summary = cardSummary(card, now);
        const readLine = formatReadAt(card.readAt, card.asOf, now);
        const meta = [card.plan, card.alias, readLine].filter(Boolean).join(" · ");
        const resets = resetsText(card.resets, now);
        return (
          <li
            key={`${card.provider}-${card.kind}-${index}`}
            className="rounded-xl border border-line bg-subtle px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[cardTone(card)]}`} />
              <span className="min-w-0 truncate text-ui-md font-semibold">{card.name}</span>
              <span className="ui-chip shrink-0">{quotaKindLabel(card.kind)}</span>
              {summary && card.windows.length === 0 && (
                <span className="ml-auto shrink-0 ui-numeric text-ui-sm font-medium">{summary}</span>
              )}
            </div>
            {meta && <p className="mt-0.5 ui-caption">{meta}</p>}
            {card.windows.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {card.windows.map((window, windowIndex) => (
                  <WindowBar key={`${window.name}-${windowIndex}`} window={window} now={now} />
                ))}
              </ul>
            )}
            {card.balanceSplit.length > 0 && (
              <p className="mt-1.5 ui-caption">{card.balanceSplit.map((part) => part.text).join(" · ")}</p>
            )}
            {card.sharedBalance && <p className="mt-1 ui-caption">几个 Key 共用：{card.sharedBalance}</p>}
            {resets && <p className="mt-1 ui-caption">{resets}</p>}
            {card.until && <p className="mt-1 ui-caption">到期：{card.until}</p>}
            {card.error && <p className="mt-1.5 text-ui-sm text-danger">{engineText(card.error)}</p>}
          </li>
        );
      })}
    </ul>
  );
}
