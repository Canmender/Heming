import { poseForEvent, type PetPose } from "./petPose.js";
import { agendaBucket } from "./agendaBucket.js";
import { useNotificationStore } from "../store/notifications.js";

/**
 * 主进程 ↔ 桌宠的事件契约 + 在场感（presence）编排（d.53 预留 → d.58 接线）。
 *
 * 两层职责刻意分开：
 * 1. **契约层**（既有）：`PetEventPayload` 与 `parsePetEvent`，跨进程不可信载荷必须先过校验；
 * 2. **在场感层**（本轮）：决定「平台事件该不该让桌宠开口」——渠道互斥（主窗口在前台时
 *    只走通知中心）、三档打扰强度、10 分钟频控、错过不补发、只带标题级文案。
 *
 * ★ 边界（与主进程 `pet-host.js` 的 pushEvent / pet:emit 对齐）：
 *   - 通道单向（主进程 → 桌宠）；桌宠要主窗口做事仍走 `pet:open-settings`（复用它承载 page）。
 *   - payload 跨进程一律不可信；畸形事件静默忽略——桌宠没有控制台给用户看。
 *   - 本文件**不写会话、不进消息列表、不落 msgCache**：事件只在内存流转。
 *   - 事件语义来自「已经决定要发」的那一步（通知中心），这里只决定出口，不重算静默时段/预算。
 */

/* ══════════════════════════ 1. 事件契约 ══════════════════════════ */

/** 点击气泡可直达的主窗口页面（与 `store/ui.ts` 的 Page 子集对齐）。 */
export type PetEventRoute = "team" | "tasks" | "staff" | "infohub" | "settings";

export type PetEventPayload =
  /** 手动指定姿态（发送方负责收尾；桌宠侧也会在 4 秒后自行回落） */
  | { kind: "pose"; pose: PetPose }
  /** 让桌宠显示一句话（不调模型，纯展示） */
  | { kind: "speak"; text: string; route?: PetEventRoute }
  /** 任务收尾提醒（只带任务标题，不带结果正文） */
  | { kind: "task"; title: string; ok: boolean; route?: PetEventRoute }
  /** 日程临期提醒（只带标题 + HH:MM，不带日程证据原文） */
  | { kind: "schedule"; title: string; at: string; route?: PetEventRoute }
  /** 清掉临时表达（气泡/姿态），回到自行判定的状态 */
  | { kind: "reset" };

/** 合法姿态集合：与 `PET_POSES` 的键保持一致，校验时用。 */
const POSES: ReadonlyArray<PetPose> = ["idle", "listening", "thinking", "speaking", "alerting", "happy"];

/** 合法路由：不在表里就当没给（整条事件照常可用）。 */
export const PET_EVENT_ROUTES: ReadonlyArray<PetEventRoute> = ["team", "tasks", "staff", "infohub", "settings"];

export function isPetEventRoute(value: unknown): value is PetEventRoute {
  return typeof value === "string" && (PET_EVENT_ROUTES as readonly string[]).includes(value);
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

/** 事件里的可选 route：合法才带上（保证旧事件形状不变，测试断言不会多出字段）。 */
function withRoute(base: object, raw: unknown): object {
  const route = (raw as { route?: unknown }).route;
  return isPetEventRoute(route) ? { ...base, route } : base;
}

/**
 * 校验并规整一个跨进程事件（纯函数）。
 *
 * 返回 null 表示这条事件不可用——调用方应当**静默忽略**，而不是弹错。
 */
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
    const ok = (raw as { ok?: unknown }).ok;
    if (!title) return null;
    return withRoute({ kind: "task", title, ok: ok === true }, raw) as PetEventPayload;
  }

  if (kind === "schedule") {
    const title = text((raw as { title?: unknown }).title, 120);
    const at = text((raw as { at?: unknown }).at, 64);
    if (!title || !at) return null;
    return withRoute({ kind: "schedule", title, at }, raw) as PetEventPayload;
  }

  if (kind === "reset") {
    return { kind: "reset" };
  }

  return null;
}

/* ══════════════════ 2. 打扰强度（三档，本机偏好） ══════════════════ */

/**
 * 打扰强度：
 * - `quiet` 安静：只换姿态，不冒泡（不占桌面视线）；
 * - `normal` 正常（默认）：冒泡 4 秒后收回，不动姿态；
 * - `eager` 积极：姿态 + 气泡 + 轻微动作（只有「开心」映射了动作，其余靠姿态表达）。
 */
