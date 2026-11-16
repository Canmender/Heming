import { Button } from "./ui/Button.js";
import type { SubagentRun } from "../lib/agentRuntime/subagentRuns.js";

/** 任务描述压成一行：面板只有一条，长的任务书会把「第几轮 / 在调什么」挤掉。 */
function shortTask(task: string, max = 48): string {
  const flat = task.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function statusLine(run: SubagentRun): string {
  if (run.tool) return `第 ${run.round} 轮 · 正在 ${run.tool}`;
  if (run.round > 0) return `第 ${run.round} 轮 · 思考中`;
  return "刚派出";
}

/**
 * 并行子代理面板（d.200）。
 *
 * 只在「有子代理在跑」时出现——它是一条状态条，不是常驻导航。
 * 每行给的是**事实**：第几轮、正在调哪个只读工具；不给百分比（子代理轮数不定，
 * 百分比只能是编的）。
 *
 * 为什么要「停止」：两个子代理各吃 4 轮，用户可能已经知道答案了，只想停掉它们
 * 把主对话要回来。停止只中断子代理（`withSubagentTool` 的 `createSignal`），
 * 主对话那一轮照常继续。
 */
export function SubagentRuns({
  runs,
  onStop,
}: {
  runs: SubagentRun[];
  onStop: () => void;
}) {
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="只读子代理进度"
      data-testid="subagent-runs"
      className="mx-4 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-body"
    >
      <span className="shrink-0 font-medium">
        只读子代理 · {running.length} 个在跑
      </span>
      <ul className="min-w-0 flex-1 basis-64 space-y-0.5">
        {running.map((run) => (
          <li key={run.id} className="truncate text-muted" title={run.task}>
            {shortTask(run.task)} · {statusLine(run)}
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={onStop}>
        停止
      </Button>
    </div>
  );
}
