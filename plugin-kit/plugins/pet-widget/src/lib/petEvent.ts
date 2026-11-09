import { poseForEvent, type PetPose } from "./petPose.js";
import type { PetPresenceIntensity } from "./petPrefs.js";

/**
 * 桌宠表达层：宿主事件 → 气泡/姿态。
 *
 * d.98 拆插件后本文件只剩**消费端**：
 * - 事件的**生产与渠道互斥**（主窗在前台只进通知中心、频控、错过不补发）仍留在宿主；
 *   宿主主窗脱敏后经 `window.__heming_widget.onEvent` 转发过来（规格 §3.4/§4.2）。
 * - 这里负责把载荷收敛成「一句话 + 一个姿态」，并保证 4 秒后自己收回。
 *
 * 两条入口都收：
 * 1. **规格 §3.4 的 `notify` 事件**（`{kind:"notify", title, summary, route, at}`）——
 *    宿主当前转发的是这个形状；
 * 2. 旧的 `pet:event` 契约（`speak/task/schedule/pose/reset`）——保留解析，
 *    宿主将来若原样转发旧事件不需要改插件，迁移期也能先用旧事件联调。
 *
 * ★ 边界不变：气泡只带「类型 + 标题级信息」，不带正文/附件/会话名/发送人；
 *   本文件不写任何存储（widget 没有 localStorage），也不调模型。
 */

/* ══════════════════════════ 1. 事件契约 ══════════════════════════ */

/** 点击气泡可直达的主窗页面（与宿主页面白名单一致）。 */
export type PetEventRoute = "team" | "tasks" | "staff" | "infohub" | "settings";

export type PetEventPayload =
  | { kind: "pose"; pose: PetPose }
  | { kind: "speak"; text: string; route?: PetEventRoute }
  | { kind: "task"; title: string; ok: boolean; route?: PetEventRoute }
  | { kind: "schedule"; title: string; at: string; route?: PetEventRoute }
  | { kind: "reset" };

const POSES: ReadonlyArray<PetPose> = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "alerting",
  "happy",
];

const ROUTES: ReadonlyArray<PetEventRoute> = ["team", "tasks", "staff", "infohub", "settings"];

export function isPetEventRoute(value: unknown): value is PetEventRoute {
  return typeof value === "string" && (ROUTES as readonly string[]).includes(value);
}

function isPose(value: unknown): value is PetPose {
  return typeof value === "string" && (POSES as readonly string[]).includes(value);
}

/** 文本字段的统一收敛：去空白、限长（跨进程来的长文本不该撑爆气泡）。 */
function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function withRoute(base: object, raw: unknown): object {
  const route = (raw as { route?: unknown }).route;
  return isPetEventRoute(route) ? { ...base, route } : base;
}

/** 校验并规整一条旧契约事件；不可用返回 null（调用方静默忽略）。 */
export function parsePetEvent(raw: unknown): PetEventPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = (raw as { kind?: unknown }).kind;

  if (kind === "pose") {
    const pose = (raw as { pose?: unknown }).pose;
    return isPose(pose) ? { kind: "pose", pose } : null;
  }
  if (kind === "speak") {
    const value = text((raw as { text?: unknown }).text);
    return value ? (withRoute({ kind: "speak", text: value }, raw) as PetEventPayload) : null;
  }
  if (kind === "task") {
    const title = text((raw as { title?: unknown }).title, 120);
    if (!title) return null;
    return withRoute(
      { kind: "task", title, ok: (raw as { ok?: unknown }).ok === true },
      raw,
    ) as PetEventPayload;
  }
  if (kind === "schedule") {
    const title = text((raw as { title?: unknown }).title, 120);
    const at = text((raw as { at?: unknown }).at, 64);
    if (!title || !at) return null;
    return withRoute({ kind: "schedule", title, at }, raw) as PetEventPayload;
  }
  if (kind === "reset") return { kind: "reset" };
  return null;
}

/**
 * 宿主转发的事件 → 内部契约。
 *
 * `notify` 的语义只有「已经决定要让用户知道的一件事」：
 * - 带 `at` ⇒ 按日程提醒（气泡「19:00 晚自习」）；
 * - 否则 ⇒ 按开口（优先 `summary`，没有就 `title`）。
 * 两者都不带就返回 null（不猜、不静默编一句话）。
 */
export function adaptWidgetEvent(raw: unknown): PetEventPayload | null {
  const legacy = parsePetEvent(raw);
  if (legacy) return legacy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const event = raw as { kind?: unknown; title?: unknown; summary?: unknown; route?: unknown; at?: unknown };
  if (event.kind !== "notify") return null;

  const title = text(event.title, 120);
  const at = text(event.at, 64);
  if (!title && !at) return null;
  if (at && title) {
    return withRoute({ kind: "schedule", title, at }, event) as PetEventPayload;
  }
  const summary = text(event.summary, 120);
  const spoken = summary ?? title;
  if (!spoken) return null;
  return withRoute({ kind: "speak", text: spoken }, event) as PetEventPayload;
}

