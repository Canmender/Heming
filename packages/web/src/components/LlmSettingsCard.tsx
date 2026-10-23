import { useState } from "react";
import { useLlmStore, type LlmProfile, type LlmProvider } from "../store/llm.js";
import { testConnection } from "../lib/llmClient.js";
import { LLM_PRESETS, findPreset } from "../lib/llmPresets.js";
import {
  PRICING_DISCLAIMER,
  capabilityBadges,
  clearOverride,
  lookupCapability,
  setOverride,
} from "../lib/modelCaps.js";

/** 设置区 · LLM 连接：本机 CRUD + 连通性测试；Key 只落 localStorage 不出设备。 */

const BASE_PLACEHOLDER: Record<LlmProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

type TestState = { status: "pending" | "ok" | "fail"; detail?: string };

function newId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]";
const labelCls = "block text-[12px] text-muted";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";

export function LlmSettingsCard() {
  const profiles = useLlmStore((s) => s.profiles);
  const bindings = useLlmStore((s) => s.bindings);
  const addProfile = useLlmStore((s) => s.addProfile);
  const updateProfile = useLlmStore((s) => s.updateProfile);
  const removeProfile = useLlmStore((s) => s.removeProfile);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<LlmProvider>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 手动填写能力的模型 id（key = `${provider}:${model}`）。 */
  const [editingCaps, setEditingCaps] = useState<string | null>(null);
  /** 手动填写的上下文窗口（token）。 */
  const [capsWindow, setCapsWindow] = useState("");

  /** 某个连接的能力：查不到时返回 null（界面显示「能力未知」）。 */
  const capsOf = (p: LlmProfile) => lookupCapability(p.provider, p.model);

  /** 打开手动填写：回填当前已知的窗口。 */
  const openCapsEditor = (p: LlmProfile) => {
    setEditingCaps(`${p.provider}:${p.model}`);
    const known = capsOf(p);
    setCapsWindow(known ? String(known.contextWindow) : "");
  };

  /** 保存手动填写的能力（只改上下文窗口这一项）。 */
  const saveCaps = (p: LlmProfile) => {
    const n = Number(capsWindow);
    if (Number.isFinite(n) && n >= 1) {
      setOverride(p.provider, p.model, { contextWindow: Math.floor(n) });
    } else {
      clearOverride(p.provider, p.model);
    }
    setEditingCaps(null);
  };

  const resetForm = () => {
    setOpen(false);
    setEditingId(null);
    setLabel("");
    setProvider("openai");
    setBaseUrl("");
    setModel("");
    setApiKey("");
    setTemperature("");
    setError(null);
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openEdit = (p: LlmProfile) => {
    setEditingId(p.id);
    setLabel(p.label);
    setProvider(p.provider);
    setBaseUrl(p.baseUrl ?? "");
    setModel(p.model);
    setApiKey(p.apiKey);
    setTemperature(p.temperature === undefined ? "" : String(p.temperature));
    setError(null);
    setConfirmId(null);
    setOpen(true);
  };

  /** 点预设：填好协议 / Base URL / 模型，并展开表单（用户仍可继续改）。 */
  const applyPreset = (presetId: string) => {
    const preset = findPreset(presetId);
    if (!preset) return;
    setProvider(preset.provider);
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    if (!label.trim()) setLabel(preset.label);
    setError(null);
    setOpen(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !model.trim() || !apiKey.trim()) {
      setError("请填写名称、模型与 API Key");
      return;
    }
    // F1 表单层拦截：缺 scheme 的 baseUrl 交给 buildRequest 会变相对路径（Key 打到自有域）
    if (baseUrl.trim() && !/^https?:\/\//.test(baseUrl.trim())) {
      setError("Base URL 需以 http:// 或 https:// 开头");
      return;
    }
    let temp: number | undefined;
    if (temperature.trim() !== "") {
      temp = Number(temperature);
      if (Number.isNaN(temp)) {
        setError("温度需为数字");
        return;
      }
    }
    const data = {
      label: label.trim(),
      provider,
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim(),
      apiKey: apiKey.trim(),
      temperature: temp,
    };
    if (editingId) updateProfile(editingId, data);
    else addProfile({ id: newId(), ...data });
    resetForm();
  };

  const onTest = async (p: LlmProfile) => {
    setTests((t) => ({ ...t, [p.id]: { status: "pending" } }));
    const r = await testConnection(p);
    setTests((t) => ({
      ...t,
      [p.id]: r.ok ? { status: "ok" } : { status: "fail", detail: r.error },
    }));
  };

  const onRemove = (id: string) => {
    removeProfile(id);
    setConfirmId(null);
    setTests((t) => {
      const next = { ...t };
      delete next[id];
      return next;
    });
  };

  const boundCount = (profileId: string) =>
    Object.values(bindings).filter((pid) => pid === profileId).length;

  return (
    <section className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-bold text-[#777]">LLM 连接</div>
        {!open && (
          <button type="button" onClick={openCreate} className={btnGhost}>
            ＋ 新建连接
          </button>
        )}
      </div>
      <div className="mt-1 text-[11px] text-muted">API Key 仅存本机浏览器，不上传和鸣服务端</div>

      {/* 常用服务商：一点填好协议/地址/模型；私有部署仍可手填，预设不限制 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted">常用服务商</span>
        {LLM_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-label={`套用预设 ${preset.label}`}
            title={preset.note}
            onClick={() => applyPreset(preset.id)}
            className={btnGhost}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {profiles.length === 0 && !open && (
        <div className="mt-3 text-[12px] text-muted">还没有 LLM 连接</div>
      )}

      {profiles.map((p) => {
        const t = tests[p.id];
        // 能力：查不到就是「能力未知」（不猜——猜错会让供应商 400）
        const caps = capsOf(p);
        const badges = caps ? capabilityBadges(caps) : [];
        return (
          <div key={p.id} className="mt-3 rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold">{p.label}</div>
                <div className="mt-0.5 truncate text-[12px] text-muted">
                  {p.provider} · {p.model} · ••••{p.apiKey.slice(-4)}
                </div>
                {/* 能力徽标：函数调用 / 视觉 / 思考 / 长上下文 / 并行工具 / 结构化输出。
                    查不到就说「能力未知」并给手填入口。
                    这几维只是选型参考；真正驱动「判定 → 丢弃」的只有工具与视觉两维。 */}
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-[#aaa]">模型能力（选型参考）</span>
                  {!caps ? (
                    <>
                      <span className="text-[11px] text-[#b45309]">能力未知</span>
                      <button
                        type="button"
                        onClick={() => openCapsEditor(p)}
                        className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:bg-[#fafafa] "
                      >
                        手动填写
                      </button>
                    </>
                  ) : (
                    <>
                      {badges.length === 0 ? (
                        <span className="text-[11px] text-muted">纯文本模型</span>
                      ) : (
                        badges.map((b) => (
                          <span
                            key={b}
                            className="rounded bg-[#f3f3f3] px-1 text-[10px] text-[#666] "
                          >
                            {b}
                          </span>
                        ))
                      )}
                      <span className="text-[10px] text-[#aaa]">
                        上下文 {Math.round(caps.contextWindow / 1000)}K
                      </span>
                      {caps.pricing ? (
                        <span className="text-[10px] text-[#aaa]">
                          ¥{caps.pricing.input}/¥{caps.pricing.output} 每百万 token
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => openCapsEditor(p)}
                        className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:bg-[#fafafa] "
                      >
                        修改
                      </button>
                    </>
                  )}
                </div>
                {caps?.pricing ? (
                  <div className="mt-0.5 text-[10px] text-[#bbb]">{PRICING_DISCLAIMER}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => void onTest(p)} className={btnGhost}>
                  测试
                </button>
                <button type="button" onClick={() => openEdit(p)} className={btnGhost}>
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmId(p.id)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-red-600 shadow-card transition-colors duration-150 hover:bg-[#fafafa]"
                >
                  删除
                </button>
              </div>
            </div>

            {t && (
              <div
                role="status"
                className={`mt-2 text-[12px] ${
                  t.status === "fail" ? "text-red-600" : "text-muted"
                }`}
              >
                {t.status === "pending" && "测试中…"}
                {t.status === "ok" && "测试通过"}
                {t.status === "fail" && `测试失败${t.detail ? `：${t.detail}` : ""}`}
              </div>
            )}

            {editingCaps === `${p.provider}:${p.model}` && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[#fafafa] px-3 py-2">
                <label className="text-[12px]">
                  上下文窗口（token）
                  <input
                    type="number"
                    min={1}
                    aria-label="上下文窗口（token）"
                    value={capsWindow}
                    onChange={(e) => setCapsWindow(e.target.value)}
                    className="ml-2 w-[140px] rounded-lg border border-line px-2 py-1 text-[12px] outline-none focus:border-[#bbb]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => saveCaps(p)}
                  className="rounded-lg bg-ink px-3 py-1 text-[12px] font-bold text-white"
                >
                  保存
                </button>
                <button type="button" onClick={() => setEditingCaps(null)} className={btnGhost}>
                  取消
                </button>
              </div>
            )}

            {confirmId === p.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[#fdf6f6] px-3 py-2">
                <span className="text-[12px] text-red-600">
                  删除后，已绑定该连接的智能体将失联并清绑定
                  {boundCount(p.id) > 0 ? `（当前 ${boundCount(p.id)} 个）` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(p.id)}
                  className="rounded-lg bg-ink px-3 py-1 text-[12px] font-bold text-white"
                >
                  确认删除
                </button>
                <button type="button" onClick={() => setConfirmId(null)} className={btnGhost}>
                  取消
                </button>
              </div>
            )}
          </div>
        );
      })}

      {open && (
        <form onSubmit={submit} className="mt-3 rounded-lg border border-line p-3">
          <div className="mb-2 text-[13px] font-bold">{editingId ? "编辑连接" : "新建连接"}</div>
          <div className="flex flex-col gap-3">
            <label className={labelCls}>
              服务商
              <select
                aria-label="服务商"
                value={provider}
                onChange={(e) => setProvider(e.target.value as LlmProvider)}
                className={inputCls}
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label className={labelCls}>
              名称
              <input
                aria-label="名称"
                value={label}
                maxLength={64}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如：我的 Claude"
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Base URL
              <input
                aria-label="Base URL"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={BASE_PLACEHOLDER[provider]}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              模型
              <input
                aria-label="模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider === "openai" ? "deepseek-chat" : "claude-sonnet-5"}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              API Key
              <input
                aria-label="API Key"
                type="password"
                value={apiKey}
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              温度（可选）
              <input
                aria-label="温度（可选）"
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="默认由模型决定"
                className={inputCls}
              />
            </label>
          </div>
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
    </section>
  );
}
