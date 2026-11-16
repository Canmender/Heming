import { Button } from "./ui/Button.js";
import type { PanelJob } from "../lib/shell/jobPanel.js";

/** 命令压成一行：面板一行要同时放下状态、耗时、退出码。 */
function shortCommand(command: string, max = 64): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function statusText(job: PanelJob, now: number): string {
  if (job.running) return `在跑 · ${formatElapsed(now - job.startedAt)}`;
  const ended = job.finishedAt ?? job.startedAt;
  const took = formatElapsed(Math.max(0, ended - job.startedAt));
  if (job.exitCode === null) return `已结束（无退出码）· ${took}`;
  if (job.exitCode === 0) return `已完成 · ${took}`;
  return `失败（退出码 ${job.exitCode}）· ${took}`;
}

/**
 * 后台作业面板（d.203）。
 *
 * 为什么要有它：d.180 的后台作业只有模型看得见。模型说「我在跑构建」之后，用户屏幕上
 * 没有任何迹象——以为卡死就点停止，把跑了几分钟的构建掐掉。这条面板把「哪几条在跑、
 * 跑了多久、结束成没成」摆到界面上，并给用户一个明确的停止入口。
 *
 * 两条如实原则：
 * - 不编进度：只显示真实的状态、耗时、退出码。
 * - 不假装日志全：主进程因 512KB 上限丢过内容时必须写出来（`dropped > 0`），
 *   预览被截时也要写出来。
 */
export function JobPanel({
  jobs,
  now = Date.now(),
  canPreview,
  onPreview,
  onStop,
  notice,
}: {
  jobs: readonly PanelJob[];
  /** 注入「现在」，便于测试断言耗时文案。 */
  now?: number;
  /** 桌面端是否支持只读预览（老安装包没有）。 */
  canPreview: boolean;
  onPreview: (jobId: string) => void;
  onStop: (jobId: string) => void;
  /** 上一次操作给人看的失败文案（成功为 null）。 */
  notice?: string | null;
}) {
  if (jobs.length === 0) return null;
  const running = jobs.filter((job) => job.running).length;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="后台作业"
      data-testid="job-panel"
      className="mx-4 mb-1 flex flex-col gap-1 rounded-md border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-body"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="shrink-0 font-medium">
          后台作业 · {jobs.length} 条{running > 0 ? `（${running} 条在跑）` : "（都已结束）"}
        </span>
      </div>
      <ul className="space-y-1">
        {jobs.map((job) => (
          <li key={job.id} data-testid={`job-row-${job.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={
                job.running
                  ? "shrink-0 rounded-full bg-warn-soft px-1.5 text-ui-xs text-warn"
                  : "shrink-0 rounded-full bg-subtle px-1.5 text-ui-xs text-muted"
              }
            >
              {statusText(job, now)}
            </span>
            <code className="min-w-0 max-w-full flex-1 basis-48 truncate font-mono text-ui-xs text-body" title={job.command}>
              {shortCommand(job.command)}
            </code>
            {job.dropped > 0 ? (
              <span className="shrink-0 text-ui-xs text-warn" title="输出超过 512KB，最早的内容已被丢弃">
                日志不全（丢 {(job.dropped / 1024).toFixed(1)}KB）
              </span>
            ) : null}
            {canPreview ? (
              <Button variant="ghost" size="sm" onClick={() => onPreview(job.id)}>
                日志
              </Button>
            ) : null}
            {job.running ? (
              <Button variant="ghost" size="sm" onClick={() => onStop(job.id)} title="停止这条后台命令">
                停止
              </Button>
            ) : null}
            {job.preview !== undefined ? (
              <div className="basis-full">
                <pre
                  data-testid={`job-output-${job.id}`}
                  className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-subtle px-2 py-1 font-mono text-ui-xs text-muted"
                >
                  {job.preview}
                </pre>
                {job.previewCut ? <p className="text-ui-xs text-muted">（只显示最后一段；要完整输出让它读 command_output）</p> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {notice ? <p className="text-ui-xs text-warn">{notice}</p> : null}
    </div>
  );
}
