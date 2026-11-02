import { useCallback, useState } from "react";
import { FLOORS, HITL_KEY, HitlPolicyStore, type HitlPolicy } from "../lib/hitl/policy.js";
import type { HitlMode, PolicyScope, RiskLevel } from "../lib/hitl/types.js";
import { readAudit, type AuditEntry, type StorageLike } from "../lib/selfEdit/guards.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * 免问下限的选项文案。
 *
 * ★ 键必须与 `policy.ts` 导出的 `FLOORS` 一一对应——下拉选项**从 `FLOORS` 渲染**，
 * 不另写一份。理由：两份各写各的就会漂移。
 * 界面多给一个选项，策略层又把它夹掉，用户点下去会发现值没变；
 * 界面少给一个，用户以为自己有更宽的档，实际上没有。
 */
const FLOOR_LABELS: Record<string, string> = {
  read: "只读（风险不高于只读的操作不问）",
  write: "写入（风险不高于写入的操作不问）",
};

/**
 * 设置卡统一的生效说明：与 LLM 连接卡、个人资料卡同一句。
 * 这张卡的每次改动都直接落盘，没有「保存」按钮，所以更要说明清楚。
 */
const EFFECT_NOTE = "改动即时生效，仅作用于本机，无需重启。";

/**
 * 旧存储里是不是存过 `floor:"danger"`？
 *
 * 用来判断「这次是不是刚把红线值夹下来了」，以便在界面上提示一次。
 * 只读不写——提示是给人看的，不是数据迁移。
 */
