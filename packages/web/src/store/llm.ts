import { create } from "zustand";
import { secureGetItem, secureSetItem } from "../lib/secureStorage.js";

/**
 * LLM 连接本机存储：Key 走系统安全存储（桌面端就地信封，见 lib/secureStorage.ts），
 * 绑定/提示词仍在普通 localStorage；三键都只写本机，绝不上传自有服务端
 *（红线见 lib/llmClient.ts——请求目标只随 profile.baseUrl）。
 */
export type LlmProvider = "openai" | "anthropic";

export interface LlmProfile {
  id: string;
  label: string;
  provider: LlmProvider;
  baseUrl?: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

const KEY_CONFIGS = "heming.llmConfigs";
const KEY_BINDINGS = "heming.agentLlm";
const KEY_PROMPTS = "heming.agentPrompts";

function loadJson<T>(key: string, fallback: T, pick: (raw: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return pick(JSON.parse(raw));
  } catch {
    return fallback; // 损坏数据回退空（与 tokenUsage 同策略）
  }
}

function loadProfiles(): LlmProfile[] {
  try {
    // 只有 llmConfigs 是凭据（直连供应商的付费 Key），走系统安全存储；
    // 绑定与提示词留在普通 localStorage——它们不是凭据，没必要过 IPC。
    const raw = secureGetItem(KEY_CONFIGS);
    if (!raw) return [];
    const profiles = (JSON.parse(raw) as { profiles?: unknown }).profiles;
    return Array.isArray(profiles) ? (profiles as LlmProfile[]) : [];
  } catch {
    return []; // 损坏数据回退空（与 tokenUsage 同策略）
  }
}

function loadRecord(key: string): Record<string, string> {
  return loadJson<Record<string, string>>(key, {}, (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {},
  );
}

const saveProfiles = (profiles: LlmProfile[]): void => {
  secureSetItem(KEY_CONFIGS, JSON.stringify({ profiles }));
};
const saveRecord = (key: string, value: Record<string, string>): void => {
  localStorage.setItem(key, JSON.stringify(value));
};

interface LlmState {
  profiles: LlmProfile[];
  bindings: Record<string, string>;
  prompts: Record<string, string>;
  addProfile: (p: LlmProfile) => void;
  updateProfile: (id: string, patch: Partial<LlmProfile>) => void;
  removeProfile: (id: string) => void;
  setBinding: (agentId: string, profileId: string | null) => void;
  setPrompt: (agentId: string, text: string) => void;
  getProfile: (id: string) => LlmProfile | undefined;
}

export const useLlmStore = create<LlmState>((set, get) => ({
  profiles: loadProfiles(),
  bindings: loadRecord(KEY_BINDINGS),
  prompts: loadRecord(KEY_PROMPTS),
  addProfile(p) {
    const profiles = [...get().profiles, p];
    saveProfiles(profiles);
    set({ profiles });
  },
  updateProfile(id, patch) {
    const profiles = get().profiles.map((x) => (x.id === id ? { ...x, ...patch, id } : x));
    saveProfiles(profiles);
    set({ profiles });
  },
  removeProfile(id) {
    const profiles = get().profiles.filter((x) => x.id !== id);
    saveProfiles(profiles);
    // 删连接即解绑：已绑定该连接的智能体失联（契约由 LlmSettingsCard 提示）
    const bindings = Object.fromEntries(
      Object.entries(get().bindings).filter(([, pid]) => pid !== id),
    );
    saveRecord(KEY_BINDINGS, bindings);
    set({ profiles, bindings });
  },
  setBinding(agentId, profileId) {
    const bindings = { ...get().bindings };
    if (profileId === null) delete bindings[agentId];
    else bindings[agentId] = profileId;
    saveRecord(KEY_BINDINGS, bindings);
    set({ bindings });
  },
  setPrompt(agentId, text) {
    const prompts = { ...get().prompts, [agentId]: text };
    saveRecord(KEY_PROMPTS, prompts);
    set({ prompts });
  },
  getProfile(id) {
    return get().profiles.find((x) => x.id === id);
  },
}));
