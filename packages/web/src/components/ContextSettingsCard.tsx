import { useState } from "react";
import {
  loadContextSettings,
  saveContextSettings,
  type ContextSettings,
} from "../lib/agentContext/settings.js";

/**
 * 设置区 · 上下文预算（设计 §5）：@ 触发链路的历史 token 预算与压缩开关。
 * 无保存按钮——每次改动即时落盘 `heming.context.v1`（本机 localStorage）；
 * 关闭总开关即「按原样发送」，行为回到加预算之前。
 */

/** 预算预设（token）。 */
const BUDGET_OPTIONS = [4000, 6000, 8000, 12000];
/** 原文保留轮数预设。 */
const TURN_OPTIONS = [2, 4, 8, 12];

const labelCls = "text-[12px] text-muted";
const selectCls =
  "mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]";
const hintCls = "text-[11px] text-muted";

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150 ${
        checked ? "bg-ink" : "bg-[#d8d8d8]"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all duration-150 ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

export function ContextSettingsCard() {
  const [settings, setSettings] = useState<ContextSettings>(() => loadContextSettings());

  /** 单点写入口：落盘结果（含字段校验后的合并值）回灌组件状态，UI 与存储始终一致。 */
  const update = (patch: Partial<ContextSettings>) => {
    setSettings(saveContextSettings(patch));
  };

  const onNumber = (key: "budgetTokens" | "keepRecentTurns", raw: string) => {
    const value = Number(raw);
    if (Number.isFinite(value)) update({ [key]: value });
  };

  return (
    <section className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="text-[12px] font-bold text-[#777]">上下文预算</div>
      <div className={`mt-1 ${hintCls}`}>
        给 @ 触发组装的历史做 token 预算，超出的早期对话压缩为摘要；只在本机执行
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px]">启用上下文预算</span>
        <Switch
          label="启用上下文预算"
          checked={settings.enabled}
          onChange={(next) => update({ enabled: next })}
        />
      </div>
      {!settings.enabled && (
        <div className={`mt-1 ${hintCls}`}>已关闭：@ 触发时历史按原样发送，不压缩、不摘要</div>
      )}

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <label className={labelCls}>
          预算
          <select
            aria-label="预算"
            value={String(settings.budgetTokens)}
            onChange={(e) => onNumber("budgetTokens", e.target.value)}
            className={selectCls}
          >
            {/* 手改过/历史遗留的非预设值照样如实显示，不静默改写 */}
            {!BUDGET_OPTIONS.includes(settings.budgetTokens) && (
              <option value={String(settings.budgetTokens)}>
                {settings.budgetTokens} token（自定义）
              </option>
            )}
            {BUDGET_OPTIONS.map((n) => (
              <option key={n} value={String(n)}>
                {n} token
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          保留轮数
          <select
            aria-label="保留轮数"
            value={String(settings.keepRecentTurns)}
            onChange={(e) => onNumber("keepRecentTurns", e.target.value)}
            className={selectCls}
          >
            {!TURN_OPTIONS.includes(settings.keepRecentTurns) && (
              <option value={String(settings.keepRecentTurns)}>
                {settings.keepRecentTurns} 轮（自定义）
              </option>
            )}
            {TURN_OPTIONS.map((n) => (
              <option key={n} value={String(n)}>
                {n} 轮
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px]">用模型生成早期摘要</span>
        <Switch
          label="用模型生成早期摘要"
          checked={settings.llmSummary}
          onChange={(next) => update({ llmSummary: next })}
        />
      </div>
      {!settings.llmSummary && (
        <div className={`mt-1 ${hintCls}`}>已关闭：只用零成本确定性摘要，不发额外请求</div>
      )}

      <div className="mt-3 border-t border-line-soft pt-2 text-[11px] text-muted">
        设置仅保存在本机浏览器，不上传和鸣服务端；改动即时生效，无需保存
      </div>
    </section>
  );
}