function hadClampedFloor(storage: StorageLike): boolean {
  try {
    const raw = storage.getItem(HITL_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { floor?: unknown };
    return parsed?.floor === "danger";
  } catch {
    /* 存储坏了读不出来：按「没夹过」处理，不提示 */
    return false;
  }
}

/**
 * HITL 策略卡（挂在设置区）：档位选择 + 免问下限 + 确认留痕。
 *
 * 为什么要放在设置区而不是智能体自己的卡片里：
 * 闸门是**本机的一道安全边界**，不是某个智能体的属性——
 * 用户开一次，对所有智能体生效（作用域由 `scope` 控制）。
 */
export function HitlPolicyCard({
  policyStore,
  storage,
}: {
  policyStore?: HitlPolicyStore;
  storage?: StorageLike;
}) {
  const store = policyStore ?? new HitlPolicyStore(storage);
  const [policy, setPolicy] = useState<HitlPolicy>(() => store.get());
  // 留痕与策略都存在外部存储里，没有订阅机制——改动时手动 bump 触发重渲染。
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  void tick;
  const [confirmClearRules, setConfirmClearRules] = useState(false);
  const [confirmClearSession, setConfirmClearSession] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sessionMsg, setSessionMsg] = useState<{ kind: "ok" | "info"; text: string } | null>(null);

  const store2 = storage ?? browserStorage();
  const audit = readAudit(store2).filter((e) => e.scope === "tool").slice(0, 20);
  const rules = store.rules();

  /*
   * ★ 一次性提示：旧存储里存着 `floor:"danger"` 的用户，这次打开设置区时
   * 免问下限已经被夹成「写入」了——这**改变了他的实际行为**（危险操作开始会问），
   * 属于「静默降级」，所以要在界面上说清楚一次。
   *
   * 为什么不是每次都提示：提示状态只活在本次挂载里，
   * 用户看完改完设置就走了，下次进来不再啰嗦。
   *
   * 为什么读原始存储而不是只看 `policy.floor`：`policy.floor` 已经被夹成 `write`，
   * 光看它分不清「本来就没有 danger」与「刚刚把 danger 夹掉了」。
   */
  const [clampedNotice, setClampedNotice] = useState<boolean>(() => hadClampedFloor(store2));

  const update = (patch: Partial<HitlPolicy>) => {
    const next = { ...policy, ...patch };
    store.set(next);
    setPolicy(store.get());
    setClampedNotice(false);
    setSaved(true);
    bump();
  };

  const clearSession = () => {
    const count = store.grantCount();
    store.revokeAll();
    setConfirmClearSession(false);
    setSessionMsg({
      kind: count > 0 ? "ok" : "info",
      text:
        count > 0
          ? `已清空 ${count} 条本会话授权，这些工具下次调用会重新逐一询问。`
          : "本会话没有需要清空的授权。",
    });
    bump();
  };

  return (
    <section aria-label="工具调用确认" className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="text-[12px] font-bold text-muted">工具调用确认</div>
      <div className="mt-1 text-[11px] text-muted">
        智能体调用有副作用的工具前先问你一句。只读操作默认不打扰，写入与危险操作必问。
      </div>

      <fieldset className="mt-3">
        <legend className="text-[12px] font-bold text-muted">确认档位</legend>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <ModeRow
            mode="strict"
            title="严格"
            desc="任何工具调用都问一遍，包括只读的。"
            checked={policy.mode === "strict"}
            onChange={() => update({ mode: "strict" })}
          />
          <ModeRow
            mode="guarded"
            title="受控（默认）"
            desc="只读操作直接放行；写入与危险操作每次都问。"
            checked={policy.mode === "guarded"}
            onChange={() => update({ mode: "guarded" })}
          />
          <ModeRow
            mode="trusted"
            title="信任"
            desc="同受控，但「本会话内允许此工具」的授权之后不再重复问。"
            checked={policy.mode === "trusted"}
            onChange={() => update({ mode: "trusted" })}
          />
        </div>
      </fieldset>

      <label className="mt-3 block text-[12px]">
        免问下限
        {/*
          ★ 这里**没有**「危险（全部不问）」选项。
          免问下限的语义是「风险**不高于**此值的操作不问」，
          下限取到 danger 时 danger 本身也被包进去 ⇒ 所有档位恒真
          ⇒ 等于一个设置页里的「全部放行」，与「没有全放行档」的红线冲突。
          「危险恒问」的正确表达是下限取「写入」（danger 严格高于写入，不在免问范围内）。
          读侧同样夹住（`policy.ts` 的 `normalizePolicy`），
          所以旧存储里的 `danger` 会被回落成「写入」，不会原样放行。
        */}
        <select
          aria-label="免问下限"
          value={policy.floor}
          onChange={(e) => update({ floor: e.target.value as RiskLevel })}
          className="mt-1 block rounded-lg border border-line-strong px-3 py-2 text-sm outline-hidden focus:border-ink"
        >
          {/*
            选项**从 `FLOORS` 渲染**（策略层的唯一权威列表），不另写一份。
            这样「界面给了但策略层不认」的漂移在结构上就不可能发生。
          */}
          {FLOORS.map((f) => (
            <option key={f} value={f}>
              {FLOOR_LABELS[f] ?? f}
            </option>
          ))}
        </select>
      </label>

      {clampedNotice && (
        <div className="mt-2 rounded-lg border border-line-soft bg-[#fafafa] px-3 py-2 text-[11px] text-muted">
          免问下限已从「危险」下调为「写入」：危险操作现在都会先问你。
          <span className="text-muted">（原先「危险」那一档等同于不设边界，已移除。）</span>
        </div>
      )}

      <label className="mt-3 block text-[12px]">
        授权作用域
        <select
          aria-label="授权作用域"
          value={policy.scope}
          onChange={(e) => update({ scope: e.target.value as PolicyScope })}
          className="mt-1 block rounded-lg border border-line-strong px-3 py-2 text-sm outline-hidden focus:border-ink"
        >
          <option value="global">所有智能体共用</option>
          <option value="per-agent">按智能体分别授权</option>
        </select>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setSessionMsg(null);
            setConfirmClearSession(true);
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card hover:bg-[#fafafa]"
        >
          清空本会话授权
        </button>
        {rules.length > 0 && (
          <button
            type="button"
            onClick={() => setConfirmClearRules(true)}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-red-600 shadow-card hover:bg-[#fafafa]"
          >
            清空记住的规则
          </button>
        )}
        <span className="text-[11px] text-muted">会话授权只存在内存里，退出应用即失效。</span>
        {saved && (
          <span role="status" className="text-[11px] text-muted">
            已保存
          </span>
        )}
      </div>

      {sessionMsg && (
        <div
          role="status"
          className={`mt-2 rounded-lg border border-line-soft bg-[#fafafa] px-3 py-2 text-[11px] ${
            sessionMsg.kind === "ok" ? "text-[#1d6b3a]" : "text-muted"
          }`}
        >
          {sessionMsg.text}
        </div>
      )}

      <div className="mt-3 border-t border-line-soft pt-2">
        <div className="text-[11px] font-bold text-muted">
          记住的规则{rules.length ? `（${rules.length} 条）` : ""}
        </div>
        {rules.length === 0 ? (
          <div className="mt-1 text-[11px] text-muted">
            还没有记住的规则。在确认弹窗里勾选「记住本次选择」即可按工具与资源记住。
          </div>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {rules.map((rule) => (
              <li
                key={`${rule.tool}-${rule.resource}-${rule.at}`}
                className="flex flex-wrap items-baseline gap-1.5 rounded-sm border border-line-soft px-2 py-1 text-[11px]"
              >
                <span
                  className={`rounded-sm px-1 ${
                    rule.effect === "deny"
                      ? "bg-[#fdf0ef] text-[#b42318]"
                      : "bg-[#eef6f0] text-[#1d6b3a]"
                  }`}
                >
                  {rule.effect === "deny" ? "拒绝" : "允许"}
                </span>
                <span className="font-mono text-[#555]">{rule.tool}</span>
                <span className="min-w-0 flex-1 truncate text-muted" title={rule.resource}>
                  {rule.resource === "*" ? "所有调用" : rule.resource}
                </span>
                <span className="shrink-0 text-[10px] text-muted">
                  {rule.agentName || rule.agentId ? rule.agentName || "指定智能体" : "全部智能体"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {rules.length > 0 && (
          <div className="mt-1 text-[10px] text-muted">
            拒绝规则优先于允许规则；记住的允许对危险操作不生效。新规则只对当前智能体生效。
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-line-soft pt-2">
        <div className="text-[11px] font-bold text-muted">
          确认记录{audit.length ? `（最近 ${audit.length} 条）` : ""}
        </div>
        {audit.length === 0 ? (
          <div className="mt-1 text-[11px] text-muted">还没有确认记录。</div>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {audit.map((entry, i) => (
              <AuditRow key={`${entry.at}-${i}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      {confirmClearRules && (
        <ConfirmDialog
          title="清空记住的规则"
          onCancel={() => setConfirmClearRules(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmClearRules(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  store.clearRules();
                  setConfirmClearRules(false);
                  bump();
                }}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                清空
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            清空全部 {rules.length} 条记住的规则？之后同类工具会重新询问；拒绝规则与允许规则都会被移除，操作不可撤销。
          </p>
        </ConfirmDialog>
      )}
      {confirmClearSession && (
        <ConfirmDialog
          title="清空本会话授权"
          onCancel={() => setConfirmClearSession(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmClearSession(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={clearSession}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                清空授权
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            清空后，本会话里已授权的工具将重新逐一询问。授权本来就只存在内存里，退出应用也会失效；此操作不可撤销。
          </p>
        </ConfirmDialog>
      )}

      <div className="mt-3 border-t border-line-soft pt-2 text-[11px] text-muted">
        {EFFECT_NOTE}
      </div>
    </section>
  );
}

/** 档位选项行（单选语义）。 */
function ModeRow({
  mode,
  title,
  desc,
  checked,
  onChange,
}: {
  mode: HitlMode;
  title: string;
  desc: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="radio"
        name="hitl-mode"
        aria-label={title}
        checked={checked}
        onChange={onChange}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-[12px] font-bold">{title}</span>
        <span className="block text-[11px] text-muted">{desc}</span>
      </span>
      <span className="sr-only">{mode}</span>
    </label>
  );
}

/** 一条确认留痕。 */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const time = entry.at.slice(0, 16).replace("T", " ");
  const approved = entry.action !== "deny" && entry.action !== "reject";
  return (
    <li className="flex flex-wrap items-baseline gap-1.5 rounded-sm border border-line-soft px-2 py-1 text-[11px]">
      <span className="text-muted">{time}</span>
      <span
        className={`rounded-sm px-1 text-muted ${approved ? "bg-[#eef6f0] text-[#1d6b3a]" : "bg-[#fdf0ef] text-[#b42318]"}`}
      >
        {approved ? "已允许" : "已拒绝"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[#555]">{entry.target}</span>
      {entry.rejected ? (
        <span className="text-[#b45309]" title={entry.rejected}>
          {entry.rejected}
        </span>
      ) : null}
    </li>
  );
}

/** localStorage 适配（与 guards 默认实现同口径）。 */
function browserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 隐私模式 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}
