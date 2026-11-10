import { useLlmStore } from "../store/llm.js";

/**
 * 设置区 · 后台任务模型（d.125）：归档、摘要、议程提取这类后台任务用哪个模型。
 *
 * 为什么要有单独一档：这些任务没人盯着，用主对话那个「最贵最好」的模型纯属浪费；
 * 用户在这里指定一个便宜的即可。只存模型 id，不存 Key——Key 仍走网关。
 * 空 = 不设置：插件不会自动调用模型（只做确定性摘要），行为可预期。
 */

const selectCls = "ui-input mt-1";

export function BackgroundModelCard() {
  const models = useLlmStore((s) => s.models);
  const backgroundModel = useLlmStore((s) => s.backgroundModel);
  const setBackgroundModel = useLlmStore((s) => s.setBackgroundModel);

  /** 已选模型是否还在目录里：目录换过（换网关/订阅变化）就会失效，要如实提示。 */
  const stale = backgroundModel !== null && !models.some((m) => m.id === backgroundModel);

  return (
    <section className="ui-card mt-3 p-4">
      <div className="text-[12px] font-medium text-muted">后台任务模型</div>
      <div className="mt-1 ui-caption">
        归档、摘要、议程提取等后台任务专用；不参与聊天，挑了便宜的就够
      </div>

      <label className="mt-3 block ui-caption">
        模型
        <select
          aria-label="后台任务模型"
          value={backgroundModel ?? ""}
          onChange={(e) => setBackgroundModel(e.target.value || null)}
          className={selectCls}
        >
          <option value="">不设置（插件不自动调用模型）</option>
          {/* 目录里已经没有的旧选择照实显示，不静默改写成别的模型 */}
          {stale && backgroundModel ? (
            <option value={backgroundModel}>{backgroundModel}（不在当前模型目录）</option>
          ) : null}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {models.length === 0 ? (
        <div className="mt-2 ui-caption">还没有模型目录：先在聊天页连上本机网关并刷新模型列表</div>
      ) : null}
      {stale ? (
        <div className="mt-2 ui-caption text-[var(--warn)]">
          所选模型已不在当前目录，后台任务会当作「未设置」处理，请重新选择
        </div>
      ) : null}

      <div className="mt-3 border-t border-line-soft pt-2 ui-caption">
        只在本机保存模型 id；模型 Key 仍由网关保管
      </div>
    </section>
  );
}
