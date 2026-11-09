import { useState } from "react";
import {
  routeRef,
  useLlmStore,
  type LlmProfile,
  type LlmProvider,
  type RouteGroup,
  type RouteMember,
  type RouteStrategy,
} from "../store/llm.js";
import { llmHealth, accountKey, modelKey } from "../lib/llmHealth.js";
import { lookupCapability } from "../lib/modelCaps.js";
import { byProfileModel, monthKeyOf, useTokenUsageStore } from "../store/tokenUsage.js";
import { PlusIcon } from "./icons.js";

/** 设置区 · 候选链：一条按声明顺序的模型链，第一个答不了才走下一个。 */

/**
 * 选路档的中文名与一行说明（语义照 magpie；本仓是客户端，不读供应商配额）。
 *
 * 本地「模型路由」页已下线（magpie 路由组取代），这里就是档位说明的唯一来源；
 * 改档位说明只改这一处。
 */
const STRATEGY_OPTIONS: readonly { value: RouteStrategy; label: string; desc: string }[] = [
  {
    value: "order",
    label: "按声明顺序",
    desc: "第一个能答的一直答，最省事也最可预期。",
  },
  {
    value: "smart",
    label: "智能",
    desc: "醒着里按本月用量与近期失败综合打分（网关不提供价格，不含价格维度）。",
  },
  {
    value: "usage",
    label: "用得最少优先",
    desc: "本月用量最少的先问；近期用量按 1 小时半衰计，同量保持声明顺序。",
  },
  {
    value: "pace",
    label: "按节奏优先",
    desc: "本月用量 ÷ 本月已过时间，比值小的先问；不假设供应商有额度、不装配额。",
  },
  {
    value: "weight",
    label: "按权重",
    desc: "平滑加权轮询：权重大的被选中更多；权重 1–100，缺省 1。",
  },
  {
    value: "fast",
    label: "按速度优先",
    desc: "最近「首 token + 200 token 用时」短的先问；没测过速的排后，每 5 次给一次机会。",
  },
  {
    value: "rotate",
    label: "轮流",
    desc: "醒着的候选按序轮换、休息的跳过，请求分布最均匀。",
  },
];

/** 档位 → 中文名；认不出的值按「按声明顺序」显示（与路由层兜底一致）。 */
function strategyLabel(strategy: RouteStrategy | undefined): string {
  return STRATEGY_OPTIONS.find((o) => o.value === strategy)?.label ?? "按声明顺序";
}

/** 权重输入规范化：夹到 1–100 的整数，坏输入回落缺省 1。 */
function clampWeight(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 1;
}


const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
const btnGhost =
  "ui-btn ui-btn-sm ui-btn-ghost";

function newGroupId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 冷却档键 → 人话：`a:p-1` → 连接名；`m:p-1@model` → 连接名 · 模型。 */
function describeRestKey(key: string, profiles: LlmProfile[]): string {
  const labelOf = (id: string) => profiles.find((p) => p.id === id)?.label ?? id;
  if (key.startsWith("a:")) return labelOf(key.slice(2));
  if (key.startsWith("m:")) {
    const at = key.lastIndexOf("@");
    return `${labelOf(key.slice(2, at))} · ${key.slice(at + 1)}`;
  }
  return key;
}

