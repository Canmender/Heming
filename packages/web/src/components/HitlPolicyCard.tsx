import { useCallback, useState } from "react";
import { HitlPolicyStore, type HitlPolicy } from "../lib/hitl/policy.js";
import type { HitlMode, PolicyScope, RiskLevel } from "../lib/hitl/types.js";
import { readAudit, type AuditEntry, type StorageLike } from "../lib/selfEdit/guards.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

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

  const store2 = storage ?? browserStorage();
  const audit = readAudit(store2).filter((e) => e.scope === "tool").slice(0, 20);
  const rules = store.rules();

  const update = (patch: Partial<HitlPolicy>) => {
    const next = { ...policy, ...patch };
    store.set(next);
    setPolicy(store.get());
    bump();
  };

  return (
    <section aria-label="工具调用确认" className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="text-[12px] font-bold text-[#777]">工具调用确认</div>
      <div className="mt-1 text-[11px] text-muted">
        智能体调用有副作用的工具前先问你一句。只读操作默认不打扰，写入与危险操作必问。
      </div>

      <fieldset className="mt-3">
        <legend className="text-[12px] font-bold text-[#777]">确认档位</legend>
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
        <select
          aria-label="免问下限"
          value={policy.floor}
          onChange={(e) => update({ floor: e.target.value as RiskLevel })}
          className="mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
        >
          <option value="read">只读（风险不高于只读的操作不问）</option>
          <option value="write">写入（只问危险操作）</option>
          <option value="danger">危险（全部不问）</option>
        </select>
      </label>

      <label className="mt-3 block text-[12px]">
        授权作用域
        <select
          aria-label="授权作用域"
          value={policy.scope}
          onChange={(e) => update({ scope: e.target.value as PolicyScope })}
          className="mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
        >
          <option value="global">所有智能体共用</option>
          <option value="per-agent">按智能体分别授权</option>
        </select>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            store.revokeAll();
            bump();
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
      </div>

      <div className="mt-3 border-t border-line-soft pt-2">
        <div className="text-[11px] font-bold text-[#999]">
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
                className="flex flex-wrap items-baseline gap-1.5 rounded border border-line-soft px-2 py-1 text-[11px]"
              >
                <span
                  className={`rounded px-1 ${
                    rule.effect === "deny"
                      ? "bg-[#fdf0ef] text-[#b42318]"
                      : "bg-[#eef6f0] text-[#1d6b3a]"
                  }`}
                >
                  {rule.effect === "deny" ? "拒绝" : "允许"}
                </span>
                <span className="font-mono text-[#555]">{rule.tool}</span>
                <span className="min-w-0 flex-1 truncate text-[#999]" title={rule.resource}>
                  {rule.resource === "*" ? "所有调用" : rule.resource}
                </span>
                <span className="shrink-0 text-[10px] text-[#aaa]">
                  {rule.agentName || rule.agentId ? rule.agentName || "指定智能体" : "全部智能体"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {rules.length > 0 && (
          <div className="mt-1 text-[10px] text-[#aaa]">
            拒绝规则优先于允许规则；记住的允许对危险操作不生效。新规则只对当前智能体生效。
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-line-soft pt-2">
        <div className="text-[11px] font-bold text-[#999]">
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
    <li className="flex flex-wrap items-baseline gap-1.5 rounded border border-line-soft px-2 py-1 text-[11px]">
      <span className="text-[#aaa]">{time}</span>
      <span
        className={`rounded px-1 text-[#777] ${approved ? "bg-[#eef6f0] text-[#1d6b3a]" : "bg-[#fdf0ef] text-[#b42318]"}`}
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
