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
import { PRICING_DISCLAIMER, lookupCapability } from "../lib/modelCaps.js";
import { byProfileModel, monthKeyOf, useTokenUsageStore } from "../store/tokenUsage.js";
import { PlusIcon } from "./icons.js";

/** 设置区 · 候选链：一条按声明顺序的模型链，第一个答不了才走下一个。 */

const EFFECT_NOTE = "改动即时生效，仅作用于本机，绝不上传和鸣服务端。";

const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";

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

/**
 * 参考价估算（元）：价目按「服务商×模型」查，输入按 input、输出按 output 各算一份。
 *
 * 只有拿到**完整拆分**才估——拿 total 去猜输入/输出比例，猜错了账面差好几倍，
 * 那是把「估算」做成「假账」。同样地，缓存命中按未命中的价计，估出来是**上界**。
 * 表里没这家（或这条账没有拆分）→ null，界面就老实用「暂无可估的费用数据」。
 */
function estimateYuan(
  provider: LlmProvider,
  model: string,
  input: number,
  output: number,
): number | null {
  if (input <= 0 && output <= 0) return null;
  const pricing = lookupCapability(provider, model)?.pricing;
  if (!pricing) return null;
  return (input / 1_000_000) * pricing.input + (output / 1_000_000) * pricing.output;
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
    <section className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold text-[#777]">候选链</span>
          <span className="text-[11px] text-muted">第一个答不了才走下一个</span>
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
      <div className="mt-1 text-[11px] text-muted">
        链里只存连接的引用，API Key 仍各自留在本机安全存储里
      </div>

      {routes.length === 0 && !open && (
        <div className="mt-3 text-[12px] text-muted">还没有候选链</div>
      )}

      {routes.map((g) => (
        <div key={g.id} className="mt-3 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-bold">{g.label}</div>
              <div className="mt-0.5 text-[11px] text-muted">
                {g.members.length} 个候选 · {g.strategy === "cheap" ? "参考价优先" : "按声明顺序"} ·
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
                  <span className="w-4 shrink-0 text-right text-[#aaa]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {p ? `${p.label} · ${m.model ?? p.model}` : "（连接已删除）"}
                  </span>
                  {p && lookupCapability(p.provider, m.model ?? p.model) === null && (
                    <span className="shrink-0 text-[10px] text-[#aaa]">窗口未知</span>
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
            <span className="text-[12px] font-bold text-[#777]">休息中的候选</span>
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
                <span className="shrink-0 text-[11px] text-muted">
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
          <div className="text-[12px] font-bold text-[#777]">本月逐候选用量</div>
          <ul className="mt-1.5 space-y-1">
            {usage.map((u) => {
              const p = profiles.find((x) => x.id === u.profileId);
              const yuan = p ? estimateYuan(p.provider, u.model, u.input, u.output) : null;
              return (
                <li key={`${u.profileId}-${u.model}`} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">
                    {u.profileLabel} · {u.model}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{u.total} tokens</span>
                  <span className="shrink-0 text-[11px] text-muted">
                    {yuan !== null
                      ? `≈ ¥${yuan < 0.001 ? yuan.toFixed(4) : yuan.toFixed(3)}`
                      : "暂无可估的费用数据"}
                  </span>
                  {u.unreported > 0 && (
                    <span className="shrink-0 text-[10px] text-[#aaa]">
                      {u.unreported} 轮未上报
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-1.5 text-[10px] text-[#999]">{PRICING_DISCLAIMER}</div>
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="mt-3 rounded-lg border border-line p-3">
          <label className="text-[12px] text-muted">
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
            <legend className="text-[12px] text-muted">选路方式</legend>
            <div className="mt-1 flex gap-3 text-[12px]">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  aria-label="按声明顺序选路"
                  checked={strategy === "order"}
                  onChange={() => setStrategy("order")}
                />
                按声明顺序
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  aria-label="参考价优先选路"
                  checked={strategy === "cheap"}
                  onChange={() => setStrategy("cheap")}
                />
                参考价优先
              </label>
            </div>
            <div className="mt-1 text-[11px] text-muted">
              参考价优先：醒着的候选里先问本机价目表上便宜的那个（查不到价目的排最后，不猜）；
              休息中的仍排最后——省钱排在「现在能不能答」之后。
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
                  <span className="w-4 shrink-0 text-right text-[#aaa]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {p ? `${p.label} · ${m.model ?? p.model}` : "（连接已删除）"}
                  </span>
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
            <div className="mt-1 text-[11px] text-muted">只有一个候选，等于不换人——再加一个才有备胎。</div>
          )}

          {error && <div className="mt-2 text-[12px] text-red-600">{error}</div>}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="submit"
              className="rounded-lg bg-ink px-4 py-1.5 text-sm font-bold text-white"
            >
              保存
            </button>
            <button type="button" onClick={resetForm} className={btnGhost}>
              取消
            </button>
          </div>
        </form>
      )}

      <div className="mt-3 border-t border-line-soft pt-2 text-[11px] text-[#999]">{EFFECT_NOTE}</div>
    </section>
  );
}