function formatLeft(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

export function RouteGroupsCard() {
  const profiles = useLlmStore((s) => s.profiles);
  const routes = useLlmStore((s) => s.routes);
  const bindings = useLlmStore((s) => s.bindings);
  const records = useTokenUsageStore((s) => s.records);
  const addRoute = useLlmStore((s) => s.addRoute);
  const updateRoute = useLlmStore((s) => s.updateRoute);
  const removeRoute = useLlmStore((s) => s.removeRoute);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [members, setMembers] = useState<RouteMember[]>([]);
  const [strategy, setStrategy] = useState<RouteStrategy>("order");
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 休息名单的读取时刻：每次重渲染取一次（够用——这里没有轮询需求）。 */
  const [now, setNow] = useState(() => Date.now());

  const resetForm = () => {
    setOpen(false);
    setEditingId(null);
    setLabel("");
    setMembers([]);
    setStrategy("order");
    setPick("");
    setError(null);
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openEdit = (g: RouteGroup) => {
    setEditingId(g.id);
    setLabel(g.label);
    setMembers(g.members);
    setStrategy(g.strategy ?? "order");
    setPick("");
    setError(null);
    setOpen(true);
  };

  const addMember = () => {
    if (!pick) return;
    if (members.some((m) => m.profileId === pick && !m.model)) {
      setError("这个连接已经在链里了（同连接换模型请从下拉里选带模型的项）");
      return;
    }
    const p = profiles.find((x) => x.id === pick);
    setMembers([...members, { profileId: pick, model: p?.model }]);
    setPick("");
    setError(null);
  };

  const moveMember = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= members.length) return;
    const next = [...members];
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row);
    setMembers(next);
  };

  /** 编辑成员的轮询权重（仅 `weight` 档显示该输入）。 */
  const setMemberWeight = (index: number, raw: string) => {
    setMembers(members.map((m, j) => (j === index ? { ...m, weight: clampWeight(raw) } : m)));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("请填写候选链名称");
      return;
    }
    if (members.length === 0) {
      setError("至少选一个候选连接");
      return;
    }
    const group: RouteGroup = {
      id: editingId ?? newGroupId(),
      label: label.trim(),
      members,
      strategy,
    };
    if (editingId) updateRoute(editingId, { label: group.label, members, strategy });
    else addRoute(group);
    resetForm();
  };

  const boundCount = (id: string) =>
    Object.values(bindings).filter((ref) => ref === routeRef(id)).length;

  /** 候选排在第几位由「是否在休息」决定，声明顺序仍是主序（resting 一律排后但不删除）。 */
  const rests = llmHealth.entries(now);
  /** 本月逐候选账（d.48）：只有记到具体 Key 的记录才进这份账。 */
  const usage = byProfileModel(records, monthKeyOf(new Date().toISOString()));

  if (profiles.length < 1) {
    return null; // 还没有任何连接，谈不上候选链
  }

  return (
    <section className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold text-muted">候选链</span>
          <span className="ui-caption">第一个答不了才走下一个</span>
        </div>
        {!open && (
          <button
            type="button"
            aria-label="新建候选链"
            onClick={openCreate}
            className={`inline-flex items-center gap-1 ${btnGhost}`}
          >
            <PlusIcon width={12} height={12} aria-hidden="true" />
            新建候选链
          </button>
        )}
      </div>
      <div className="mt-1 ui-caption">
        链里只存连接的引用，API Key 仍各自留在本机安全存储里
      </div>

      {routes.length === 0 && !open && (
        <div className="mt-3 ui-caption">还没有候选链</div>
      )}

      {routes.map((g) => (
        <div key={g.id} className="mt-3 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate ui-section-title">{g.label}</div>
              <div className="mt-0.5 ui-caption">
                {g.members.length} 个候选 · {strategyLabel(g.strategy)} ·
                绑定 {boundCount(g.id)} 个智能体
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" aria-label={`编辑 ${g.label}`} onClick={() => openEdit(g)} className={btnGhost}>
                编辑
              </button>
              <button
                type="button"
                aria-label={`删除 ${g.label}`}
                onClick={() => {
                  removeRoute(g.id);
                  if (editingId === g.id) resetForm();
                }}
                className={btnGhost}
              >
                删除
              </button>
            </div>
          </div>
          <ol className="mt-2 space-y-1">
            {g.members.map((m, i) => {
              const p = profiles.find((x) => x.id === m.profileId);
              // 账号档与账号×模型档谁长听谁（两档是不同作用域，相加会虚高）
              const resting = Math.max(
                llmHealth.remainingMs(accountKey(m.profileId), now),
                llmHealth.remainingMs(modelKey(m.profileId, m.model ?? p?.model ?? ""), now),
              );
              return (
                <li key={`${m.profileId}-${i}`} className="flex items-center gap-2 text-[12px]">
                  <span className="w-4 shrink-0 text-right text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {p ? `${p.label} · ${m.model ?? p.model}` : "（连接已删除）"}
                  </span>
                  {p && lookupCapability(p.provider, m.model ?? p.model) === null && (
                    <span className="shrink-0 text-[10px] text-muted">窗口未知</span>
                  )}
                  {g.strategy === "weight" && (
                    <span className="shrink-0 ui-caption">权重 {m.weight ?? 1}</span>
                  )}
                  {resting > 0 && (
                    <span className="shrink-0 text-[10px] text-amber-700">
                      休息 {formatLeft(resting)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ))}

      {/* 休息名单：为什么冷却、还剩多久、一键恢复（magpie 的 Unrest 同此）。 */}
      {rests.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-[#fcfcfc] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-muted">休息中的候选</span>
            <button
              type="button"
              aria-label="刷新休息名单"
              className={btnGhost}
              onClick={() => setNow(Date.now())}
            >
              刷新
            </button>
          </div>
          <ul className="mt-1.5 space-y-1">
            {rests.map(({ key, rest }) => (
              <li key={key} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate">{describeRestKey(key, profiles)}</span>
                <span className="shrink-0 ui-caption">
                  {rest.kind} · 还剩 {formatLeft(rest.until - now)}
                </span>
                <button
                  type="button"
                  aria-label={`立即恢复 ${describeRestKey(key, profiles)}`}
                  className={btnGhost}
                  onClick={() => {
                    llmHealth.unrest(key);
                    setNow(Date.now());
                  }}
                >
                  立即恢复
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 逐候选账（d.48）：换候选换的是「谁在花钱」，所以按连接×模型分档列，而不是只给一个总数。 */}
      {usage.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-[#fcfcfc] p-3">
          <div className="text-[12px] font-bold text-muted">本月逐候选用量</div>
          <ul className="mt-1.5 space-y-1">
            {usage.map((u) => {
              return (
                <li key={`${u.profileId}-${u.model}`} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">
                    {u.profileLabel} · {u.model}
                  </span>
                  <span className="shrink-0 ui-caption">{u.total} tokens</span>
                  {u.unreported > 0 && (
                    <span className="shrink-0 text-[10px] text-muted">
                      {u.unreported} 轮未上报
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="mt-3 rounded-lg border border-line p-3">
          <label className="ui-caption">
            名称
            <input
              aria-label="候选链名称"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="如：主用 DeepSeek，备 Kimi"
              className={inputCls}
            />
          </label>

          <fieldset className="mt-2">
            <legend className="ui-caption">选路方式</legend>
            <div className="mt-1 space-y-1 text-[12px]">
              {STRATEGY_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-start gap-1.5">
                  <input
                    type="radio"
                    className="mt-0.5"
                    aria-label={`${o.label}选路`}
                    checked={strategy === o.value}
                    onChange={() => setStrategy(o.value)}
                  />
                  <span>
                    <span className="font-medium">{o.label}</span>
                    <span className="text-muted"> · {o.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-1 ui-caption">
              所有档都只用本机数据（不读供应商配额）：休息中的候选永远排最后、绝不删除；
              选路策略恒定生效，候选链与失败切换照常工作。
            </div>
          </fieldset>

          <div className="mt-2 flex items-center gap-1.5">
            <select
              aria-label="添加候选连接"
              className={inputCls}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">选择连接加入…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.model}
                </option>
              ))}
            </select>
            <button type="button" onClick={addMember} className={btnGhost}>
              加入
            </button>
          </div>

          <ol className="mt-2 space-y-1">
            {members.map((m, i) => {
              const p = profiles.find((x) => x.id === m.profileId);
              return (
                <li key={`${m.profileId}-${i}`} className="flex items-center gap-2 text-[12px]">
                  <span className="w-4 shrink-0 text-right text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {p ? `${p.label} · ${m.model ?? p.model}` : "（连接已删除）"}
                  </span>
                  {strategy === "weight" && (
                    <label className="flex shrink-0 items-center gap-1 text-[12px]">
                      权重
                      <input
                        type="number"
                        min={1}
                        max={100}
                        aria-label={`权重 ${p?.label ?? m.profileId}`}
                        value={m.weight ?? 1}
                        onChange={(e) => setMemberWeight(i, e.target.value)}
                        className="w-14 rounded border border-line px-1 py-0.5 text-[12px]"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    aria-label={`上移 ${p?.label ?? m.profileId}`}
                    disabled={i === 0}
                    className={btnGhost}
                    onClick={() => moveMember(i, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    aria-label={`下移 ${p?.label ?? m.profileId}`}
                    disabled={i === members.length - 1}
                    className={btnGhost}
                    onClick={() => moveMember(i, 1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    aria-label={`移出 ${p?.label ?? m.profileId}`}
                    className={btnGhost}
                    onClick={() => setMembers(members.filter((_, j) => j !== i))}
                  >
                    移出
                  </button>
                </li>
              );
            })}
          </ol>
          {members.length === 1 && (
            <div className="mt-1 ui-caption">只有一个候选，等于不换人——再加一个才有备胎。</div>
          )}

          {error && <div role="alert" className="mt-2 text-[12px] text-red-600">{error}</div>}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="submit"
              className="ui-btn ui-btn-md ui-btn-primary"
            >
              保存
            </button>
            <button type="button" onClick={resetForm} className={btnGhost}>
              取消
            </button>
          </div>
        </form>
      )}

    </section>
  );
}
