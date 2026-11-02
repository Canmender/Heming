import { Fragment, useEffect, useMemo, useState } from "react";
import type { TeamActivity, TeamMember } from "@heming/shared";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import {
  useTokenUsageStore,
  monthKeyOf,
  summarizeMonth,
  dailyTotals,
  dayKeyOf,
} from "../store/tokenUsage.js";
import { fetchTeam, fetchTeamActivities, resolveUrl } from "../lib/api.js";
import { Avatar } from "./Avatar.js";
import { InfohubHomeCard } from "./InfohubHomeCard.js";
import { StaffHomeCard } from "./StaffHomeCard.js";
import { TokenHeatmap } from "./TokenHeatmap.js";
import { TeamIcon } from "./icons.js";

/** 构建时注入的版本号（vite define __APP_VERSION__，file:// 桌面端无法 fetch package.json）。 */
declare const __APP_VERSION__: string;

/** 底部通栏「最新资讯」：静态产品介绍常量（非虚构统计数据）。 */
const NEWS: { source: string; title: string; summary: string; date: string }[] = [
  {
    source: "官方",
    title: "和鸣团队系统上线：告别 IM，聚焦协作动向",
    summary:
      "本版本移除人类私聊/群聊与语音通话，保留通讯录并升级为真实成员名册；成员的任务与日程摘要会汇总到「团队」页，智能体的工作留在「智能体」页。",
    date: "2026-11-02",
  },
  {
    source: "教程",
    title: "怎么让团队看到你的动向",
    summary:
      "团队页顶部可分别开启任务、日程共享；只上报摘要（标题/状态/时间），对话正文、提示词与智能体轨迹不会离开本机。",
    date: "2026-11-02",
  },
  {
    source: "技巧",
    title: "用共享目录投递附件给智能体",
    summary:
      "右栏「上传」把文件放进共享库；打开智能体对话后点文件行的「绑定」，附件会随下一轮消息发给智能体。",
    date: "2026-11-02",
  },
];

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
      <div className="text-[11px] font-bold text-[#777]">{title}</div>
      <div className="mt-0.5 text-[20px] font-extrabold">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const { loadWorkspace, agentsRoster, loadAgentsRoster } = useChatStore();
  const setPage = useUiStore((s) => s.setPage);
  const { quota, records } = useTokenUsageStore();
  const [tab, setTab] = useState<"me" | "team" | "date">("me");
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"检测中" | "正常" | "失败">("检测中");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const [teamReady, setTeamReady] = useState(false);
  const [teamError, setTeamError] = useState("");

  // 真实数据优先：挂载时加载工作区数据、云端健康探测与智能体名册
  useEffect(() => {
    void loadWorkspace().catch((err) => console.warn("工作区数据加载失败", err));
    void loadAgentsRoster().catch(() => {});
  }, [loadWorkspace, loadAgentsRoster]);

  const loadTeam = () => {
    void Promise.all([fetchTeam(), fetchTeamActivities({ limit: 100 })])
      .then(([roster, feed]) => {
        setMembers(roster.members);
        setOnlineCount(roster.onlineCount);
        setActivities(feed.activities);
        setTeamError("");
        setTeamReady(true);
      })
      .catch((err) => {
        setTeamError(err instanceof Error && err.message ? err.message : "网络异常");
        setTeamReady(true);
      });
  };

  useEffect(() => {
    loadTeam();
    // 首页停留期间不轮询：动向是「看一眼」的信息，切回首页/点重试时刷新即可。
    const onFocus = () => loadTeam();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(resolveUrl("/api/health"))
      .then((r) => {
        if (alive) setCloud(r.ok ? "正常" : "失败");
      })
      .catch(() => {
        if (alive) setCloud("失败");
      });
    return () => {
      alive = false;
    };
  }, []);

  const monthKey = useMemo(() => monthKeyOf(new Date().toISOString()), []);
  const monthSummary = useMemo(() => summarizeMonth(records, monthKey), [records, monthKey]);
  const dayRows = useMemo(() => dailyTotals(records, monthKey), [records, monthKey]);

  const { today, todayKey } = useMemo(() => {
    const d = new Date();
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return {
      today: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")} ${week}`,
      todayKey: dayKeyOf(d.toISOString()),
    };
  }, []);
  // 今日用量：已上报的数字求和；未上报的单独计数（null 不是 0，不能混进求和）
  const todayUsage = useMemo(() => {
    let total = 0;
    let reported = 0;
    let missing = 0;
    for (const r of records) {
      if (dayKeyOf(r.at) !== todayKey) continue;
      if (typeof r.tokens === "number") {
        total += r.tokens;
        reported++;
      } else {
        missing++;
      }
    }
    return { total, reported, missing };
  }, [records, todayKey]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

  const pct = quota > 0 ? Math.min(100, Math.round((monthSummary.total / quota) * 100)) : 0;
  const modelRows = Object.entries(monthSummary.byModel).sort((a, b) => b[1] - a[1]);

  /** 团队动向只收真实成员的任务与日程；智能体侧旧数据不在首页露出。 */
  const humanActivities = useMemo(
    () => activities.filter((a) => a.kind === "task" || a.kind === "agenda"),
    [activities],
  );

  /** 今日动向条数（只统计最近 100 条；首页是概览，不为此转全量分组）。 */
  const todayActivities = useMemo(() => {
    const now = new Date();
    return humanActivities.filter((a) => {
      const d = new Date(a.occurredAt);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    }).length;
  }, [humanActivities]);
  const recentActivities = humanActivities.slice(0, 3);
  const onlineMembers = members.filter((m) => m.online).slice(0, 5);
  const displayAgents = agentsRoster.slice(0, 3);
  const KIND_LABEL: Record<TeamActivity["kind"], string> = {
    task: "任务",
    agent: "AI",
    staff: "幕僚",
    agenda: "日程",
    join: "加入",
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-6">
      {/* 1. 问候行：问候 + 日期 + 两个小徽标 */}
      <div className="flex items-start gap-3">
        <div>
          <h1 className="text-[17px] font-extrabold">
            {greeting}，{user?.displayName ?? ""}
            <span className="ml-2 text-[12px] font-normal text-muted">{today}</span>
          </h1>
          <p className="mt-0.5 text-[12px] text-muted">
            全站一个团队 —— 在「团队」页查看真实成员与大家的任务、日程摘要
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 pt-1">
          <span className="rounded-md border border-line bg-[#fafafa] px-2 py-0.5 text-[11px] text-muted">
            版本 {__APP_VERSION__}
          </span>
          <span className="rounded-md border border-line bg-[#fafafa] px-2 py-0.5 text-[11px] text-muted">
            {/* 有数字优先；今天只有未上报 → 明说未上报，别用「0」冒充真实用量 */}
            {todayUsage.reported > 0
              ? `今日已用 ${todayUsage.total}`
              : todayUsage.missing > 0
                ? "今日用量未上报"
                : "今日已用 0"}
          </span>
        </div>
      </div>

      {/* 2. 四张统计卡（真实数据） */}
      <div className="grid grid-cols-4 gap-2.5">
        <StatCard title="团队成员" value={String(members.length)} sub="全站注册用户" />
        <StatCard title="在线成员" value={String(onlineCount)} sub="约 20 秒刷新" />
        <StatCard title="我的智能体" value={String(agentsRoster.length)} sub="本机运行 · 含系统预设" />
        <StatCard title="今日动向" value={String(todayActivities)} sub="最近 100 条内" />
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
                <div className="mt-1 h-1 w-[140px] overflow-hidden rounded-sm bg-[#f0f0f0]">
                  <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                </div>
                {/* 未上报单独提示（灰字，不抢主数字）：null 不是 0，不能被总量悄悄吞掉 */}
                {monthSummary.missing > 0 && (
                  <div className="mt-1 text-[10px] text-muted">{monthSummary.missing} 轮未上报</div>
                )}
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

      {/* 2.5 近 30 日用量热力图 */}
      <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
        <div className="mb-1.5 flex items-center">
          <div className="text-[12px] font-bold text-[#777]">近 30 日用量</div>
          <div className="ml-auto flex items-center gap-1 text-[10px] text-muted">
            少
            {["#f1f4f7", "#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"].map((c) => (
              <span key={c} style={{ backgroundColor: c }} className="h-2.5 w-2.5 rounded-[2px]" />
            ))}
            多
          </div>
        </div>
        <TokenHeatmap />
      </section>

      {/* 2.6 本机归档：日程摘要与归档规模（仅桌面端渲染） */}
      <InfohubHomeCard />

      {/* 2.7 幕僚：最近一份主动简报（d.48） */}
      <StaffHomeCard />

      {/* 3/4/5/6. 两栏：左团队动向；右智能体动态 + 在线成员 + 系统状态 */}
      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
        <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#777]">
              <TeamIcon width={14} height={14} />
              团队动向
            </div>
            <button
              type="button"
              className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted hover:bg-[#f3f3f3] hover:text-ink"
              onClick={() => setPage("team")}
            >
              进入团队
            </button>
          </div>
          {humanActivities.length === 0 ? (
            !teamReady ? (
              <div role="status" aria-label="正在加载" className="flex flex-col gap-2 py-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-7 animate-pulse rounded-lg bg-[#f4f4f4]" />
                ))}
              </div>
            ) : teamError ? (
              <div className="flex items-center justify-between gap-2 py-1.5 text-[12px]">
                <span className="min-w-0 truncate text-[#b42318]">加载失败：{teamError}</span>
                <button
                  type="button"
                  onClick={loadTeam}
                  className="shrink-0 rounded-md border border-[#e6e6e6] px-2 py-0.5 text-[11px] hover:bg-[#f7f7f7]"
                >
                  重试
                </button>
              </div>
            ) : (
              <div className="py-3 text-[12px] leading-6 text-muted">
                还没有团队动向。成员在「团队」页开启任务 / 日程共享后，
                这里会出现摘要；对话正文、智能体轨迹不会上传。
              </div>
            )
          ) : (
            recentActivities.map((a) => {
              const actor = members.find((m) => m.user.id === a.actorId);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setPage("team")}
                  className="flex w-full items-start gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors duration-150 hover:bg-[#f7f7f7]"
                >
                  <Avatar
                    user={{
                      displayName: actor?.user.displayName ?? "成员",
                      avatar: actor?.user.avatar,
                    }}
                    size={28}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                        {KIND_LABEL[a.kind]}
                      </span>
                      <span className="truncate text-[13px] font-medium">{a.title}</span>
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {actor?.user.displayName ?? "成员"}
                      {a.detail ? ` · ${a.detail}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted">{fmtTime(a.occurredAt)}</span>
                </button>
              );
            })
          )}
        </section>

        <div className="flex flex-col gap-3">
          {/* 4. 智能体动态 */}
          <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
            <div className="mb-1.5 text-[12px] font-bold text-[#777]">智能体动态</div>
            {displayAgents.length === 0 ? (
              <div className="py-1.5 text-[12px] text-muted">暂无智能体，可在智能体页创建</div>
            ) : (
              displayAgents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-1">
                  <Avatar user={{ displayName: a.name, avatar: a.avatar ?? undefined }} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">{a.name}</span>
                    {a.description && (
                      <span className="block truncate text-[10px] text-muted">{a.description}</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </section>

          {/* 5. 在线成员 */}
          <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-[12px] font-bold text-[#777]">在线成员</div>
              <button
                type="button"
                className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted hover:bg-[#f3f3f3] hover:text-ink"
                onClick={() => setPage("team")}
              >
                全部名册
              </button>
            </div>
            {!teamReady ? (
              <div role="status" aria-label="正在加载" className="flex flex-col gap-2 py-1.5">
                {[0, 1].map((i) => (
                  <div key={i} className="h-7 animate-pulse rounded-lg bg-[#f4f4f4]" />
                ))}
              </div>
            ) : teamError ? (
              <div className="text-[12px] text-[#b42318]">加载失败：{teamError}</div>
            ) : onlineMembers.length === 0 ? (
              <div className="text-[12px] text-muted">当前没有人在线</div>
            ) : (
              onlineMembers.map((m) => (
                <div key={m.user.id} className="flex items-center gap-2 py-1 text-[12px]">
                  <span className="relative">
                    <Avatar
                      user={{ displayName: m.user.displayName, avatar: m.user.avatar }}
                      size={22}
                    />
                    <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white bg-[#16a34a]" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{m.user.displayName}</span>
                  <span className="text-muted">@{m.user.username}</span>
                </div>
              ))
            )}
          </section>

          {/* 6. 系统状态 */}
          <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
            <div className="mb-1.5 text-[12px] font-bold text-[#777]">系统状态</div>
            <div className="flex justify-between py-0.5 text-[12px]">
              <span className="text-muted">云端连接</span>
              <span>{cloud}</span>
            </div>
            <div className="flex justify-between py-0.5 text-[12px]">
              <span className="text-muted">实时通道</span>
              <span className="text-muted">会话内连接</span>
            </div>
            <div className="flex justify-between py-0.5 text-[12px]">
              <span className="text-muted">本地工作目录</span>
              <span className="text-muted">未绑定</span>
            </div>
          </section>
        </div>
      </div>

      {/* 7. 底部通栏：最新资讯（静态常量） */}
      <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
        <div className="mb-2 text-[12px] font-bold text-[#777]">最新资讯</div>
        <div className="grid grid-cols-3 gap-2.5">
          {NEWS.map((n) => (
            <article key={n.title} className="rounded-lg border border-line-soft bg-[#fafafa] p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="rounded-sm border border-line bg-white px-1.5 py-px text-[10px] text-muted">
                  {n.source}
                </span>
                <span className="text-[10px] text-muted">{n.date}</span>
              </div>
              <div className="mt-1 text-[12px] font-bold">{n.title}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{n.summary}</div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
