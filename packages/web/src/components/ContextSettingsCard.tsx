import { useState } from "react";
import {
  loadContextSettings,
  saveContextSettings,
  type ContextSettings,
} from "../lib/agentContext/settings.js";
import { useLlmStore } from "../store/llm.js";
import { lookupCapability } from "../lib/modelCaps.js";

/**
 * 设置区 · 上下文预算（设计 §5）：@ 触发链路的历史 token 预算与压缩开关。
 * 无保存按钮——每次改动即时落盘 `heming.context.v1`（本机 localStorage）；
 * 关闭总开关即「按原样发送」，行为回到加预算之前。
 */

/** 预算预设（token）。 */
const BUDGET_OPTIONS = [4000, 6000, 8000, 12000];
/** 原文保留轮数预设。 */
const TURN_OPTIONS = [2, 4, 8, 12];

/**
 * 预算占上下文窗口的比例（默认 60%）。
 *
 * 为什么不按 100% 算：上下文里还有系统提示词、工具声明、这一轮的 user 轮，
 * 全拿去放历史必然超窗——超了供应商就 400，用户看到的是一句莫名其妙的报错。
 */
const BUDGET_RATIO = 0.6;

const labelCls = "ui-caption";
const selectCls =
  "mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
const hintCls = "ui-caption";

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
        checked ? "bg-ink" : "bg-[color:var(--switch-off)]"
      }`}
    >
      <span
        style={{ backgroundColor: checked ? "var(--heming-on-accent)" : "var(--switch-knob)" }}
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all duration-150 ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

export function ContextSettingsCard() {
  const [settings, setSettings] = useState<ContextSettings>(() => loadContextSettings());
  const profiles = useLlmStore((s) => s.profiles);

  /**
   * 当前模型的上下文窗口上限（取第一个连接）。
   *
   * 只有一个连接时是准确的；多个连接时取第一个——界面会标出是哪个模型，
   * 用户自己清楚。查不到能力（未知模型）就不钳制，不猜。
   */
  const model = profiles[0];
  const caps = model ? lookupCapability(model.provider, model.model) : null;
  const windowLimit = caps ? Math.floor(caps.contextWindow * BUDGET_RATIO) : 0;

  /** 单点写入口：落盘结果（含字段校验后的合并值）回灌组件状态，UI 与存储始终一致。 */
  const update = (patch: Partial<ContextSettings>) => {
    setSettings(saveContextSettings(patch));
  };

  const onNumber = (key: "budgetTokens" | "keepRecentTurns", raw: string) => {
    const value = Number(raw);
    if (Number.isFinite(value)) update({ [key]: value });
  };

  /** 预算选项：上限之内才列（超窗的选项列出来就是坑用户）。 */
  const budgetOptions = windowLimit
    ? BUDGET_OPTIONS.filter((n) => n <= windowLimit)
    : BUDGET_OPTIONS;
  /** 当前值超限时把它也列出来（否则下拉里看不到当前值，用户以为设置丢了）。 */
  const shownBudget = windowLimit && settings.budgetTokens > windowLimit ? windowLimit : settings.budgetTokens;

  return (
    <section className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="text-[12px] font-bold text-muted">上下文预算</div>
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
            value={String(shownBudget)}
            onChange={(e) => onNumber("budgetTokens", e.target.value)}
            className={selectCls}
          >
            {/* 手改过/历史遗留的非预设值照样如实显示，不静默改写 */}
            {!budgetOptions.includes(settings.budgetTokens) &&
              (!windowLimit || settings.budgetTokens <= windowLimit) && (
                <option value={String(settings.budgetTokens)}>
                  {settings.budgetTokens} token（自定义）
                </option>
              )}
            {budgetOptions.map((n) => (
              <option key={n} value={String(n)}>
                {n} token
              </option>
            ))}
            {/* 窗口小到连最小预设都超：给一个「按上限」的可选项，别让下拉是空的 */}
            {windowLimit && budgetOptions.length === 0 && (
              <option value={String(windowLimit)}>{windowLimit} token（按模型上限）</option>
            )}
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

      {/* 预算与模型窗口的关系：超了就是白填（供应商会 400） */}
      {caps ? (
        <div className="mt-2 ui-caption">
          当前预算 {shownBudget} / 模型上限 {windowLimit} token（{model?.model}，按窗口 60% 计）
          {windowLimit > 0 && settings.budgetTokens > windowLimit ? (
            <span className="ml-1 text-[#b45309]">已超出上限，下面的选择会被收敛到上限</span>
          ) : null}
        </div>
      ) : null}

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

      <div className="mt-3 border-t border-line-soft pt-2 ui-caption">
        设置仅保存在本机浏览器，不上传和鸣服务端；改动即时生效，无需保存
      </div>
    </section>
  );
}
