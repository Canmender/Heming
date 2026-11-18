import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import { WindowBar } from "./WindowBar.js";
import { AUTO_RESET_LEVELS, autoResetLevelText, type AutoResetLevel } from "../../lib/autoReset.js";
import { engineText } from "../../lib/engineText.js";
import type { AccountRow } from "../../lib/magpieCli.js";
import { accountState, agentName, formatReadAt, hasQuota, resetsText } from "../../lib/magpieQuota.js";

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
  /** 改个名字（`accounts alias`）；传空串表示清掉名字，改回账号本身。 */
  onRename: (row: AccountRow, name: string) => void;
  /** 从列表里移除（`accounts forget`）——会二次确认，这里只负责发起。 */
  onForget: (row: AccountRow) => void;
  /** 花掉这个账号持有的一次额度重置（`quota reset`）——会二次确认，这里只负责发起。 */
  onSpendReset?: (row: AccountRow) => void;
  /** 这个账号的「重置谁花」现在停在哪一档（`quota auto-reset`），没读过就是关闭。 */
  autoReset?: AutoResetLevel;
  /** 改「重置谁花」——内核按账号存，所以这里带上这一行。 */
  onAutoReset?: (row: AccountRow, level: AutoResetLevel) => void;
}

/** 状态徽标：和页面里其它徽标同一套语义色（信息=在用，红=读不到/失效）。 */
const STATE_BADGE: Record<ReturnType<typeof accountState>["tone"], string> = {
  info: "bg-info-soft text-info",
  muted: "bg-subtle-3 text-muted",
  danger: "bg-danger-soft text-danger",
};

export function SubscriptionRow({
  row,
  now,
  busy,
  onSwitch,
  onRelogin,
  onRename,
  onForget,
  onSpendReset,
  autoReset = "off",
  onAutoReset,
}: SubscriptionRowProps) {
  const state = accountState(row);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);

  // 进入改名时把光标放在已有名字后面：多半是微调，不是从头输。
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const beginRename = () => {
    committedRef.current = false;
    setDraft(row.alias ?? "");
    setEditing(true);
  };

  // 回车与失焦都会走到这里：任一处先提交，另一处不再重复发命令。
  const commitRename = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    const name = draft.trim();
    if (name !== (row.alias ?? "")) onRename(row, name);
  };

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
            {editing ? (
              <input
                ref={inputRef}
                className="ui-input h-7 min-w-0 max-w-56 text-ui-sm"
                value={draft}
                placeholder="起个名字，比如「工作号」"
                aria-label="账号名字"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEditing(false);
                  }
                }}
                onBlur={commitRename}
              />
            ) : (
              <span className="min-w-0 truncate text-ui-md font-semibold">{row.label}</span>
            )}
            {row.plan && <span className="ui-chip">{row.plan}</span>}
            <span
              className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-ui-xs ${STATE_BADGE[state.tone]}`}
              title={state.detail}
            >
              {state.label}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {meta && <p className="ui-caption">{meta}</p>}
            {row.user && !editing && (
              <span className="flex items-center gap-0.5">
                <button type="button" className="ui-link" disabled={busy} onClick={beginRename}>
                  改名
                </button>
                <button type="button" className="ui-link" disabled={busy} onClick={() => onForget(row)}>
                  移除
                </button>
              </span>
            )}
          </div>
          {hasQuota(row.windows) ? (
            <ul className="mt-2 space-y-1.5">
              {row.windows.map((window, index) => (
                <WindowBar key={`${window.name}-${index}`} window={window} now={now} />
              ))}
            </ul>
          ) : (
            !row.error && <p className="mt-1.5 ui-caption">额度未知，这次没读到</p>
          )}
          {extras.length > 0 && <p className="mt-1.5 ui-caption">{extras.join(" · ")}</p>}
          {row.resets && row.resets.count > 0 && onAutoReset && (
            // 重置放着不用就到期作废：让它「该花的时候自己花」，是这批账号里最实在的一项。
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <span className="ui-caption">重置谁花</span>
                <select
                  className="ui-input w-auto"
                  aria-label={`${row.label} 的重置怎么花`}
                  title="周额度用完、又没有别的账号能接时自己花掉；快过期的也会提前花掉。一周最多一次。"
                  value={autoReset}
                  disabled={busy}
                  onChange={(event) => onAutoReset(row, event.target.value as AutoResetLevel)}
                >
                  {AUTO_RESET_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {autoResetLevelText(level)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {row.lapsed && <p className="mt-1.5 text-ui-sm text-warn">登录已经过期：{engineText(row.lapsed)}</p>}
          {row.error && <p className="mt-1.5 text-ui-sm text-danger">{engineText(row.error)}</p>}
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
          {row.resets && row.resets.count > 0 && onSpendReset && (
            // 窗口用光了、手里又有可重置次数时，这一步比等下一次自然重置快得多。
            <Button
              size="sm" variant="ghost" busy={busy}
              title="把这个账号当前的额度窗口从头开始，用掉一次可重置次数"
              onClick={() => onSpendReset(row)}
            >
              用掉一次重置
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
