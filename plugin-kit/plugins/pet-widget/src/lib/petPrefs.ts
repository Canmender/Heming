/**
 * 桌宠的本机偏好（d.46 起；d.98 拆插件后改由宿主持有，widget 只读）。
 *
 * ★ 与拆分前的最大区别：**不再读 localStorage**。桌宠跑在独立 origin
 *   `widget://heming.pet/...` 下，读不到 `app://heming` 的键；设置值由宿主的
 *   通用设置表单写 `userData/plugins/heming.pet/settings.json`，widget 经
 *   `settings() / onSettings()` 拿到。这里负责**把不可信的值收敛成确定的偏好**。
 *
 * 字段名是契约的一部分（宿主迁移旧 `heming.pet.v1` 时按同一组 key 写入）：
 *   `agentId` / `modelPath` / `presence`
 */

/** 默认模型：官方示例 Hiyori（随插件包分发，见 public/pet/README.md）。 */
export const DEFAULT_PET_MODEL = "pet/Hiyori/Hiyori.model3.json";

/** 打扰强度（与宿主设置表单的 select 选项一一对应）。 */
export type PetPresenceIntensity = "quiet" | "normal" | "eager";

export interface PetWidgetSettings {
  /** 绑定的智能体 id；null = 交给宿主按默认选择。 */
  agentId: string | null;
  /** 模型路径（相对插件包 files/ 根）。 */
  modelPath: string;
  presence: PetPresenceIntensity;
}

export const DEFAULT_PET_SETTINGS: Readonly<PetWidgetSettings> = Object.freeze({
  agentId: null,
  modelPath: DEFAULT_PET_MODEL,
  presence: "normal",
});

/** 设置键名（迁移与表单按这份清单对齐，改名前先改契约）。 */
export const PET_SETTING_KEYS = Object.freeze({
  agentId: "agentId",
  modelPath: "modelPath",
  presence: "presence",
});

const INTENSITIES: ReadonlyArray<PetPresenceIntensity> = ["quiet", "normal", "eager"];

export function isPetPresenceIntensity(value: unknown): value is PetPresenceIntensity {
  return typeof value === "string" && (INTENSITIES as readonly string[]).includes(value);
}

/**
 * 模型路径白名单校验。
 *
 * 与宿主 `resolveAssetPath` 同一套口径：相对路径、不越界、必须是 `.model3.json`。
 * 两侧都要挡——widget 负责不让脏值进 URL，宿主负责不让脏值进磁盘寻址。
 */
export function isValidModelPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const raw = path.trim();
  if (!raw || raw.length > 200) return false;
  if (raw.startsWith("/") || raw.startsWith("\\\\")) return false;
  if (raw.includes(":") || raw.includes("//")) return false;
  const parts = raw.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (!/\.model3?\.json$/i.test(raw)) return false;
  return /^[\p{L}\p{N}\-_. /]+$/u.test(raw.replace(/\\/g, "/"));
}

/**
 * 把宿主 settings 收敛成桌宠偏好：坏数据**逐字段回落默认**，绝不整份丢弃
 * （用户只写坏一个字段时不该把其它设置也弄没）。
 */
export function normalizePetSettings(
  raw: Record<string, unknown> | null | undefined,
): PetWidgetSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PET_SETTINGS };
  const agentId =
    typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : null;
  const modelPath = isValidModelPath(raw.modelPath) ? (raw.modelPath as string) : DEFAULT_PET_MODEL;
  const presence = isPetPresenceIntensity(raw.presence)
    ? raw.presence
    : DEFAULT_PET_SETTINGS.presence;
  return { agentId, modelPath, presence };
}

/** 把模型相对路径拼成可 fetch 的地址（与当前 widget origin 同源）。 */
export function petModelUrl(modelPath: string, origin: string): string {
  const path = isValidModelPath(modelPath) ? modelPath : DEFAULT_PET_MODEL;
  const base = origin.replace(/\/$/, "");
  return `${base}/${path}`;
}
