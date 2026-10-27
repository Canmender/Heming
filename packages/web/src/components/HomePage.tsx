import { Fragment, useEffect, useMemo, useState } from "react";
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
import { acceptFriend, resolveUrl } from "../lib/api.js";
import { Avatar } from "./Avatar.js";
import { TokenHeatmap } from "./TokenHeatmap.js";

/** 构建时注入的版本号（vite define __APP_VERSION__，file:// 桌面端无法 fetch package.json）。 */
declare const __APP_VERSION__: string;

/** 底部通栏「最新资讯」：静态产品介绍常量（非虚构统计数据）。 */
const NEWS: { source: string; title: string; summary: string; date: string }[] = [
  {
    source: "官方",
    title: "和鸣 M1 内测版发布：IM + 通讯录先行",
    summary: "M1 内测版开放内测：本期上线账号体系、好友/通讯录与 1:1 即时通讯，云端共享目录可用。",
    date: "2026-10-13",
  },
  {
    source: "教程",
    title: "三步创建你的第一个智能体",
    summary: "M3 将开放智能体创建：填写名称与简介、绑定个人模型接口、设定提示词，三步即可开聊。",
    date: "2026-10-13",
  },
  {
    source: "技巧",
    title: "用共享目录做会话附件投递",
    summary: "右栏「云端共享」上传文件后可在文件行悬停投递；共享目录中的文件对会话成员可见。",
    date: "2026-10-13",
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

/**
 * 工作区首帧的两种非数据态：加载骨架 / 失败重试。
 *
 * 为什么单独一个组件：会话、智能体、待处理三块原来在 `[]` 上统一渲染「暂无 X」，
 * 而首帧还没落地或首帧失败时列表同样是 `[]`——于是「正在加载」和「加载失败」
 * 都伪装成了「你还没有数据」。空态文案只该在真的拿到过数据之后出现。
 */
function WorkspaceFallback({ error, onRetry, rows = 3 }: { error: string | null; onRetry: () => void; rows?: number }) {
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2 py-1.5 text-[12px]">
        <span className="min-w-0 truncate text-[#b42318]">{`加载失败：${error}`}</span>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-[#e6e6e6] px-2 py-0.5 text-[11px] hover:bg-[#f7f7f7]"
        >
          重试
        </button>
      </div>
    );
  }
  return (
    <div role="status" aria-label="正在加载" className="flex flex-col gap-2 py-1.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-7 animate-pulse rounded-lg bg-[#f4f4f4]" />
      ))}
    </div>
  );
}

