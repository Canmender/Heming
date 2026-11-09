import { describeInfohubError, isInfohubAvailable } from "../infohub/client.js";
import { useInfohubStore } from "../infohub/store.js";
import { getAction, INFOHUB_OFFLINE } from "./actions.js";
import { clipText, MAX_DETAIL_CHARS, type AutomationTask } from "./model.js";
import type { AutomationResult } from "./store.js";

/**
 * 自动化执行器：只判断「现在能不能跑」，再把任务交给动作注册表。
 *
 * 自动化是独立插件：安装/启停不依赖信息中枢模块。但真正执行任务时必须有
 * 本机信息中枢边车在跑——未连接就直接返回结构化的 error（带可读原因），
 * 绝不借桥的 `call()` 自动拉起进程，也不在浏览器端假装跑。
 */

/** 未连接时统一的失败原因：如实报错，而不是「跳过」得像是没发生。 */
export { INFOHUB_OFFLINE } from "./actions.js";

function result(status: AutomationResult["status"], detail: string): AutomationResult {
  // 与 actions.ts 的 result 同一口径：详情统一截断到 MAX_DETAIL_CHARS。
  return { status, detail: clipText(detail, MAX_DETAIL_CHARS) };
}

export function automationBlockedReason(): string {
  if (!isInfohubAvailable()) return INFOHUB_OFFLINE;
  if (!useInfohubStore.getState().running) return INFOHUB_OFFLINE;
  return "";
}

/** 执行一条任务；不抛错，失败/跳过都收成结果，交给 store 留痕。 */
export async function runAutomationTask(task: AutomationTask): Promise<AutomationResult> {
  const blocked = automationBlockedReason();
  if (blocked) return result("error", blocked);
  // 动作分发只查注册表：未知 kind 不猜默认动作，直接记失败。
  const action = getAction(task.kind);
  if (!action) return result("error", "未知的自动化动作");
  try {
    return await action.run(task);
  } catch (err) {
    return result("error", describeInfohubError(err));
  }
}
