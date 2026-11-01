import {
  callInfohub,
  describeInfohubError,
  isInfohubAvailable,
  readInfohubConfig,
  type InfohubAgendaResult,
  type InfohubSyncResult,
} from "../infohub/client.js";
import { AGENDA_DAYS, AGENDA_OVERDUE, useInfohubStore } from "../infohub/store.js";
import { clipText, MAX_DETAIL_CHARS, type AutomationTask } from "./model.js";
import type { AutomationResult } from "./store.js";

/**
 * 自动化执行器：只调用 InfoHub 桥的白名单方法。
 *
 * 执行前必须确认边车已经在跑——桥的 `call()` 在目标不一致时会自动拉起进程，
 * 自动化绝不能借这条路径绕过「由用户点连接」的约定。因此未连接直接 skipped，
 * 让调用方顺延计划，不 spawn、不重试。
 */

function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  if (source === "voice") return "语音";
  return source || "未知";
}

function result(status: AutomationResult["status"], detail: string): AutomationResult {
  return { status, detail: clipText(detail, MAX_DETAIL_CHARS) };
}

export function automationBlockedReason(): string {
  if (!isInfohubAvailable()) return "信息中枢仅桌面端可用，自动化未执行";
  if (!useInfohubStore.getState().running) {
    return "信息中枢未连接；先在「信息中枢」页连接本机归档";
  }
  return "";
}

async function runSync(task: AutomationTask): Promise<AutomationResult> {
  const data = await callInfohub<InfohubSyncResult>(
    "sync",
    {
      sources: task.sync.sources,
      full: task.sync.full,
      archive: task.sync.archive,
    },
    readInfohubConfig(),
  );
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const added = reports
    .filter((report) => report.added > 0)
    .map((report) => `${sourceLabel(report.source)} 新增 ${report.added}`);
  const errors = reports.reduce((n, report) => n + (report.errors?.length ?? 0), 0);
  let detail = `同步完成：${added.join("，") || "无新增"}`;
  if (errors > 0) detail += `；${errors} 个采集错误`;
  if (task.sync.archive) {
    const kb = data.kb as { error?: string } | null | undefined;
    if (!kb) detail += "；配置未开启知识库导出";
    else if (kb.error) detail += `；知识库导出失败：${kb.error}`;
    else detail += "；知识库已导出";
  }
  // 同步会写归档：共享 store 的规模与日程立即重算，首页卡和工具不读旧数据。
  try {
    await useInfohubStore.getState().refresh();
  } catch {
    /* 刷新失败不影响同步结果本身 */
  }
  return result("ok", detail);
}

async function runAgendaRebuild(): Promise<AutomationResult> {
  const data = await callInfohub<InfohubAgendaResult>(
    "agenda",
    { days: AGENDA_DAYS, overdue: AGENDA_OVERDUE, rebuild: true },
    readInfohubConfig(),
  );
  useInfohubStore.setState({ agenda: data });
  return result("ok", `重扫完成：${data.items?.length ?? 0} 项日程`);
}

/** 执行一条任务；不抛错，失败/跳过都收成结果，交给 store 留痕。 */
export async function runAutomationTask(task: AutomationTask): Promise<AutomationResult> {
  const blocked = automationBlockedReason();
  if (blocked) return result("skipped", blocked);
  try {
    if (task.kind === "infohub.sync") return await runSync(task);
    if (task.kind === "infohub.agenda") return await runAgendaRebuild();
    return result("error", "未知的自动化动作");
  } catch (err) {
    return result("error", describeInfohubError(err));
  }
}
