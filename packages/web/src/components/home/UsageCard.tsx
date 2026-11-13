import { Fragment, useMemo, useState } from "react";
import {
  useTokenUsageStore,
  monthKeyOf,
  summarizeMonth,
  dailyTotals,
  dayKeyOf,
} from "../../store/tokenUsage.js";
import { useUiStore } from "../../store/ui.js";
import { EmptyState } from "../ui/EmptyState.js";
import { HomeTeamUsage } from "../HomeTeamUsage.js";
import { TokenHeatmap } from "../TokenHeatmap.js";

/**
 * 首页「Token 用量」卡（d.141 从 HomePage 抽出的既有实现，行为未改）。
 *
 * 为什么抽：这张卡自带 4 个页签（个人/团队/按日期）、按日展开态和近 30 日热力图，
 * 占掉首页近 1/4 的 JSX。首页重排首屏/次屏后它属于「次屏的状态数字」之一，
 * 留在 HomePage 里会让「首屏只有动作」这条结构完全看不出来。
 *
 * 数据仍然只从 tokenUsage store 派生（不落盘、不预计算），派生口径与抽出前逐行一致：
 * monthKey / dayRows（只列到今天）/ monthHasRecords / pct / modelRows。
 */
export function UsageCard() {
  const { quota, records } = useTokenUsageStore();
  const setPage = useUiStore((s) => s.setPage);
  const [tab, setTab] = useState<"me" | "team" | "date">("me");
  const [openDay, setOpenDay] = useState<string | null>(null);

  const monthKey = useMemo(() => monthKeyOf(new Date().toISOString()), []);
  const monthSummary = useMemo(() => summarizeMonth(records, monthKey), [records, monthKey]);
  const todayKey = useMemo(() => dayKeyOf(new Date().toISOString()), []);

  /**
   * 按日明细只列到「今天」：本月还没到的日期不是「0 调用」，
   * 把它们铺成 0 会让账本看起来像出错（审计 P1-6）。
   */
  const dayRows = useMemo(
    () => dailyTotals(records, monthKey).filter((row) => row.day <= todayKey),
    [records, monthKey, todayKey],
  );
  const monthHasRecords = monthSummary.total > 0 || monthSummary.missing > 0;
  const pct = quota > 0 ? Math.min(100, Math.round((monthSummary.total / quota) * 100)) : 0;
  const modelRows = Object.entries(monthSummary.byModel).sort((a, b) => b[1] - a[1]);

  return (
    // 一张整宽卡片：抽出前它靠 `col-span-4` 挤在四张统计卡的网格里，窄窗折成 2 列时
    // 还要再写 `col-span-2`，本质是「网格里的例外」。现在它自己就是一行。
    <section aria-label="Token 用量" className="ui-card p-3">
      {!monthHasRecords ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-xs font-bold text-muted">Token 用量 · {monthKey}</span>
          {/* 分隔符写在文本节点里：两个 span 之间只有 gap，读屏会把「2026-11」和
              「本月还没有…」拼成「2026-11本月还没有…」。 */}
          <span className="text-ui-xs text-muted">
            {" · "}本月还没有调用记录；接入模型并开始对话后自动统计。
          </span>
          <button
            type="button"
            className="ui-link ml-auto"
            onClick={() => setPage("model")}
          >
            去配置模型
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center">
            <div className="text-ui-xs font-bold text-muted">Token 用量 · {monthKey}</div>
            <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-line bg-[var(--subtle)]">
              {(
                [
                  ["me", "个人"],
                  ["team", "团队"],
                  ["date", "按日期"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key);
                    if (key !== "date") setOpenDay(null);
                  }}
                  className={`border-l border-line-soft px-2.5 py-1 text-ui-xs font-semibold first:border-l-0 ${
                    tab === key ? "bg-ink text-white" : "text-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {tab === "me" ? (
            <div className="mt-2 flex items-center gap-5">
              <div>
                <div className="ui-numeric text-num-sm font-semibold">
                  {(monthSummary.total / 1000).toFixed(1)}
                  <small className="ml-1 text-ui-xs text-muted">
                    / {(quota / 1_000_000).toFixed(1)}M
                  </small>
                </div>
                <div className="text-ui-xs text-muted">本月已用 {pct}%</div>
                <div className="mt-1 h-1 w-[140px] overflow-hidden rounded-sm bg-[var(--subtle-4)]">
                  <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                </div>
                {/* 未上报单独提示（灰字，不抢主数字）：null 不是 0，不能被总量悄悄吞掉 */}
                {monthSummary.missing > 0 && (
                  <div className="mt-1 text-ui-xs text-muted">{monthSummary.missing} 轮未上报</div>
                )}
              </div>
              <div className="flex-1 border-l border-line-soft pl-4">
                {modelRows.length === 0 ? (
                  <EmptyState
                    compact
                    className="px-0 py-2"
                    title="还没有调用记录"
                    desc="接入模型、开始对话后自动累计。"
                  />
                ) : (
                  modelRows.map(([model, n]) => (
                    <div key={model} className="flex justify-between py-0.5 text-ui-xs">
                      <span>{model}</span>
                      <span>
                        <b>{n}</b>{" "}
                        <span className="text-muted">
                          · {Math.round((n / monthSummary.total) * 100)}%
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : tab === "team" ? (
            <HomeTeamUsage />
          ) : !monthHasRecords ? (
            <div className="mt-2">
              <EmptyState
                compact
                className="px-0 py-2"
                title="本月还没有调用记录"
                desc="接入模型并开始对话后，这里按天列出用量（只列到今天）。"
              />
            </div>
          ) : (
            <div className="mt-2 max-h-[220px] overflow-y-auto">
              <table className="w-full text-left text-ui-xs">
                <thead>
                  <tr className="border-b border-line-soft text-muted">
                    <th className="py-1 font-semibold">日期</th>
                    <th className="py-1 font-semibold">个人</th>
                    <th className="py-1 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {dayRows.map((row) => (
                    <Fragment key={row.day}>
                      <tr className="border-b border-line-soft">
                        <td className="py-1">{row.day}</td>
                        <td className="py-1">{row.total}</td>
                        <td className="py-1">
                          <button
                            type="button"
                            className="text-muted underline-offset-2 hover:underline"
                            onClick={() => setOpenDay(openDay === row.day ? null : row.day)}
                          >
                            {openDay === row.day ? "收起" : "查看"}
                          </button>
                        </td>
                      </tr>
                      {openDay === row.day ? (
                        <tr className="bg-[var(--subtle)]">
                          <td colSpan={3} className="py-1.5 pl-4">
                            {Object.keys(row.byModel).length === 0 ? (
                              <span className="text-muted">当天无调用记录</span>
                            ) : (
                              Object.entries(row.byModel).map(([model, n]) => (
                                <div key={model} className="flex justify-between py-0.5 pr-4">
                                  <span>{model}</span>
                                  <b>{n}</b>
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 2.5 近 30 日用量热力图：并进「Token 用量」卡。
              单独一张卡时它只是一条细带（标题 + 30 个方块），在宽屏上占了一整行却几乎没有内容；
              并进来后「本月汇总 / 按日明细 / 近 30 日」在同一张卡里读，也少一个卡片框。 */}
          <div className="mt-3 border-t border-line-soft pt-2">
            <div className="mb-1.5 flex items-center">
              <div className="text-ui-xs font-bold text-muted">近 30 日用量</div>
              <div className="ml-auto flex items-center gap-1 text-ui-xs text-muted">
                少
                {["var(--heat-0)", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"].map((c) => (
                  <span key={c} style={{ backgroundColor: c }} className="h-2.5 w-2.5 rounded-sm" />
                ))}
                多
              </div>
            </div>
            <TokenHeatmap />
          </div>
        </>
      )}
    </section>
  );
}