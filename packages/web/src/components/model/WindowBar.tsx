import {
  windowDetailText,
  windowLeftText,
  windowName,
  windowPercent,
  windowTone,
  type QuotaTone,
  type QuotaWindow,
} from "../../lib/magpieQuota.js";

/**
 * 一份额度的窗口条（模型页 → 来源：订阅账号行、套餐/Key 额度卡共用）。
 *
 * 一行一个窗口：名字、进度条、结论（剩多少），第二行是厂商原话与重置倒计时。
 * 小字另起一行是量出来的取舍——卡片窄到 380px 时单行放不下，挤在一起会把进度条
 * 压成一条缝、倒计时被截掉。
 *
 * 时间由调用方传 `now`：倒计时随时变，组件不取时，单测就不用跟真实时钟赛跑。
 */

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

export interface WindowBarProps {
  window: QuotaWindow;
  now: number;
}

export function WindowBar({ window, now }: WindowBarProps) {
  const percent = windowPercent(window);
  const left = windowLeftText(window);
  const tone = windowTone(window);
  const detail = windowDetailText(window, now);
  const name = windowName(window.name);
  return (
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