export type PetPresenceIntensity = "quiet" | "normal" | "eager";

export const PET_PRESENCE_KEY = "heming.pet.presence.v1";

export interface PetPresencePrefs {
  intensity: PetPresenceIntensity;
}

export const DEFAULT_PET_PRESENCE_PREFS: Readonly<PetPresencePrefs> = Object.freeze({
  intensity: "normal",
});

const INTENSITIES: ReadonlyArray<PetPresenceIntensity> = ["quiet", "normal", "eager"];

export function isPetPresenceIntensity(value: unknown): value is PetPresenceIntensity {
  return typeof value === "string" && (INTENSITIES as readonly string[]).includes(value);
}

function presenceStorage(store?: Storage | null): Storage | null {
  if (store !== undefined) return store;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 读强度偏好：坏数据回落默认「正常」，绝不整份丢弃。 */
export function loadPetPresencePrefs(store?: Storage | null): PetPresencePrefs {
  const target = presenceStorage(store);
  if (!target) return { ...DEFAULT_PET_PRESENCE_PREFS };
  try {
    const raw = target.getItem(PET_PRESENCE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_PET_PRESENCE_PREFS };
    }
    const intensity = (parsed as { intensity?: unknown }).intensity;
    return { intensity: isPetPresenceIntensity(intensity) ? intensity : DEFAULT_PET_PRESENCE_PREFS.intensity };
  } catch {
    return { ...DEFAULT_PET_PRESENCE_PREFS };
  }
}

/** 写强度偏好：配额/隐私模式失败静默（本次会话生效）。 */
export function savePetPresencePrefs(prefs: PetPresencePrefs, store?: Storage | null): void {
  const target = presenceStorage(store);
  if (!target) return;
  const safe: PetPresencePrefs = {
    intensity: isPetPresenceIntensity(prefs.intensity)
      ? prefs.intensity
      : DEFAULT_PET_PRESENCE_PREFS.intensity,
  };
  try {
    target.setItem(PET_PRESENCE_KEY, JSON.stringify(safe));
  } catch {
    /* 配额/隐私模式：本次会话生效 */
  }
}

/* ══════════════ 3. 事件 → 气泡文案 / 姿态（纯函数） ══════════════ */

/** 气泡单次显示时长：轻提示短、不打断（需求：4 秒收回）。 */
export const PRESENCE_BUBBLE_MS = 4_000;
/** 单条气泡的硬上限：一句到两句、约 60 字（spec §1.3「开口」约束）。 */
export const PRESENCE_BUBBLE_MAX_CHARS = 60;
/** 同一事件在此窗口内只让桌宠冒泡一次（Lead 定的 10 分钟频控）。 */
export const PRESENCE_DEDUPE_MS = 10 * 60_000;
/** 频控窗口内最多冒泡次数（防止批量任务收尾刷屏）。 */
export const PRESENCE_MAX_PER_WINDOW = 3;

