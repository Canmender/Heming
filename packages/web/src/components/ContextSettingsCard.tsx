import { useState } from "react";
import {
  loadContextSettings,
  saveContextSettings,
  type ContextSettings,
} from "../lib/agentContext/settings.js";
import {
  BUDGET_WINDOW_RATIO,
  MAX_AUTO_BUDGET,
  applyModelBudget,
} from "../lib/agentContext/modelBudget.js";
import { useLlmStore } from "../store/llm.js";
import { lookupCapability } from "../lib/modelCaps.js";
import { Switch } from "./ui/Switch.js";

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
 * 历史预算占模型上下文窗口的比例（d.160 起与 `modelBudget.ts` 同源）。
 *
 * 为什么不按 100% 算：上下文里还有系统提示词、工具声明、这一轮的 user 轮，
 * 全拿去放历史必然超窗——超了供应商就 400，用户看到的是一句莫名其妙的报错。
 */
const BUDGET_RATIO = BUDGET_WINDOW_RATIO;

const labelCls = "ui-caption";
const selectCls =
  "mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-ink";
const hintCls = "ui-caption";

/* 开关已抽到 ui/Switch.tsx（d.138）：与记忆页、技能页的三份逐字节相同拷贝合并。 */

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
  /**
   * 自动档真正生效的预算与轮数（d.160）：与 `ChatPage` 里送进 `prepareHistory` 的
   * 是同一个函数，界面显示的数字必须就是跑起来用的数字，否则用户调完发现没效果。
   */
  const effective = applyModelBudget(settings, caps);

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
  const shownBudget =
    windowLimit && effective.budgetTokens > windowLimit ? windowLimit : effective.budgetTokens;
  /** 自动档下显示算出来的轮数；手动档用用户自己填的。 */
  const shownTurns = effective.keepRecentTurns;

  return (
    <section className="ui-card mt-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <div className="text-ui-sm font-semibold text-muted">上下文预算</div>
      </div>
      <div className={`mt-1 ${hintCls}`}>
        给 @ 触发组装的历史做 token 预算，超出的早期对话压缩为摘要；只在本机执行
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-ui-sm">启用上下文预算</span>
        <Switch
          label="启用上下文预算"
          checked={settings.enabled}
          onChange={(next) => update({ enabled: next })}
        />
      </div>
      {!settings.enabled && (
        <div className={`mt-1 ${hintCls}`}>已关闭：@ 触发时历史按原样发送，不压缩、不摘要</div>
      )}

      {/* d.160：预算按真实模型窗口分配——长对话不再被 6K 固定预算切碎 */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-ui-sm">按模型上下文窗口自动分配</span>
        <Switch
          label="按模型上下文窗口自动分配"
          checked={settings.autoBudget}
          onChange={(next) => update({ autoBudget: next })}
        />
      </div>
      <div className={`mt-1 ${hintCls}`}>
        {settings.autoBudget
          ? caps
            ? `按 ${model?.model} 的 ${caps.contextWindow} token 窗口算：历史预算 ${effective.budgetTokens} token、保留最近 ${effective.keepRecentTurns} 轮（上限 ${MAX_AUTO_BUDGET}）`
            : "当前没有可用模型，先用默认 6000 token / 8 轮；连上模型后按它的窗口自动调"
          : "已关闭：完全按下面手填的预算与轮数（仍会收敛到模型窗口允许的上限）"}
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <label className={labelCls}>
          预算
          <select
            aria-label="预算"
            value={String(shownBudget)}
            onChange={(e) => {
              // 手选预算 = 明确要手动档：不悄悄把开关拨回去，但要让用户知道自动档已让位。
              onNumber("budgetTokens", e.target.value);
              if (settings.autoBudget) update({ autoBudget: false });
            }}
            className={selectCls}
          >
            {/* 手改过/历史遗留的非预设值照样如实显示，不静默改写 */}
            {!budgetOptions.includes(shownBudget) &&
              (!windowLimit || shownBudget <= windowLimit) && (
                <option value={String(shownBudget)}>{shownBudget} token（自定义）</option>
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
            value={String(shownTurns)}
            onChange={(e) => {
              onNumber("keepRecentTurns", e.target.value);
              if (settings.autoBudget) update({ autoBudget: false });
            }}
            className={selectCls}
          >
            {!TURN_OPTIONS.includes(shownTurns) && (
              <option value={String(shownTurns)}>{shownTurns} 轮（自定义）</option>
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
          生效预算 {shownBudget} / 模型上限 {windowLimit} token（{model?.model}，按窗口 60% 计）
          {!settings.autoBudget && windowLimit > 0 && settings.budgetTokens > windowLimit ? (
            <span className="ml-1 text-warn">已超出上限，会收敛到上限</span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-ui-sm">用模型生成早期摘要</span>
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
        设置只保存在本机浏览器，不上传服务端
      </div>
    </section>
  );
}