/* ══════════════ 2. 事件 → 气泡文案 / 姿态（纯函数） ══════════════ */

/** 气泡单次显示时长：轻提示短、不打断（4 秒收回）。 */
export const PRESENCE_BUBBLE_MS = 4_000;
/** 单条气泡的硬上限：一句到两句、约 60 字（宿主侧 spec §1.3「开口」约束）。 */
export const PRESENCE_BUBBLE_MAX_CHARS = 60;

/** 压成一行并截断到上限（气泡不是文章）。 */
function bubbleClip(textValue: string, max = PRESENCE_BUBBLE_MAX_CHARS): string {
  const oneLine = textValue.replace(/\s+/g, " ").trim();
  const chars = [...oneLine];
  if (chars.length <= max) return oneLine;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** 气泡文案：只由「类型 + 标题级信息」拼出，绝不带结果正文/证据原文/会话名。 */
export function bubbleTextForEvent(ev: PetEventPayload): string | null {
  switch (ev.kind) {
    case "speak":
      return bubbleClip(ev.text);
    case "task":
      return bubbleClip(ev.ok ? `完成了：${ev.title}` : `没成功：${ev.title}`);
    case "schedule":
      return bubbleClip(`${ev.at} ${ev.title}`);
    default:
      return null;
  }
}

/** 桌宠侧的表达状态（气泡 + 外部姿态），全部带过期时间，避免卡在某个状态。 */
export interface PetBubbleState {
  text: string;
  route?: PetEventRoute;
  /** 到期时间（epoch ms）：由 `prunePetPresence` 清掉。 */
  until: number;
}

export interface PetPresenceVisual {
  pose: PetPose | null;
  poseUntil: number | null;
  bubble: PetBubbleState | null;
}

export const EMPTY_PET_PRESENCE: Readonly<PetPresenceVisual> = Object.freeze({
  pose: null,
  poseUntil: null,
  bubble: null,
});

/**
 * 把一个事件归约成桌宠表达状态（纯函数）。
 *
 * - 畸形事件 → 原样返回（无任何反应、不抛）；
 * - `reset` → 清空；
 * - 安静档：只换姿态、不冒泡；
 * - 正常档：只冒泡（4 秒后收回），不改姿态；
 * - 积极档：姿态 + 气泡；`happy` 姿态会顺带播一次 TapBody（由 PET_POSES 决定，渲染层无感）。
 *
 * `busy`（正在与用户对话/流式输出）时**不显示**新事件，由调用方排队到这轮结束再决定。
 */
export function reducePetEvent(
  prev: PetPresenceVisual,
  raw: unknown,
  opts: { now: number; intensity: PetPresenceIntensity; busy?: boolean },
): PetPresenceVisual {
  const ev = adaptWidgetEvent(raw);
  if (!ev) return prev;
  if (opts.busy) return prev;
  if (ev.kind === "reset") return { ...EMPTY_PET_PRESENCE };

  const now = opts.now;
  // 显式姿态覆盖：不受强度影响（它是发送方的明确表达，不是「开口」）。
  if (ev.kind === "pose") {
    return { ...prev, pose: ev.pose, poseUntil: now + PRESENCE_BUBBLE_MS };
  }

  const textValue = bubbleTextForEvent(ev);
  if (!textValue) return prev;

  if (opts.intensity === "quiet") {
    // 安静：只换姿态，不冒泡（安静档下不该有任何桌面文字）。
    return { pose: poseForEvent(ev), poseUntil: now + PRESENCE_BUBBLE_MS, bubble: null };
  }

  const route = (ev as { route?: unknown }).route;
  const bubble: PetBubbleState = {
    text: textValue,
    ...(isPetEventRoute(route) ? { route } : {}),
    until: now + PRESENCE_BUBBLE_MS,
  };
  if (opts.intensity === "normal") {
    return { pose: null, poseUntil: null, bubble };
  }
  return { pose: poseForEvent(ev), poseUntil: now + PRESENCE_BUBBLE_MS, bubble };
}

/** 清掉已过期的气泡/姿态（渲染层定时调用；纯函数，便于单测）。 */
export function prunePetPresence(state: PetPresenceVisual, now: number): PetPresenceVisual {
  const bubble = state.bubble && state.bubble.until > now ? state.bubble : null;
  const pose = state.pose && state.poseUntil !== null && state.poseUntil > now ? state.pose : null;
  const poseUntil = pose ? state.poseUntil : null;
  if (bubble === state.bubble && pose === state.pose) return state;
  return { pose, poseUntil, bubble };
}
