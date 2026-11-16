import type { ShellBridge, ShellJobSummary } from "./bridge.js";

/**
 * 后台作业面板的数据层（d.203）。
 *
 * 为什么要有这一层：d.180 的后台作业只有**模型**看得见（`command_list` / `command_output`），
 * 用户界面上没有任何地方能回答「现在到底有哪几条命令在跑、跑到哪了」。于是长任务里常见
 * 这种场面：模型说「我在跑构建」，用户屏幕上一片安静，以为卡死了就点停止——把活掐断。
 *
 * 三条口径：
 * - **只报事实**：状态、退出码、耗时、输出字节数都来自主进程的作业表，不猜进度百分比。
 * - **不消费增量**：界面看日志只读 `jobPreview`（只读快照）；模型读的 `command_output`
 *   仍是增量读——两边不能互相抢，否则用户在界面点一次「日志」，模型那一轮就少一段输出。
 * - **只管展示**：启动/停止仍然走工具层（模型）或面板按钮（用户显式点），这一层不自动起停。
 */

/** 面板最多保留多少条作业（与主进程的保留上限同量级，避免长会话里无限增长）。 */
export const JOB_PANEL_MAX = 20;

/** 有作业在跑时的轮询间隔：状态变化（结束、退出码）最多晚 2 秒被界面看到。 */
export const JOB_PANEL_POLL_MS = 2000;

export interface PanelJob {
  id: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** 累计产出的字节数（来自主进程计数，不是面板自己数的）。 */
  bytes: number;
  /** 因 512KB 上限丢掉的字节数；非 0 时必须让用户知道「日志不全」。 */
  dropped: number;
  /** 最近一次预览到的输出（只读快照，可能被截）。 */
  preview?: string;
  /** 预览是否被长度上限截过。 */
  previewCut?: boolean;
}

let rows: PanelJob[] = [];
let snapshot: readonly PanelJob[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = rows.slice();
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  }
}

function clipText(value: string): string {
  // 面板不是日志查看器：单条预览留 16KB 上限，和桌面端 preview 的上限对齐。
  if (value.length <= 16000) return value;
  return `${value.slice(value.length - 16000)}`;
}

function fromSummary(summary: ShellJobSummary): PanelJob {
  return {
    id: summary.id,
    command: summary.command,
    cwd: summary.cwd,
    running: summary.running,
    exitCode: summary.exitCode,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    bytes: summary.bytes,
    dropped: summary.dropped,
  };
}

/** 按开始时间从旧到新排序（面板从旧到新显示，最新的一条在下面）。 */
function sortRows(): void {
  rows.sort((a, b) => a.startedAt - b.startedAt);
  if (rows.length > JOB_PANEL_MAX) {
    // 超出上限时先丢最旧的**已完成**作业；在跑的一条都不能丢。
    const overflow = rows.length - JOB_PANEL_MAX;
    let dropped = 0;
    for (let i = 0; i < rows.length && dropped < overflow; i += 1) {
      if (rows[i].running) continue;
      rows.splice(i, 1);
      i -= 1;
      dropped += 1;
    }
  }
}

export function subscribePanelJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 面板当前快照；引用在内容不变时保持稳定（`useSyncExternalStore` 需要）。 */
export function listPanelJobs(): readonly PanelJob[] {
  return snapshot;
}

export function hasRunningPanelJobs(): boolean {
  return rows.some((row) => row.running);
}

/**
 * 把主进程作业表合并进面板。
 *
 * 为什么是「合并」而不是「覆盖」：主进程会淘汰最旧的已完成作业，而用户可能正展开着
 * 一条日志在看；覆盖会让那一行突然消失。合并只更新已知字段，保留已预览的输出。
 */
