import type { PetPose } from "./petPose.js";

/**
 * 主进程 → 桌宠的事件契约（d.53 第三期预留）。
 *
 * 为什么需要它：桌宠到现在只会**自己感知**（WS 未读），无法接收平台侧发生的事。
 * 而和鸣这边已经有大量"值得让它表达一下"的信号——任务收尾（d.51）、日程临期与幕僚简报（d.48）、
 * 自动化跑完（d.47）。这些不该各开一条 IPC，统一走 `pet:event` 一条通道，
 * 新增事件类型只是往下面的联合里加一项。
 *
 * ★ 边界（与主进程 `pet-host.js` 的 pushEvent 对齐）：
 *   - 通道是**单向**的（主进程 → 桌宠）。桌宠要主窗口做事，仍走已有的
 *     `pet:open-conversation` / `pet:open-settings`，不要用事件反向驱动 UI。
 *   - 跨进程传入的 payload 一律当作**不可信**：必须先过 `parsePetEvent`。
 *     一个畸形事件不该让桌宠抛错白屏——它没有控制台给用户看。
 *
 * 当前**没有生产者**：这是显式预留，不是死代码。接上任意一个发送方即生效。
 */

export type PetEventPayload =
  /** 手动指定姿态（例如未来「简报到了，切 speaking」） */
  | { kind: "pose"; pose: PetPose }
  /** 让桌宠显示一句话（不调模型，纯展示；幕僚简报可直接用） */
  | { kind: "speak"; text: string }
  /** 任务收尾提醒 */
  | { kind: "task"; title: string; ok: boolean }
  /** 日程临期提醒 */
  | { kind: "schedule"; title: string; at: string }
  /** 清掉临时表达（气泡/姿态），回到自行判定的状态 */
  | { kind: "reset" };

/** 合法姿态集合：与 `PET_POSES` 的键保持一致，校验时用。 */
const POSES: ReadonlyArray<PetPose> = ["idle", "listening", "thinking", "speaking", "alerting", "happy"];

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

/**
 * 校验并规整一个跨进程事件（纯函数）。
 *
 * 返回 null 表示这条事件不可用——调用方应当**静默忽略**，而不是弹错：
 * 桌宠没有控制台，为一条畸形事件打断用户不值得。
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
    return value ? { kind: "speak", text: value } : null;
  }

  if (kind === "task") {
    const title = text((raw as { title?: unknown }).title, 120);
    const ok = (raw as { ok?: unknown }).ok;
    if (!title) return null;
    return { kind: "task", title, ok: ok === true };
  }

  if (kind === "schedule") {
    const title = text((raw as { title?: unknown }).title, 120);
    const at = text((raw as { at?: unknown }).at, 64);
    if (!title || !at) return null;
    return { kind: "schedule", title, at };
  }

  if (kind === "reset") {
    return { kind: "reset" };
  }

  return null;
}