export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const {
    conversations,
    friends,
    incoming,
    messages,
    loadWorkspace,
    agents,
    agentsRoster,
    loadAgentsRoster,
    workspaceReady,
    workspaceError,
  } = useChatStore();
  const openConversation = useUiStore((s) => s.openConversation);
  const { quota, records } = useTokenUsageStore();
  const [tab, setTab] = useState<"me" | "team" | "date">("me");
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"检测中" | "正常" | "失败">("检测中");

  // 真实数据优先：挂载时加载工作区数据、云端健康探测与智能体名册
  useEffect(() => {
    void loadWorkspace().catch((err) => console.warn("工作区数据加载失败", err));
    void loadAgentsRoster().catch(() => {});
  }, [loadWorkspace, loadAgentsRoster]);

  // 重试只由失败条上的按钮触发：错误已经写进 store，这里吞掉 rejection 即可
  const retryWorkspace = () => {
    void loadWorkspace().catch(() => {});
  };

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
  /**
   * 最近会话：按最后消息时间降序（无消息排最后），取前 6。
   *
   * 之前直接 slice 数组——那是服务端的创建序，不是「最近」。
   */
  const recent = useMemo(() => {
    return [...conversations]
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(0, 6);
  }, [conversations]);
  // 智能体动态：优先群内已挂载的，空时回退名册全量（用户可能只自建未入群）
  const displayAgents = (agents.length > 0 ? agents : agentsRoster).slice(0, 3);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-6">
      {/* 1. 问候行：问候 + 日期 + 两个小徽标 */}
      <div className="flex items-start gap-3">
        <div>
          <h1 className="text-[17px] font-extrabold">
            {greeting}，{user?.displayName ?? ""}
            <span className="ml-2 text-[12px] font-normal text-muted">{today}</span>
          </h1>
          <p className="mt-0.5 text-[12px] text-muted">欢迎使用和鸣 —— 从工作区添加好友开始</p>
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
        <StatCard title="会话总数" value={String(conversations.length)} sub="含群聊" />
        <StatCard title="好友数" value={String(friends.length)} sub="可拉群聊" />
        <StatCard title="我的智能体" value={String(agentsRoster.length)} sub="含系统预设" />
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

      {/* 3/4/5/6. 两栏：左最近会话；右智能体动态 + 待处理 + 系统状态 */}
      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
        <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
          <div className="mb-1.5 text-[12px] font-bold text-[#777]">最近会话</div>
          {recent.length === 0 ? (
            !workspaceReady ? (
              <WorkspaceFallback error={workspaceError} onRetry={retryWorkspace} />
            ) : (
              <div className="py-3 text-[12px] text-muted">暂无会话，从工作区开始</div>
            )
          ) : (
            recent.map((c) => {
              const list = messages[c.id] ?? [];
              const last = list[list.length - 1];
              // 纯附件消息 text=""（T1）：空串直渲染会空白，回退口径与 ContactDetail 对齐；
              // 已撤回不泄漏原文，统一「消息已撤回」（与气泡文案一致）
              const preview = last
                ? last.recalledAt != null
                  ? "消息已撤回"
                  : last.payload.text || "(附件)"
                : c.lastMessageAt
                  ? "点击查看消息" // 有消息但本机还没加载：不冒充「暂无消息」
                  : "暂无消息";
              // 三态会话（direct / agent 一对一 / group）各自的显示名与头像
              const title =
                c.type === "direct"
                  ? c.peer.displayName
                  : c.type === "agent"
                    ? c.agent.name
                    : c.name;
              const avatarUser =
                c.type === "direct"
                  ? c.peer
                  : c.type === "agent"
                    ? { displayName: c.agent.name, avatar: c.agent.avatar ?? undefined }
                    : { displayName: c.name };
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openConversation(c.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors duration-150 hover:bg-[#f7f7f7]"
                >
                  <Avatar user={avatarUser} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{title}</span>
                    <span className="block truncate text-[11px] text-muted">{preview}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {last ? fmtTime(last.createdAt) : ""}
                  </span>
                  {/* 未读角标（direct/group 一致，取服务端 unreadCount）：黑底白字圆角小徽标 */}
                  {c.unreadCount > 0 && (
                    <span
                      aria-label={`${c.unreadCount} 条未读`}
                      className="min-w-[18px] shrink-0 rounded-full bg-ink px-1.5 text-center text-[10px] font-semibold leading-[16px] text-white"
                    >
                      {c.unreadCount}
                    </span>
                  )}
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
              <div className="py-1.5 text-[12px] text-muted">暂无智能体，可在工作区创建</div>
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

          {/* 5. 待处理：真实好友申请 */}
          <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
            <div className="mb-1.5 text-[12px] font-bold text-[#777]">待处理</div>
            {incoming.length === 0 ? (
              !workspaceReady ? (
                <WorkspaceFallback error={workspaceError} onRetry={retryWorkspace} rows={2} />
              ) : (
                <div className="text-[12px] text-muted">没有待处理申请</div>
              )
            ) : (
              incoming.map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-1 text-[12px]">
                  <Avatar user={r.from} size={22} />
                  <span className="font-medium">{r.from.displayName}</span>
                  <span className="text-muted">@{r.from.username}</span>
                  <button
                    type="button"
                    className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card"
                    onClick={() => {
                      acceptFriend(r.id)
                        .then(() => loadWorkspace())
                        .catch((err) => console.warn("接受好友申请失败", err));
                    }}
                  >
                    接受
                  </button>
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
                <span className="rounded border border-line bg-white px-1.5 py-px text-[10px] text-muted">
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
