import { useMemo, useState } from "react";
import { PageShell } from "./layout/PageShell.js";
import { RouteGroupsCard } from "./RouteGroupsCard.js";
import { llmHealth } from "../lib/llmHealth.js";
import { useLlmStore } from "../store/llm.js";
import { useTokenUsageStore, monthKeyOf } from "../store/tokenUsage.js";
import { useUiStore } from "../store/ui.js";

/**
 * 模型路由（d.84 · magpie 语义移植的内置模块页）。
 *
 * 这个页面的职责是「把换候选这件事说清楚」，不是再造一套路由：
 * - 候选链的增删改、休息名单、逐候选用量都在 `RouteGroupsCard`（与设置区同一份实现，
 *   搬页不复制，避免两处口径漂移）；
 * - 本页只补三样：一眼能看完的**概览数字**、每档策略的**人话语义**、以及**边界**——
 *   哪几档是 magpie 的服务端能力、本仓作为客户端刻意没做近似。
 *
 * 边界（改之前先看）：
 * - 全部数据只读本机 store（连接、路由组、冷却、用量），本页**不发任何网络请求**；
 * - 冷却是本机内存档，重启清零；用量来自本机 token 记账，不上云；
 * - 不读供应商配额、不做并发/限流/请求翻译——那是 magpie 网关侧的语义，
 *   本仓没有数据源就不装样子（见 lib/llmRoute.ts 文件头与移植台账）。
 */
export function ModelRoutePage() {
  const profiles = useLlmStore((s) => s.profiles);
  const routes = useLlmStore((s) => s.routes);
  const records = useTokenUsageStore((s) => s.records);
  const openSettings = useUiStore((s) => s.openSettings);
  const [now] = useState(() => Date.now());

  const overview = useMemo(() => {
    const members = routes.reduce((n, group) => n + group.members.length, 0);
    const resting = llmHealth.entries(now).length;
    const month = monthKeyOf(new Date(now).toISOString());
    let tokens = 0;
    for (const r of records) if (monthKeyOf(r.at) === month) tokens += r.tokens ?? 0;
    return {
      profiles: profiles.length,
      routes: routes.length,
      members,
      resting,
      tokens,
    };
  }, [profiles, routes, records, now]);

  return (
    <PageShell
      title="模型路由"
      subtitle="把网关里的多个模型串成一条候选链：第一个答不了才走下一个；选路策略、冷却与用量都只在本机算。"
      width="wide"
      actions={
        <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={() => openSettings("model")}>
          管理模型
        </button>
      }
    >
      <section aria-label="路由概览" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "可用模型", value: String(overview.profiles), hint: "来自 magpie 网关" },
          { label: "候选链", value: String(overview.routes), hint: `${overview.members} 个候选` },
          { label: "休息中", value: String(overview.resting), hint: "冷却到点自动回来" },
          {
            label: "本月用量",
            value: overview.tokens > 0 ? overview.tokens.toLocaleString("zh-CN") : "—",
            hint: "只统计本机已上报的量",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-line bg-white p-4 shadow-card"
            aria-label={`统计 ${card.label}`}
          >
            <div className="ui-caption">{card.label}</div>
            <div className="mt-1 text-[18px] font-semibold leading-6 ui-numeric">{card.value}</div>
            <div className="ui-micro">{card.hint}</div>
          </div>
        ))}
      </section>

      <RouteGroupsCard />

      {profiles.length < 1 && (
        <p className="mt-3 ui-caption">
          还没有模型连接。先到设置区加一条连接，才能把它串成候选链。
        </p>
      )}

      <section className="mt-4 rounded-xl border border-line bg-white p-4 shadow-card" aria-label="选路策略说明">
        <h2 className="ui-section-title">每档策略在选谁</h2>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {STRATEGY_NOTES.map((row) => (
            <div key={row.name} className="min-w-0">
              <dt className="ui-body-sm font-medium">{row.name}</dt>
              <dd className="ui-caption">{row.note}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 ui-caption">
          所有策略都遵守同一条底线：休息中的候选一律排最后但绝不丢弃；只吐过内容的回复绝不换人
          （换人等于把两段回答拼给用户）。停用「模型路由」模块后选路退回声明顺序，候选链与失败切换照常工作。
        </p>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4 shadow-card" aria-label="边界说明">
        <h2 className="ui-section-title">边界</h2>
        <ul className="mt-1.5 space-y-1 ui-caption">
          <li>本页只读本机数据，不发网络请求；连接里的 Key 在系统安全存储里，路由组只存连接引用。</li>
          <li>冷却与测速本机内存档，重启清零；用量来自本机 token 记账，不上云。</li>
          <li>
            不读供应商的配额、并发与限流数据，也不做请求翻译——这些是 magpie 网关侧的能力，本仓没有数据源就不做近似。
          </li>
          <li>
            语义参考 magpie（github.com/yetone/magpie，MIT）：候选链 / 失败切换 / 冷却 / 脱敏 / 选路策略；实现是本仓自己的，不搬运代码。
          </li>
        </ul>
      </section>
    </PageShell>
  );
}

/** 策略人话（与 llmRoute.ts 的实现一一对应；改策略时两处一起改）。 */
const STRATEGY_NOTES: { name: string; note: string }[] = [
  { name: "按声明顺序", note: "按你排的顺序问，最稳的默认档。" },
  { name: "参考价优先", note: "醒着的候选里先问参考价更便宜的；查不到价目的排最后，不猜它便宜。" },
  { name: "智能", note: "综合本月用量、参考价与近期失败：用得少、更便宜、最近答得上来的排前面。" },
  { name: "用得最少优先", note: "本月用量少的先问；同量按声明顺序。" },
  { name: "按节奏优先", note: "按「已用 ÷ 本月已过时间」排，花得比时间慢的先问。" },
  { name: "按权重", note: "给每个候选一个权重（1–100），按平滑加权轮询分请求。" },
  { name: "按速度优先", note: "最近首 token 更快、输出更快的先问；没测过速的排在测过的后面，并定期给一个机会。" },
  { name: "轮流", note: "醒着的候选轮流问，休息的跳过。" },
];
