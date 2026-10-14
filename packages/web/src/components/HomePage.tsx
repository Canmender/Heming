import { Fragment, useMemo, useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import {
  useTokenUsageStore,
  monthKeyOf,
  summarizeMonth,
  dailyTotals,
} from "../store/tokenUsage.js";

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
      <div className="text-[11px] font-bold text-[#777]">{title}</div>
      <div className="mt-0.5 text-[20px] font-extrabold">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const conversations = useChatStore((s) => s.conversations);
  const { quota, records } = useTokenUsageStore();
  const [tab, setTab] = useState<"me" | "team" | "date">("me");
  const [openDay, setOpenDay] = useState<string | null>(null);

  const monthKey = useMemo(() => monthKeyOf(new Date().toISOString()), []);
  const monthSummary = useMemo(() => summarizeMonth(records, monthKey), [records, monthKey]);
  const dayRows = useMemo(() => dailyTotals(records, monthKey), [records, monthKey]);

  const today = useMemo(() => {
    const d = new Date();
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${week}`;
  }, []);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

  const pct = quota > 0 ? Math.min(100, Math.round((monthSummary.total / quota) * 100)) : 0;
  const modelRows = Object.entries(monthSummary.byModel).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-6">
      <h1 className="text-[17px] font-extrabold">
        {greeting}，{user?.displayName ?? ""}
        <span className="ml-2 text-[12px] font-normal text-muted">{today}</span>
      </h1>

      <div className="grid grid-cols-4 gap-2.5">
        <StatCard title="会话总数" value={String(conversations.length)} sub="直聊" />
        <StatCard title="我的智能体" value="0" sub="M3 开放创建" />
        <StatCard title="知识库文档" value="0" sub="记忆区二期开放" />
        <div className="col-span-4 rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
          <div className="flex items-center">
            <div className="text-[11px] font-bold text-[#777]">Token 用量 · {monthKey}</div>
            <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-[#ddd] bg-[#fafafa]">
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
                  className={`border-l border-[#eee] px-2.5 py-1 text-[11px] font-semibold first:border-l-0 ${
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
                <div className="text-[18px] font-extrabold">
                  {(monthSummary.total / 1000).toFixed(1)}
                  <small className="ml-1 text-[10px] text-muted">
                    / {(quota / 1_000_000).toFixed(1)}M
                  </small>
                </div>
                <div className="text-[10px] text-muted">本月个人已用 {pct}%（读取时按日重算）</div>
                <div className="mt-1 h-1 w-[140px] overflow-hidden rounded bg-[#f0f0f0]">
                  <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="flex-1 border-l border-[#f1f1f1] pl-4">
                {modelRows.length === 0 ? (
                  <div className="text-[11px] text-muted">暂无调用记录（M3 接入模型后自动累计）</div>
                ) : (
                  modelRows.map(([model, n]) => (
                    <div key={model} className="flex justify-between py-0.5 text-[11px]">
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
            <div className="mt-2 text-[11px] text-muted">团队用量排行二期开放（需服务端汇总）</div>
          ) : (
            <div className="mt-2 max-h-[220px] overflow-y-auto">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="border-b border-[#ececec] text-muted">
                    <th className="py-1 font-semibold">日期</th>
                    <th className="py-1 font-semibold">个人</th>
                    <th className="py-1 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {dayRows.map((row) => (
                    <Fragment key={row.day}>
                      <tr className="border-b border-[#f4f4f4]">
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
                        <tr className="bg-[#fafafa]">
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
        </div>
      </div>

      <div className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
        <div className="mb-1 text-[12px] font-bold text-[#777]">动态</div>
        <div className="border-b border-[#f1f1f1] py-1.5 text-[12px]">
          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-ink align-middle" />
          欢迎使用和鸣 —— 从工作区添加好友开始
        </div>
        <div className="py-1.5 text-[12px] text-muted">智能体动态将在 M3 后出现</div>
      </div>
    </div>
  );
}
