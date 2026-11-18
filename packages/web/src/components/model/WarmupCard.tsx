import { useEffect, useRef, useState } from "react";
import {
  WARMUP_LEVELS,
  WARMUP_VENDORS,
  parseTimeList,
  warmupLevel,
  warmupSummary,
  warmupTimes,
} from "../../lib/warmup.js";
import type { WarmupLevel } from "../../lib/warmup.js";

/**
 * 额度窗口预热（d.292）：内核会替我们把「刚重置的那一轮」先开出来，
 * 免得额度从闲置里溜走。这里只改内核设置，不存自己的状态。
 */

export interface WarmupCardProps {
  /** 已读的 `settings list --json`。 */
  values: ReadonlyMap<string, unknown>;
  /** 正在写哪一项，用来禁用与显示忙碌。 */
  busy: boolean;
  onLevel: (levelKey: string, level: WarmupLevel) => void;
  onTimes: (timesKey: string, times: string[]) => void;
}

export function WarmupCard({ values, busy, onLevel, onTimes }: WarmupCardProps) {
  return (
    <div className="ui-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="ui-section-title">额度窗口预热</h2>
        <span className="ui-caption">窗口一重置就替你先开一次，额度不从闲置里溜走</span>
      </div>
      <ul className="mt-3 space-y-2" aria-label="预热设置">
        {WARMUP_VENDORS.map((item) => (
          <VendorRow
            key={item.vendor}
            name={item.name}
            levelKey={item.levelKey}
            timesKey={item.timesKey}
            level={warmupLevel(values, item.levelKey)}
            times={warmupTimes(values, item.timesKey)}
            busy={busy}
            onLevel={onLevel}
            onTimes={onTimes}
          />
        ))}
      </ul>
      <p className="mt-2 ui-caption">{warmupSummary(values)}</p>
    </div>
  );
}

interface VendorRowProps {
  name: string;
  levelKey: string;
  timesKey: string;
  level: WarmupLevel;
  times: string[];
  busy: boolean;
  onLevel: (levelKey: string, level: WarmupLevel) => void;
  onTimes: (timesKey: string, times: string[]) => void;
}

function VendorRow({ name, levelKey, timesKey, level, times, busy, onLevel, onTimes }: VendorRowProps) {
  const [draft, setDraft] = useState(times.join(" "));
  const committed = useRef(times.join(" "));
  const hint = WARMUP_LEVELS.find((item) => item.value === level)?.hint ?? "";

  // 别的地方改了这项（比如另一处设置面板），输入框跟着走。
  useEffect(() => {
    const next = times.join(" ");
    if (next === committed.current) return;
    committed.current = next;
    setDraft(next);
  }, [times]);

  const parsed = parseTimeList(draft);
  const typed = draft.trim();
  const invalid = typed.length > 0 && parsed.length === 0;

  const commit = () => {
    const next = parsed;
    const current = committed.current;
    if (next.join(",") === parseTimeList(current).join(",")) return;
    committed.current = next.join(" ");
    onTimes(timesKey, next);
  };

  return (
    <li className="rounded-xl border border-line bg-subtle px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-16 shrink-0 text-ui-sm font-medium">{name}</span>
        <select
          className="ui-input w-36 min-w-0 flex-1 sm:flex-none"
          aria-label={`${name} 的预热`}
          value={level}
          disabled={busy}
          title={hint}
          onChange={(event) => onLevel(levelKey, event.target.value as WarmupLevel)}
        >
          {WARMUP_LEVELS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <label className="flex w-full items-center gap-2 ui-caption sm:mt-0">
          每天
          <input
            className="ui-input w-28 min-w-0 flex-1 font-mono text-ui-sm sm:w-32 sm:flex-none"
            aria-label={`${name} 每天开 5 小时窗口的时间`}
            placeholder="06:00 15:05"
            spellCheck={false}
            value={draft}
            disabled={busy}
            title="留空就是不开；几个时间用空格或逗号分开"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") setDraft(committed.current);
            }}
          />
          <span className="shrink-0">各开一次</span>
        </label>
      </div>
      {invalid && (
        <p className="mt-1 ui-caption text-danger">时间看不懂：写成 06:00 这样，几个用空格分开</p>
      )}
    </li>
  );
}
