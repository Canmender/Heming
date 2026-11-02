import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatStore } from "../store/chat.js";
import {
  DEFAULT_PET_MODEL,
  isValidModelPath,
  loadPetPrefs,
  savePetPrefs,
  type PetPrefs,
} from "../lib/petPrefs.js";
import {
  loadPetPresencePrefs,
  savePetPresencePrefs,
  type PetPresenceIntensity,
  type PetPresencePrefs,
} from "../lib/petEvent.js";

/**
 * 设置区「桌宠」卡（d.46）。
 *
 * 只做三件事：开关桌宠、绑定它说话用的智能体、调它的呈现（缩放/穿透/模型）。
 * 缩放与窗口位置的真源在**主进程**（它们决定窗口像素尺寸），所以这里读 IPC 而不是
 * localStorage——两处各存一份，迟早出现"设置写着 1.25、窗口却是 1.0"。
 */

interface PetRuntimeState {
  visible: boolean;
  scale: number;
  clickThrough: boolean;
}

const SCALE_OPTIONS = [0.6, 0.8, 1.0, 1.25, 1.5];

/** 在场感三档打扰强度：文案与行为一一对应（安静不冒泡 / 正常冒泡 4 秒 / 积极加姿态与动作）。 */
const INTENSITY_OPTIONS: ReadonlyArray<{
  value: PetPresenceIntensity;
  label: string;
  hint: string;
}> = [
  { value: "quiet", label: "安静", hint: "只换姿态，不冒泡" },
  { value: "normal", label: "正常", hint: "冒泡 4 秒后收回（默认）" },
  { value: "eager", label: "积极", hint: "姿态 + 气泡 + 轻微动作" },
];

function intensityHint(value: PetPresenceIntensity): string {
  return INTENSITY_OPTIONS.find((option) => option.value === value)?.hint ?? "";
}

function scaleLabel(s: number): string {
  return `${Math.round(s * 100)}%`;
}