/** 压成一行并截断到上限（气泡不是文章）。 */
function bubbleClip(text: string, max = PRESENCE_BUBBLE_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
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
 * 把一个（已校验或未校验的）事件归约成桌宠表达状态（纯函数）。
 *
 * - 畸形事件 → 原样返回（无任何反应、不抛）；
 * - `reset` → 清空；
 * - 安静档：只换姿态、不冒泡；
 * - 正常档：只冒泡（4 秒后收回），不改姿态；
 * - 积极档：姿态 + 气泡；`happy` 姿态会顺带播一次 TapBody（由 PET_POSES 决定，渲染层无感）。
 *
 * `busy`（正在与用户对话/流式输出）时**不显示**新事件，由调用方排队到这轮结束再决定
 * （spec §4.5「不打断对话」）。
 */
export function reducePetEvent(
  prev: PetPresenceVisual,
  raw: unknown,
  opts: { now: number; intensity: PetPresenceIntensity; busy?: boolean },
): PetPresenceVisual {
  const ev = parsePetEvent(raw);
  if (!ev) return prev;
  if (opts.busy) return prev;
  if (ev.kind === "reset") return { ...EMPTY_PET_PRESENCE };

  const now = opts.now;
  // 显式姿态覆盖：不受强度影响（它是发送方的明确表达，不是「开口」）。
  if (ev.kind === "pose") {
    return { ...prev, pose: ev.pose, poseUntil: now + PRESENCE_BUBBLE_MS };
  }

  const text = bubbleTextForEvent(ev);
  if (!text) return prev;

  if (opts.intensity === "quiet") {
    // 安静：只换姿态，不冒泡（气泡保持清空——安静档下不该有任何桌面文字）。
    return { pose: poseForEvent(ev), poseUntil: now + PRESENCE_BUBBLE_MS, bubble: null };
  }

  const bubble: PetBubbleState = {
    text,
    ...(isPetEventRoute((ev as { route?: unknown }).route) ? { route: (ev as { route: PetEventRoute }).route } : {}),
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

/* ══════════ 4. 通知 → 在场事件派生（只带标题级信息） ══════════ */

/** 通知中心条目里「在场感」需要的最小字段（不传正文以外的任何内部字段）。 */
export interface PresenceNotification {
  kind: string;
  title: string;
  body?: string;
  /** 通知去重键：同一 key 绝不重复派生。 */
  key?: string;
}

/** 日程条目（`InfohubAgendaItem` 的子集）：只用标题/到期时间，detail 一律不碰。 */
export interface PresenceAgendaItem {
  title: string;
  dueTs: number;
  /** 稳定引用（`agenda:<id>`）；缺失时用标题+时间兜底。 */
  refId?: string;
}

/** 一条「已决定要让用户知道」的事 → 桌宠事件计划。 */
export interface PresencePlan {
  event: PetEventPayload;
  route: PetEventRoute;
  /** 去重键：同一 key 在频控窗口内只冒泡一次。 */
  dedupeKey: string;
}

const TASK_DONE_LABELS: ReadonlyArray<{ label: string; ok: boolean }> = [
  { label: "已完成", ok: true },
  { label: "执行失败", ok: false },
  { label: "已中断", ok: false },
];

/** 本机时间 HH:MM（日程只带时刻，不带日期/证据/会话）。 */
export function formatAgendaClock(dueTs: number): string {
  const d = new Date(dueTs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 任务收尾通知 → `task` 事件。
 *
 * 通知标题形如「<任务标题>已完成 / 执行失败 / 已中断」：**必须剥掉状态后缀**，
 * 只把任务标题交给桌宠（不含结果正文/错误详情）。
 */
export function deriveTaskPresence(item: PresenceNotification): PresencePlan | null {
  if (item.kind !== "task") return null;
  const title = item.title.trim();
  for (const { label, ok } of TASK_DONE_LABELS) {
    if (!title.endsWith(label)) continue;
    const taskTitle = title.slice(0, -label.length).trim() || "任务";
    return {
      event: { kind: "task", title: bubbleClip(taskTitle, 40), ok, route: "tasks" },
      route: "tasks",
      dedupeKey: item.key ?? `task:${taskTitle}:${ok}`,
    };
  }
  return null; // 不是「收尾」类任务通知（如记录被清理）：不打断
}

/** 从日程清单里挑「最该提」的一条：逾期优先，其次最近到期；都不临期返回 null。 */
export function pickDueAgenda(
  agenda: readonly PresenceAgendaItem[],
  now: number,
): PresenceAgendaItem | null {
  let picked: { item: PresenceAgendaItem; rank: number; dueTs: number } | null = null;
  for (const item of agenda) {
    if (!item || typeof item.title !== "string" || !item.title.trim()) continue;
    if (!Number.isFinite(item.dueTs) || item.dueTs <= 0) continue;
    const bucket = agendaBucket(item.dueTs, now);
    if (!bucket) continue;
    const rank = bucket === "overdue" ? 0 : bucket === "today" ? 1 : 2;
    if (!picked || rank < picked.rank || (rank === picked.rank && item.dueTs < picked.dueTs)) {
      picked = { item, rank, dueTs: item.dueTs };
    }
  }
  return picked ? picked.item : null;
}

/**
 * 幕僚/日程通知 → 桌宠事件：
 * - 若当前有临期日程，派生 `schedule`（标题 + HH:MM，route=信息中枢）；
 * - 否则派生 `speak`（「幕僚简报：<summary 截断>」，route=幕僚页）。
 *
 * 只读 `agendaBucket`（d.48 的同一套临期判据），不复制静默时段/预算/去重账本。
 */
export function deriveStaffPresence(
  item: PresenceNotification,
  agenda: readonly PresenceAgendaItem[],
  now: number,
): PresencePlan | null {
  if (item.kind !== "staff") return null;
  const due = pickDueAgenda(agenda, now);
  if (due) {
    const title = bubbleClip(due.title.trim(), 40);
    return {
      event: { kind: "schedule", title, at: formatAgendaClock(due.dueTs), route: "infohub" },
      route: "infohub",
      dedupeKey: item.key ?? `schedule:${due.refId ?? `${title}:${due.dueTs}`}`,
    };
  }
  const summary = (item.body ?? "").trim();
  const text = summary ? `幕僚简报：${bubbleClip(summary, 48)}` : "幕僚简报";
  return {
    event: { kind: "speak", text: bubbleClip(text), route: "staff" },
    route: "staff",
    dedupeKey: item.key ?? `staff:${text}`,
  };
}

/** 通知 → 事件计划的唯一入口；不认识的类型（如 approval）静默返回 null。 */
export function derivePresence(
  item: PresenceNotification,
  opts: { agenda?: readonly PresenceAgendaItem[]; now: number },
): PresencePlan | null {
  if (!item || typeof item.title !== "string") return null;
  if (item.kind === "task") return deriveTaskPresence(item);
  if (item.kind === "staff") return deriveStaffPresence(item, opts.agenda ?? [], opts.now);
  return null;
}

/* ═══════════════ 5. 渠道互斥 + 频控（纯函数） ═══════════════ */

export type PresenceGateResult = "ok" | "duplicate" | "rate-limited";

export interface PresenceGate {
  allow(key: string, now: number): PresenceGateResult;
  reset(): void;
}

/**
 * 频控闸门（内存态，**错过不补发**：不排队、不持久化）。
 *
 * 两条规则叠加：
 * 1. 同一事件 key 在 `windowMs`（默认 10 分钟）内只放行一次；
 * 2. 同一窗口内总放行数不超过 `maxEvents`（默认 3），防止批量任务收尾刷屏。
 */
export function createPresenceGate(
  opts: { windowMs?: number; maxEvents?: number } = {},
): PresenceGate {
  const windowMs = opts.windowMs ?? PRESENCE_DEDUPE_MS;
  const maxEvents = opts.maxEvents ?? PRESENCE_MAX_PER_WINDOW;
  const lastByKey = new Map<string, number>();
  let recent: number[] = [];

  return {
    allow(key, now) {
      const last = lastByKey.get(key);
      if (last !== undefined && now - last < windowMs) return "duplicate";
      recent = recent.filter((at) => now - at < windowMs);
      if (recent.length >= maxEvents) return "rate-limited";
      lastByKey.set(key, now);
      recent.push(now);
      return "ok";
    },
    reset() {
      lastByKey.clear();
      recent = [];
    },
  };
}

/** 送达决策：主窗口在前台 → 只走通知中心；否则交给桌宠（频控不通过则丢弃）。 */
export type PresenceDecision =
  | { action: "notification-center"; plan: PresencePlan }
  | { action: "pet"; plan: PresencePlan }
  | { action: "drop"; plan: PresencePlan; reason: "foreground" | PresenceGateResult };

export interface PresenceContext {
  /** 用户此刻能不能看到主窗口（`document.hasFocus()` + 可见性）。 */
  mainForeground: boolean;
  now: number;
  gate: PresenceGate;
}

/**
 * 单一判据（spec §1.2：判据不要散在两处）：
 * 主窗口在前台 → 通知中心已经收到这条，桌宠不说话；不在前台 → 桌宠说（且只由频控闸门决定说不说）。
 */
export function decidePresence(plan: PresencePlan, ctx: PresenceContext): PresenceDecision {
  if (ctx.mainForeground) return { action: "notification-center", plan };
  const gateResult = ctx.gate.allow(plan.dedupeKey, ctx.now);
  if (gateResult !== "ok") return { action: "drop", plan, reason: gateResult };
  return { action: "pet", plan };
}

/* ═══════════════ 6. 运行时（可注入，便于单测） ═══════════════ */

export interface PetPresenceRuntimeDeps {
  /** 把事件推给桌宠（生产 = `window.__heming_pet.emit`）。 */
  emit(payload: PetEventPayload): void;
  /** 主窗口此刻是否在前台（生产 = `document.hasFocus() && 可见`）。 */
  mainForeground(): boolean;
  /** 当前日程（生产 = 信息中枢 store；取不到就返回空表）。 */
  agenda(): readonly PresenceAgendaItem[] | Promise<readonly PresenceAgendaItem[]>;
  now(): number;
  /** 订阅「通知中心新增条目」；返回退订函数。 */
  subscribe(listener: (item: PresenceNotification) => void): () => void;
  gate?: PresenceGate;
}

export interface PetPresenceRuntime {
  /** 处理一条通知（异步：可能要读日程）；返回决策，便于测试与诊断。 */
  handle(item: PresenceNotification): Promise<PresenceDecision | null>;
  dispose(): void;
}

/**
 * 在场感运行器：订阅通知中心新增条目 → 派生事件 → 渠道互斥/频控 → emit。
 *
 * ★ 主窗口在前台时**不消费频控额度**（那条已经在通知中心里了，桌宠没说也不算一次）。
 * ★ 桌宠侧是否冒泡/换姿态由它自己按强度归约（`reducePetEvent`），因为两个渲染进程
 *   共享 localStorage 里的强度偏好。
 */
export function createPetPresence(deps: PetPresenceRuntimeDeps): PetPresenceRuntime {
  const gate = deps.gate ?? createPresenceGate();
  let disposed = false;

  const handle = async (item: PresenceNotification): Promise<PresenceDecision | null> => {
    if (disposed) return null;
    let agenda: readonly PresenceAgendaItem[] = [];
    try {
      agenda = await deps.agenda();
    } catch {
      agenda = [];
    }
    const now = deps.now();
    const plan = derivePresence(item, { agenda, now });
    if (!plan) return null;
    const decision = decidePresence(plan, { mainForeground: deps.mainForeground(), now, gate });
    if (decision.action !== "pet") return decision;
    try {
      deps.emit(plan.event);
    } catch {
      /* 桌宠窗口不在/IPC 抖动：不重试、不排队（错过不补发） */
      return { action: "drop", plan, reason: "rate-limited" };
    }
    return decision;
  };

  const unsubscribe = deps.subscribe((item) => {
    void handle(item).catch(() => {
      /* 单条坏通知不该中断订阅 */
    });
  });

  return {
    handle,
    dispose() {
      disposed = true;
      try {
        unsubscribe();
      } catch {
        /* 退订失败无副作用 */
      }
    },
  };
}

/** 测试隔离：清掉单例（不影响 localStorage）。 */
let presenceRuntime: PetPresenceRuntime | null = null;

export function resetPetPresenceRuntime(): void {
  presenceRuntime?.dispose();
  presenceRuntime = null;
}

/** 生产环境默认日程源：动态 import，避免桌宠窗口为了解析事件把信息中枢整包拖进去。 */
async function defaultAgenda(): Promise<readonly PresenceAgendaItem[]> {
  try {
    const mod = await import("./infohub/store.js");
    const items = mod.useInfohubStore.getState().agenda?.items ?? [];
    return items.map((item) => ({
      title: item.title,
      dueTs: item.dueTs,
      ...(typeof item.id === "number" ? { refId: `agenda:${item.id}` } : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * 主窗口启动时调用一次（App 挂载处）。返回退订函数；浏览器/无桌宠桥时是空操作。
 *
 * 幂等：重复调用只保留第一个运行器（避免 HMR/重渲染重复订阅导致重复冒泡）。
 */
export function startPetPresence(overrides: Partial<PetPresenceRuntimeDeps> = {}): () => void {
  if (presenceRuntime) return () => {};
  const bridge = typeof window !== "undefined" ? window.__heming_pet : undefined;
  if (!bridge || typeof bridge.emit !== "function") return () => {};

  const runtime = createPetPresence({
    emit: (payload) => window.__heming_pet?.emit(payload),
    mainForeground: () =>
      typeof document !== "undefined" && document.hasFocus() && document.visibilityState !== "hidden",
    agenda: defaultAgenda,
    now: () => Date.now(),
    subscribe: subscribeNewNotifications,
    ...overrides,
  });
  presenceRuntime = runtime;
  return () => {
    runtime.dispose();
    if (presenceRuntime === runtime) presenceRuntime = null;
  };
}

/**
 * 订阅通知中心**新增**条目（错过不补发：只处理订阅之后新出现的通知）。
 *
 * 用 id 集合差集而不是 `items[0]`：任务收尾可能一次插多条，且列表按时间倒序。
 */
function subscribeNewNotifications(listener: (item: PresenceNotification) => void): () => void {
  let known = new Set(useNotificationStore.getState().items.map((item) => item.id));
  return useNotificationStore.subscribe((state, prev) => {
    if (state.items === prev.items) return;
    const fresh = state.items.filter((item) => !known.has(item.id));
    known = new Set(state.items.map((item) => item.id));
    // 按发生顺序（旧 → 新）交给上层，频控闸门据此计数。
    for (const item of fresh.reverse()) {
      listener({ kind: item.kind, title: item.title, body: item.body, key: item.key });
    }
  });
}