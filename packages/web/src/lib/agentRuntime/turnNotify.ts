/**
 * 「跑完 / 需要你确认」时弹系统通知（d.208）。
 *
 * 为什么单独一层：`notifyDesktop`（d.39）早就有了，桌面端通知桥、点击回传、
 * 甚至「窗口在前台就不打扰」的判断也都有，但渲染层**从来没有调用过它**——
 * 于是「长任务跑完叫我」这件事在桌面上等于不存在：用户切去别的窗口干活，
 * 回来才发现早就跑完了（或者停在「等你确认」上干等了十分钟）。
 *
 * 这一层只做两件事：把状态翻成人话（纯函数，便于测试），
 * 以及按「同一条通知别连着弹」做去重（模型连续几轮收口时不该刷屏）。
 */
import { notifyDesktop } from "../desktopNotify.js";

/** 通知正文上限：系统通知只显示两三行，再长会被截断成半句话。 */
export const TURN_NOTIFY_BODY_MAX = 120;
/** 同一类通知的最短间隔：连续多轮收口时不要每轮弹一次。 */
export const TURN_NOTIFY_GAP_MS = 4000;

export interface TurnSettledLike {
  status: "ok" | "aborted" | "error";
  finalText?: string;
  error?: string;
  maxRounds?: boolean;
  budgetStop?: boolean;
}

export interface NotifyText {
  title: string;
  body: string;
}

/** 取首行并压成一句（通知里换行会被系统折叠，留着也只是让截断更难看）。 */
export function firstLine(text: string | null | undefined, max = 80): string {
  if (typeof text !== "string") return "";
  const line = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";
  return clipText(line, max);
}

/** 按码点截断并补省略号：UTF-16 切片会把 emoji 劈成乱码。 */
export function clipText(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function who(agentName?: string | null): string {
  const name = typeof agentName === "string" ? agentName.trim() : "";
  return name || "智能体";
}

/**
 * 一轮收口 → 通知文案。
 *
 * `aborted` 返回 null：那是用户自己点的停止，他就在跟前；
 * 给他弹「你停了」的通知纯属打扰。
 */
export function describeTurnEnd(
  result: TurnSettledLike,
  agentName?: string | null,
): NotifyText | null {
  if (result.status === "aborted") return null;
  const name = who(agentName);
  if (result.status === "error") {
    const reason = firstLine(result.error, TURN_NOTIFY_BODY_MAX) || "具体原因在会话里。";
    return { title: `${name} 这一轮出错了`, body: reason };
  }
  if (result.maxRounds) {
    return {
      title: `${name} 撞到轮次上限，先停了`,
      body: "这一轮先给了结论，还没做完：打开会话点「继续」接着干。",
    };
  }
  if (result.budgetStop) {
    return {
      title: `${name} 的上下文满了，先停了`,
      body: "这一轮被预算截断：打开会话点「继续」，或者先发 /compact 压一下历史。",
    };
  }
  const head = firstLine(result.finalText, TURN_NOTIFY_BODY_MAX);
  return {
    title: `${name} 这一轮做完了`,
    body: head || "打开会话看结果。",
  };
}

/** 工具确认在等用户 → 通知文案。 */
export function describeApprovalWait(
  calls: readonly { displayName: string }[] | readonly string[],
  agentName?: string | null,
): NotifyText {
  const names = calls.map((call) => (typeof call === "string" ? call : call.displayName)).filter(Boolean);
  const list = names.length > 0 ? names.join("、") : "一个工具";
  return {
    title: `${who(agentName)} 需要你确认`,
    body: clipText(`${list} 在等你允许（打开会话处理）`, TURN_NOTIFY_BODY_MAX),
  };
}

let lastAt = new Map<string, number>();

/** 清空去重表（测试与切会话时用）。 */
export function resetTurnNotifyThrottle(): void {
  lastAt = new Map();
}

function allow(key: string, now: number, gapMs = TURN_NOTIFY_GAP_MS): boolean {
  const prev = lastAt.get(key);
  if (prev !== undefined && now - prev < gapMs) return false;
  lastAt.set(key, now);
  return true;
}

/** 一轮收口时调一次：窗口在前台时 `notifyDesktop` 自己会拒绝，不需要这里判断。 */
export function notifyTurnEnd(
  result: TurnSettledLike,
  agentName: string | null | undefined,
  conversationId: string | null | undefined,
  now = Date.now(),
): boolean {
  const text = describeTurnEnd(result, agentName);
  if (!text) return false;
  const key = `turn:${conversationId ?? "-"}:${text.title}`;
  if (!allow(key, now)) return false;
  return notifyDesktop({
    title: text.title,
    body: text.body,
    ...(conversationId ? { conversationId } : {}),
  });
}

/** 工具确认在等用户时调一次。同一个请求只该提醒一次，由调用方按 requestId 去重。 */
export function notifyApprovalWait(
  requestId: string,
  calls: readonly { displayName: string }[] | readonly string[],
  agentName: string | null | undefined,
  conversationId: string | null | undefined,
  now = Date.now(),
): boolean {
  const text = describeApprovalWait(calls, agentName);
  const key = `approval:${requestId}`;
  if (!allow(key, now, 60 * 60 * 1000)) return false;
  return notifyDesktop({
    title: text.title,
    body: text.body,
    ...(conversationId ? { conversationId } : {}),
  });
}
