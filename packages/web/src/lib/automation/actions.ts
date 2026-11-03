import {
  callInfohub,
  readInfohubConfig,
  type InfohubAgendaResult,
  type InfohubSyncResult,
} from "../infohub/client.js";
import { AGENDA_DAYS, AGENDA_OVERDUE, useInfohubStore } from "../infohub/store.js";
import type { AutomationKind } from "./kinds.js";
import { clipText, MAX_DETAIL_CHARS, type AutomationTask } from "./model.js";
import type { AutomationResult } from "./store.js";

/**
 * 自动化动作注册表（执行侧）。
 *
 * kinds.ts 回答「有哪些动作」，这里给出「每个动作怎么跑」；runner 只做
 * gating 与分发。两个执行函数原样从 runner.ts 搬来——不新增动作、不加网络、
 * 不执行任意脚本，改的只是分发方式。
 *
 * 这里对 `AutomationResult` 只用 type-only import：结果类型的落点仍在 store.ts
 * （`finishRun` 把它写进任务），type-only 在编译后消失，不会形成运行时环。
 */

export interface AutomationAction {
  kind: AutomationKind;
  /** 执行一次动作；失败由 runner 统一收成 error 结果，这里不吞异常。 */
  run(task: AutomationTask): Promise<AutomationResult>;
}

function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  if (source === "voice") return "语音";
  return source || "未知";
}

function result(status: AutomationResult["status"], detail: string): AutomationResult {
  // 与 runner.ts 的 result 同一口径：详情统一截断到 MAX_DETAIL_CHARS。
  return { status, detail: clipText(detail, MAX_DETAIL_CHARS) };
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

const ACTIONS: readonly AutomationAction[] = [
  { kind: "infohub.sync", run: runSync },
  { kind: "infohub.agenda", run: runAgendaRebuild },
];

/** 按 kind 找动作；未知 kind 返回 null，交给调用方收成「未知的自动化动作」。 */
export function getAction(kind: string): AutomationAction | null {
  return ACTIONS.find((action) => action.kind === kind) ?? null;
}

/** 只读快照：页面渲染动作列表与测试枚举用。 */
export function listActions(): readonly AutomationAction[] {
  return ACTIONS;
}
