import { describeInfohubError, isInfohubAvailable } from "../infohub/client.js";
import { useInfohubStore } from "../infohub/store.js";
import { getAction } from "./actions.js";
import { clipText, MAX_DETAIL_CHARS, type AutomationTask } from "./model.js";
import type { AutomationResult } from "./store.js";

/**
 * 自动化执行器：只判断「现在能不能跑」，再把任务交给动作注册表。
 *
 * 执行前必须确认边车已经在跑——桥的 `call()` 在目标不一致时会自动拉起进程，
 * 自动化绝不能借这条路径绕过「由用户点连接」的约定。因此未连接直接 skipped，
 * 让调用方顺延计划，不 spawn、不重试。
 */

function result(status: AutomationResult["status"], detail: string): AutomationResult {
  // 与 actions.ts 的 result 同一口径：详情统一截断到 MAX_DETAIL_CHARS。
  return { status, detail: clipText(detail, MAX_DETAIL_CHARS) };
}

export function automationBlockedReason(): string {
  if (!isInfohubAvailable()) return "信息中枢仅桌面端可用，自动化未执行";
  if (!useInfohubStore.getState().running) {
    return "信息中枢未连接；先在「信息中枢」页连接本机归档";
  }
  return "";
}

/** 执行一条任务；不抛错，失败/跳过都收成结果，交给 store 留痕。 */
export async function runAutomationTask(task: AutomationTask): Promise<AutomationResult> {
  const blocked = automationBlockedReason();
  if (blocked) return result("skipped", blocked);
  // 动作分发只查注册表：未知 kind 不猜默认动作，直接记失败。
  const action = getAction(task.kind);
  if (!action) return result("error", "未知的自动化动作");
  try {
    return await action.run(task);
  } catch (err) {
    return result("error", describeInfohubError(err));
  }
}
