import { Avatar } from "./Avatar.js";
import { agentName, windowName } from "../../lib/magpieQuota.js";
import {
  lineLatestLeft,
  lineResetsAt,
  paceText,
  quotaPace,
  sparkPath,
  type QuotaHistoryRow,
  type QuotaLine,
} from "../../lib/quotaHistory.js";

/**
 * 额度走向（模型页 → 来源 → 额度走向）。
 *
 * 内核把每次读到的「还剩多少」记下来，这里画成一条线，并回答线本身答不出的
 * 那个问题：照现在的速度，会在重置前用完吗。
 *
 * 只有一条线的窗口不画（一个点画不成线），也不替它编趋势；
 * 没有历史时整块不渲染，由调用方判断。
 */
export interface QuotaTrendProps {
  rows: readonly QuotaHistoryRow[];
  now: number;
}

/** 剩余百分比对应的颜色档，与窗口条同一套语义。 */
function leftTone(left: number): { stroke: string; text: string } {
  if (left <= 10) return { stroke: "text-danger", text: "text-danger" };
  if (left <= 25) return { stroke: "text-warn", text: "text-warn" };
  return { stroke: "text-info", text: "text-ink" };
}

function percentText(value: number): string {
  return `${Math.round(value)}%`;
}

function Spark({ line }: { line: QuotaLine }) {
  const left = lineLatestLeft(line) ?? 0;
  const tone = leftTone(left);
  const path = sparkPath(line.points, 100, 24);
  const first = line.points[0];
  const last = line.points[line.points.length - 1];
  const label = `${windowName(line.name)} 的额度走向：从 ${percentText(first?.left ?? left)} 到 ${percentText(last?.left ?? left)}`;
  return (
    <svg
      className={`h-6 w-full ${tone.stroke}`}
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function QuotaTrend({ rows, now }: QuotaTrendProps) {
  return (
    <ul className="mt-3 space-y-2" aria-label="额度走向">
      {rows.map((row) => (
        <li
          key={`${row.provider}-${row.user ?? ""}`}
          className="rounded-xl border border-line bg-subtle px-3 py-2.5"
        >
          <div className="flex items-center gap-2">
            <Avatar name={row.provider} />
            <span className="min-w-0 truncate text-ui-md font-semibold">{agentName(row.provider)}</span>
            {row.user && <span className="min-w-0 truncate ui-caption">{row.user}</span>}
          </div>
          <div className="mt-1 space-y-1.5">
            {row.lines
              .filter((line) => line.points.length >= 2)
              .map((line) => {
                const left = lineLatestLeft(line) ?? 0;
                const tone = leftTone(left);
                return (
                  <div key={line.name} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 ui-caption">{windowName(line.name)}</span>
                    <span className="min-w-0 flex-1">
                      <Spark line={line} />
                    </span>
                    <span className={`shrink-0 ui-numeric text-ui-sm font-medium ${tone.text}`}>
                      剩 {percentText(left)}
                    </span>
                  </div>
                );
              })}
          </div>
          <div className="mt-1.5 space-y-0.5">
            {row.lines
              .filter((line) => line.points.length >= 2)
              .map((line) => {
                const pace = paceText(quotaPace(line, now, lineResetsAt(line)), now);
                if (!pace) return null;
                return (
                  <p key={`${line.name}-pace`} className="ui-caption">
                    {windowName(line.name)}：{pace}
                  </p>
                );
              })}
          </div>
        </li>
      ))}
    </ul>
  );
}
