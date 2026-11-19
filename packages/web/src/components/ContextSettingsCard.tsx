import { useState } from "react";
import {
  loadContextSettings,
  saveContextSettings,
  type ContextSettings,
} from "../lib/agentContext/settings.js";
import {
  COMPACT_RETAIN_RATIO,
  COMPACT_THRESHOLD_RATIO,
  applyModelBudget,
  compactSpec,
} from "../lib/agentContext/modelBudget.js";
import { useLlmStore } from "../store/llm.js";
import { lookupCapability } from "../lib/modelCaps.js";
import { Switch } from "./ui/Switch.js";

/**
 * 设置区 · 上下文（d.351）：预算不再让用户自选，按 DSH 的压缩规则从模型窗口算。
 *
 * 为什么删掉「预算 / 保留轮数」两个下拉：它们看起来像调优，实际只有两个结果——
 * 调低 = 长对话更早被压成摘要（用户感受到的是「失忆」）；调高 = 越过窗口换一次 400。
 * 真正决定安全值的只有模型窗口，那个数字用户改不了，也不该改。
 *
 * 这里只保留两个真正是「偏好」的开关：是否启用预算、是否用模型生成摘要；
 * 生效数值只读展示，并写清它们从哪来。
 */

const labelCls = "ui-caption";
const hintCls = "ui-caption";

/** token 数的紧凑写法：128000 → 128K，55296 → 55.3K。 */
function formatTokens(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 100) / 10}K`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

export function ContextSettingsCard() {
  const [settings, setSettings] = useState<ContextSettings>(() => loadContextSettings());
  const profiles = useLlmStore((s) => s.profiles);

  /** 当前模型的上下文窗口上限（取第一个连接）。 */
  const model = profiles[0];
  const caps = model ? lookupCapability(model.provider, model.model) : null;
  const spec = compactSpec(caps);
  /** 与 `ChatPage` 送进 `prepareHistory` 的是同一个函数：显示的数字就是跑起来的数字。 */
  const effective = applyModelBudget(settings, caps);

  const update = (patch: Partial<ContextSettings>) => {
    setSettings(saveContextSettings(patch));
  };

  return (
    <section className="ui-card mt-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <div className="text-ui-sm font-semibold text-muted">上下文预算</div>
      </div>
      <div className={`mt-1 ${hintCls}`}>
        按 DSH 的压缩规则，从模型上下文窗口自动算；只在本机执行
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

      {/* 只读的规则展示：用户看得到「为什么是这个数」，但没有可改的旋钮。 */}
      <div className="mt-3 rounded-lg border border-line-soft bg-subtle-1 p-3">
        {spec ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-ui-sm text-ink">{model?.model}</span>
              <span className="text-ui-xs tabular-nums text-muted">
                窗口 {formatTokens(spec.contextWindow)} tokens
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ui-xs tabular-nums text-muted">
              <div className="flex justify-between gap-2">
                <dt>压缩阈值</dt>
                <dd className="text-ink">{formatTokens(effective.budgetTokens)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>保留原文</dt>
                <dd className="text-ink">{formatTokens(spec.retainTokens)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>最近轮数</dt>
                <dd className="text-ink">{effective.keepRecentTurns} 轮</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>摘要余量</dt>
                <dd className="text-ink">{formatTokens(spec.pressureBudgetTokens)}</dd>
              </div>
            </dl>
            <p className={`mt-2 ${hintCls}`}>
              阈值 = min(窗口 × {Math.round(COMPACT_THRESHOLD_RATIO * 100)}%, 窗口 − 输出预留 −
              摘要余量)；压缩时保留最近 {Math.round(COMPACT_RETAIN_RATIO * 100)}% 原文，其余折成摘要。
            </p>
          </>
        ) : (
          <p className={hintCls}>
            当前没有可用模型，先用默认 {formatTokens(effective.budgetTokens)} token /{" "}
            {effective.keepRecentTurns} 轮；连上模型后按它的窗口自动算。
          </p>
        )}
      </div>

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

      <div className={`mt-3 border-t border-line-soft pt-2 ${labelCls}`}>
        设置只保存在本机浏览器，不上传服务端
      </div>
    </section>
  );
}
