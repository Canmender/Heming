import { Button } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import type { AccountRow } from "../../lib/magpieCli.js";
import {
  accountState,
  agentName,
  formatReadAt,
  hasQuota,
  resetsText,
  windowDetailText,
  windowLeftText,
  windowName,
  windowPercent,
  windowTone,
  type QuotaTone,
  type QuotaWindow,
} from "../../lib/magpieQuota.js";

/**
 * 订阅账号的一行（模型页 → 来源 → 订阅账号）。
 *
 * 一个账号可能同时挂着好几个额度窗口（Claude 的 5 小时 + 每周、Codex 的周额度…），
 * 所以这一行的主体是窗口，不是账号：账号名 + 档位 + 状态在上，窗口条在下，
 * 余额/可重置次数/失效原因继续往下排。切换与重新登录都交给调用方（它们要确认）。
 *
 * 时间一律由调用方传 `now`：重置倒计时与读数时间随时变，组件不做取时动作，
 * 这样单测不必跟真实时钟赛跑。
 */

export interface SubscriptionRowProps {
  row: AccountRow;
  now: number;
  /** 这个账号上正有一个动作在跑（切换/重新登录），按钮一起忙。 */
  busy: boolean;
  onSwitch: (row: AccountRow) => void;
  onRelogin: (row: AccountRow) => void;
}

/** 状态徽标：和页面里其它徽标同一套语义色（信息=在用，红=读不到/失效）。 */
const STATE_BADGE: Record<ReturnType<typeof accountState>["tone"], string> = {
  info: "bg-info-soft text-info",
  muted: "bg-subtle-3 text-muted",
  danger: "bg-danger-soft text-danger",
};

/** 进度条与结论文字：剩余越少越红，正常时用墨色（结论比下面那行小字重要一档）。 */
const BAR_TONE: Record<QuotaTone, string> = {
  ok: "bg-muted",
  warn: "bg-warn",
  danger: "bg-danger",
};
const TEXT_TONE: Record<QuotaTone, string> = {
  ok: "text-ink",
  warn: "text-warn",
  danger: "text-danger",
};

export function SubscriptionRow({ row, now, busy, onSwitch, onRelogin }: SubscriptionRowProps) {
  const state = accountState(row);
  const readLine = formatReadAt(row.readAt, row.asOf, now);
  const meta = [agentName(row.agent), row.seat ? `席位 ${row.seat}` : "", readLine]
    .filter(Boolean)
    .join(" · ");
  const extras = [resetsText(row.resets, now), row.balance ? `余额 ${row.balance}` : ""].filter(
    Boolean,
  );
  const canSwitch = !row.active && Boolean(row.user);
  return (
    <li className="rounded-xl border border-line bg-subtle px-3 py-2.5">
      <div className="flex items-start gap-3">
        <Avatar name={row.agent} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-ui-md font-semibold">{row.label}</span>
            {row.plan && <span className="ui-chip">{row.plan}</span>}
            <span
              className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-ui-xs ${STATE_BADGE[state.tone]}`}
              title={state.detail}
            >
              {state.label}
            </span>
          </div>
          {meta && <p className="mt-0.5 ui-caption">{meta}</p>}
          {hasQuota(row.windows) ? (
            <ul className="mt-2 space-y-1.5">
              {row.windows.map((window, index) => (
                <WindowBar key={`${window.name}-${index}`} window={window} now={now} />
              ))}
            </ul>
          ) : (
            !row.error && <p className="mt-1.5 ui-caption">额度未知，内核这次没读到</p>
          )}
          {extras.length > 0 && <p className="mt-1.5 ui-caption">{extras.join(" · ")}</p>}
          {row.lapsed && <p className="mt-1.5 text-ui-sm text-warn">登录已经过期：{row.lapsed}</p>}
          {row.error && <p className="mt-1.5 text-ui-sm text-danger">{row.error}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {row.lapsed && (
            <Button size="sm" variant="ghost" busy={busy} onClick={() => onRelogin(row)}>
              重新登录
            </Button>
          )}
          {canSwitch && (
            <Button size="sm" variant="ghost" busy={busy} onClick={() => onSwitch(row)}>
              切到这个
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function WindowBar({ window, now }: { window: QuotaWindow; now: number }) {
  const percent = windowPercent(window);
  const left = windowLeftText(window);
  const tone = windowTone(window);
  const detail = windowDetailText(window, now);
  const name = windowName(window.name);
  return (
    // 小字（厂商原话 + 重置倒计时）另起一行：卡片窄的时候单行放不下，
    // 挤在一起会把进度条压成一条缝，倒计时还会被截掉。
    <li>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 ui-caption">{name}</span>
        {window.unlimited || window.text ? (
          <span className="min-w-0 flex-1" />
        ) : (
          <div
            role="progressbar"
            aria-label={`${name} 用量`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${name} 已用 ${percent}%，${left}`}
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle-3"
          >
            <div className={`h-full rounded-full ${BAR_TONE[tone]}`} style={{ width: `${percent}%` }} />
          </div>
        )}
        <span className={`shrink-0 ui-numeric text-ui-sm font-medium ${TEXT_TONE[tone]}`}>{left}</span>
      </div>
      {detail && <p className="pl-16 ui-caption">{detail}</p>}
    </li>
  );
}
