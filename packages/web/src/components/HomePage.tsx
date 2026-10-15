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

export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const { conversations, friends, incoming, messages, loadWorkspace } = useChatStore();
  const openConversation = useUiStore((s) => s.openConversation);
  const { quota, records } = useTokenUsageStore();
  const [tab, setTab] = useState<"me" | "team" | "date">("me");
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"检测中" | "正常" | "失败">("检测中");

  // 真实数据优先：挂载时加载工作区数据与云端健康探测
  useEffect(() => {
    void loadWorkspace().catch((err) => console.warn("工作区数据加载失败", err));
  }, [loadWorkspace]);

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
  const todayTotal = useMemo(
    () => records.reduce((sum, r) => (dayKeyOf(r.at) === todayKey ? sum + r.tokens : sum), 0),
    [records, todayKey],
  );

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

  const pct = quota > 0 ? Math.min(100, Math.round((monthSummary.total / quota) * 100)) : 0;
  const modelRows = Object.entries(monthSummary.byModel).sort((a, b) => b[1] - a[1]);
  const recent = conversations.slice(0, 6);

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
            版本 v0.1.0
          </span>
          <span className="rounded-md border border-line bg-[#fafafa] px-2 py-0.5 text-[11px] text-muted">
            今日已用 {todayTotal}
          </span>
        </div>
      </div>

      {/* 2. 四张统计卡（真实数据） */}
      <div className="grid grid-cols-4 gap-2.5">
        <StatCard title="会话总数" value={String(conversations.length)} sub="含群聊" />
        <StatCard title="好友数" value={String(friends.length)} sub="可拉群聊" />
        <StatCard title="我的智能体" value="0" sub="M3 开放创建" />
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

      {/* 3/4/5/6. 两栏：左最近会话；右智能体动态 + 待处理 + 系统状态 */}
      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
        <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
          <div className="mb-1.5 text-[12px] font-bold text-[#777]">最近会话</div>
          {recent.length === 0 ? (
            <div className="py-3 text-[12px] text-muted">暂无会话，从工作区开始</div>
          ) : (
            recent.map((c) => {
              const list = messages[c.id] ?? [];
              const last = list[list.length - 1];
              const preview = last ? last.payload.text : "暂无消息";
              // conversations 联合类型（M2）：direct 显 peer、group 显群名
              const title = c.type === "direct" ? c.peer.displayName : c.name;
              const avatarUser = c.type === "direct" ? c.peer : { displayName: c.name };
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
            <div className="py-1.5 text-[12px] text-muted">M3 创建智能体后，动态显示在这里</div>
          </section>

          {/* 5. 待处理：真实好友申请 */}
          <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
            <div className="mb-1.5 text-[12px] font-bold text-[#777]">待处理</div>
            {incoming.length === 0 ? (
              <div className="text-[12px] text-muted">没有待处理申请</div>
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