export function PetSettingsCard() {
  const available = typeof window !== "undefined" && !!window.__heming_pet;
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);

  const [prefs, setPrefs] = useState<PetPrefs>(() => loadPetPrefs());
  const [runtime, setRuntime] = useState<PetRuntimeState | null>(null);
  const [presence, setPresence] = useState<PetPresencePrefs>(() => loadPetPresencePrefs());
  const [modelDraft, setModelDraft] = useState(prefs.modelPath);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.__heming_pet) return;
    try {
      const s = await window.__heming_pet.state();
      setRuntime({ visible: s.visible, scale: s.scale, clickThrough: s.clickThrough });
    } catch {
      /* 主进程未就绪：保持上一次读到的值 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 名册只在需要选智能体时才有用，进卡再拉，不占用首屏
  useEffect(() => {
    if (!available) return;
    void loadAgentsRoster().catch(() => {
      /* 名册拉不到时下拉框为空，不影响开关桌宠 */
    });
  }, [available, loadAgentsRoster]);

  const updatePrefs = useCallback((patch: Partial<PetPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePetPrefs(next);
      return next;
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }, []);

  /** 打扰强度改完立即生效：桌宠每次收到事件都现读 localStorage，不必重载窗口。 */
  const updateIntensity = useCallback((value: PetPresenceIntensity) => {
    setPresence((prev) => {
      const next: PetPresencePrefs = { ...prev, intensity: value };
      savePetPresencePrefs(next);
      return next;
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }, []);

  const toggleEnabled = useCallback(
    (on: boolean) => {
      updatePrefs({ enabled: on });
      if (on) window.__heming_pet?.show();
      else window.__heming_pet?.hide();
      void refresh();
    },
    [updatePrefs, refresh],
  );

  const applyModel = useCallback(() => {
    const value = modelDraft.trim();
    if (!isValidModelPath(value)) {
      setModelError("请输入相对路径，形如 pet/Hiyori/Hiyori.model3.json");
      return;
    }
    setModelError(null);
    updatePrefs({ modelPath: value });
    // 模型地址是页面加载时读的，必须重载桌宠页面才会重新拉资源
    window.__heming_pet?.reload();
  }, [modelDraft, updatePrefs]);

  const agentOptions = useMemo(
    () => agentsRoster.map((a) => ({ id: a.id, name: a.name })),
    [agentsRoster],
  );

  const visible = runtime?.visible ?? false;

  return (
    <section
      aria-label="桌宠"
      className="mb-4 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-bold text-[#777]">桌宠</span>
        {saved && (
          <span role="status" className="text-[11px] text-muted">
            已保存
          </span>
        )}
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-muted">
        在桌面上放一个和鸣的化身：点它就能说话，拖它能换位置。
        {!available && " 仅桌面端可用。"}
      </div>

      {!available ? (
        <p className="mt-3 rounded-lg bg-[#f7f7f7] px-3 py-2 text-[11.5px] text-[#888]">
          浏览器里没有桌面窗口能力，桌宠只在安装版里出现。
        </p>
      ) : (
        <>
          {/* 开关 */}
          <label className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-ink">在桌面显示桌宠</span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={prefs.enabled}
              checked={prefs.enabled}
              onChange={(e) => toggleEnabled(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent,#2f5bd7)]"
            />
          </label>

          {/* 显示状态 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                window.__heming_pet?.show();
                void refresh();
              }}
              disabled={visible}
              className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-ink disabled:opacity-40"
            >
              显示
            </button>
            <button
              type="button"
              onClick={() => {
                window.__heming_pet?.hide();
                void refresh();
              }}
              disabled={!visible}
              className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-ink disabled:opacity-40"
            >
              隐藏
            </button>
            <span className="text-[11px] text-muted">
              {visible ? "当前显示中" : "当前已隐藏"}
            </span>
          </div>

          {/* 打扰强度（在场感三档） */}
          <div className="mt-3.5">
            <div className="text-[12px] font-bold text-[#777]">打扰强度</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="打扰强度">
              {INTENSITY_OPTIONS.map((option) => {
                const active = presence.intensity === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateIntensity(option.value)}
                    className={`rounded-lg border px-2.5 py-1 text-[11.5px] ${
                      active
                        ? "border-[var(--accent,#2f5bd7)] text-ink"
                        : "border-line text-muted hover:text-ink"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-muted">
              {intensityHint(presence.intensity)}。任务收尾、日程临期与幕僚简报会让桌宠开口；
              主窗口在前台时只进通知中心，桌宠不打扰。
            </p>
          </div>

          {/* 缩放 */}
          <div className="mt-3.5">
            <div className="text-[12px] font-bold text-[#777]">大小</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {SCALE_OPTIONS.map((s) => {
                const active = Math.abs((runtime?.scale ?? 1) - s) < 0.001;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      window.__heming_pet?.setScale(s);
                      void refresh();
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-[11.5px] ${
                      active
                        ? "border-[var(--accent,#2f5bd7)] text-ink"
                        : "border-line text-muted hover:text-ink"
                    }`}
                  >
                    {scaleLabel(s)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 绑定智能体 */}
          <div className="mt-3.5">
            <label className="block text-[12px] font-bold text-[#777]" htmlFor="pet-agent">
              说话的智能体
            </label>
            <select
              id="pet-agent"
              value={prefs.agentId ?? ""}
              onChange={(e) => {
                updatePrefs({ agentId: e.target.value || null });
                window.__heming_pet?.reload();
              }}
              className="mt-1.5 w-full rounded-lg border border-line px-2 py-1.5 text-[12.5px] text-ink"
            >
              <option value="">默认（第一个可用模型连接）</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[11px] text-muted">
              用的是该智能体在「接口区」绑定的模型连接；没绑定就用第一个可用连接。
            </div>
          </div>

          {/* 模型 */}
          <div className="mt-3.5">
            <label className="block text-[12px] font-bold text-[#777]" htmlFor="pet-model">
              形象文件
            </label>
            <div className="mt-1.5 flex gap-1.5">
              <input
                id="pet-model"
                value={modelDraft}
                onChange={(e) => {
                  setModelDraft(e.target.value);
                  setModelError(null);
                }}
                placeholder={DEFAULT_PET_MODEL}
                className="min-w-0 flex-1 rounded-lg border border-line px-2 py-1.5 text-[12px] text-ink"
              />
              <button
                type="button"
                onClick={applyModel}
                className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-ink"
              >
                应用
              </button>
              <button
                type="button"
                onClick={() => {
                  setModelDraft(DEFAULT_PET_MODEL);
                  updatePrefs({ modelPath: DEFAULT_PET_MODEL });
                  setModelError(null);
                  window.__heming_pet?.reload();
                }}
                className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-muted"
              >
                默认
              </button>
            </div>
            {modelError ? (
              <p role="alert" className="mt-1 text-[11px] text-[#b42318]">
                {modelError}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-muted">
                相对路径，指向标准的 Cubism 3/4 模型清单（.model3.json）。换形象只换这个路径。
              </p>
            )}
          </div>

          {/* 穿透 */}
          <label className="mt-3.5 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-ink">
              鼠标穿透
              <span className="ml-1 text-[11px] text-muted">（不挡桌面点击）</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={runtime?.clickThrough ?? true}
              checked={runtime?.clickThrough ?? true}
              onChange={(e) => {
                window.__heming_pet?.setClickThrough(e.target.checked);
                void refresh();
              }}
              className="h-4 w-4 accent-[var(--accent,#2f5bd7)]"
            />
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            开启时只有角色和气泡能点到，空白处的点击会穿透到桌面。
            关掉后整个窗口都会接收鼠标——如果发现角色点不中，先关掉它试试。
          </p>
        </>
      )}
    </section>
  );
}