export function syncPanelJobs(summaries: readonly ShellJobSummary[]): void {
  let changed = false;
  for (const summary of summaries) {
    const fresh = fromSummary(summary);
    const index = rows.findIndex((row) => row.id === fresh.id);
    if (index === -1) {
      rows.push(fresh);
      changed = true;
      continue;
    }
    const current = rows[index];
    if (
      current.running !== fresh.running ||
      current.exitCode !== fresh.exitCode ||
      current.finishedAt !== fresh.finishedAt ||
      current.bytes !== fresh.bytes ||
      current.dropped !== fresh.dropped ||
      current.command !== fresh.command
    ) {
      rows[index] = { ...current, ...fresh, ...(current.preview !== undefined ? { preview: current.preview } : {}), ...(current.previewCut !== undefined ? { previewCut: current.previewCut } : {}) };
      changed = true;
    }
  }
  if (!changed) return;
  sortRows();
  emit();
}

/** 记下一条作业的预览输出（只读快照，不消费增量）。 */
export function setPanelJobPreview(jobId: string, text: string, cut: boolean): void {
  const index = rows.findIndex((row) => row.id === jobId);
  if (index === -1) return;
  rows[index] = { ...rows[index], preview: clipText(text), previewCut: cut };
  emit();
}

/** 清空面板（切会话/退出登录时用；主进程里的作业不受影响）。 */
export function resetPanelJobs(): void {
  if (rows.length === 0) return;
  rows = [];
  emit();
}

/**
 * 拉一次主进程作业表。
 *
 * 返回 `false` 表示桌面端没有作业通道（浏览器端或老安装包）——调用方据此不渲染面板，
 * 而不是渲染一个永远空着的框。
 */
export async function pollPanelJobs(bridge: ShellBridge | null): Promise<boolean> {
  if (!bridge || typeof bridge.jobs !== "function") return false;
  let res: Awaited<ReturnType<NonNullable<ShellBridge["jobs"]>>>;
  try {
    res = await bridge.jobs();
  } catch {
    return false;
  }
  if (!res.ok) return false;
  syncPanelJobs(res.jobs);
  return true;
}

/** 读一条作业的最近输出（只读快照）。返回给人看的错误文案；成功为 null。 */
export async function previewPanelJob(bridge: ShellBridge | null, jobId: string): Promise<string | null> {
  if (!bridge || typeof bridge.jobPreview !== "function") {
    return "当前桌面端版本不支持在界面上看作业日志（升级后可用）。";
  }
  let res: Awaited<ReturnType<NonNullable<ShellBridge["jobPreview"]>>>;
  try {
    res = await bridge.jobPreview({ jobId });
  } catch (err) {
    return `读取作业日志失败：${String(err)}`;
  }
  if (!res.ok) return res.error || "读取作业日志失败。";
  const chunks: string[] = [];
  if (res.stdout.trim()) chunks.push(res.stdout.trimEnd());
  if (res.stderr.trim()) chunks.push(`[stderr]\n${res.stderr.trimEnd()}`);
  const text = chunks.join("\n");
  setPanelJobPreview(jobId, text || "（这条作业还没有输出）", res.cut);
  return null;
}

/** 请求停止一条作业。返回给人看的错误文案；成功为 null。 */
export async function killPanelJob(bridge: ShellBridge | null, jobId: string): Promise<string | null> {
  if (!bridge || typeof bridge.jobKill !== "function") {
    return "当前桌面端版本不支持停止后台作业（升级后可用）。";
  }
  let res: Awaited<ReturnType<NonNullable<ShellBridge["jobKill"]>>>;
  try {
    res = await bridge.jobKill({ jobId });
  } catch (err) {
    return `停止作业失败：${String(err)}`;
  }
  if (!res.ok) return res.error || "停止作业失败。";
  if (!res.killed && res.alreadyFinished) {
    // 已经结束了：刷新一下让面板显示真实状态，而不是停在「在跑」。
    await pollPanelJobs(bridge);
    return "这条作业已经结束了，不需要停止。";
  }
  await pollPanelJobs(bridge);
  return null;
}
