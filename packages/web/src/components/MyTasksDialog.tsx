import { useCallback, useEffect, useRef, useState } from "react";
import type { AssignedTeamTask } from "../lib/team/assignedTasks.js";
import { fetchMyTeamTasks } from "../lib/api.js";
import {
  buildClaimTaskPrompt,
  buildMyTaskPrompt,
  describeMyTaskMeta,
} from "../lib/team/myTaskPrompt.js";
import { Button } from "./ui/Button.js";
import { Dialog } from "./ui/Dialog.js";

/**
 * 「我的任务」面板（d.259 / d.260）。
 *
 * 团队这条线到 d.258 已经齐了「组长能派、队员能被通知到」；缺的是最后一步：
 * 派到我名下的活，用户怎么**点一下**让和鸣接着做——否则得自己复述需求，
 * 还容易漏掉截止与前置。
 *
 * d.260 又补了另一半：派活时**留空负责人**（等认领）的活，此前只有团队页能看到，
 * 队员的智能体根本不知道队里有活没人接，于是这类活容易一直挂着。现在这里多一段
 * 「队里待认领」，点了会让它先认领（`assignee_id` 设成自己）再开始做。
 *
 * 只读一次接口（`GET /api/team/my-tasks`，与每轮提示词同源），不做轮询：
 * 打开时拉、点刷新拉；拿不到就如实说，不假装「没有任务」。
 * 选中的任务会变成一条普通用户消息（见 `lib/team/myTaskPrompt.ts`），
 * 走的是用户自己的发送路径，HITL/工具/记录都与手打一致。
 */
export interface MyTasksDialogProps {
  onClose: () => void;
  /** 选中一条：父组件负责把它变成消息发出去。 */
  onPick: (item: AssignedTeamTask, prompt: string) => void;
}

export function MyTasksDialog({ onClose, onPick }: MyTasksDialogProps) {
  const [tasks, setTasks] = useState<AssignedTeamTask[] | null>(null);
  const [claimable, setClaimable] = useState<AssignedTeamTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // d.412 回归：刷新按钮直接调 load() 会丢掉它返回的 cleanup，旧请求仍 alive，
  // 谁后到谁覆盖——旧响应可能把刚刷出的新任务冲掉。用递增请求号代替 alive 闭包，
  // 只有最新一次请求才允许落状态。
  const latestRequestRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++latestRequestRef.current;
    const isLatest = () => requestId === latestRequestRef.current;
    setLoading(true);
    setError(null);
    fetchMyTeamTasks()
      .then((res) => {
        if (!isLatest()) return;
        setTasks(res.tasks);
        setClaimable(res.claimable ?? []);
      })
      .catch(() => {
        if (!isLatest()) return;
        // 读失败 ≠ 没有任务：分开说，别让用户以为没人给他派活。
        setTasks(null);
        setClaimable([]);
        setError("没读到团队任务：可能是网络或服务端暂时不可用。");
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
    return () => {
      // 卸载时把请求号推进一步，任何在途响应都不再落状态。
      latestRequestRef.current += 1;
    };
  }, [load]);

  const empty = tasks !== null && tasks.length === 0 && claimable.length === 0;

  return (
    <Dialog
      ariaLabel="我的任务"
      title="我的任务"
      description="派到你名下、还没完成的团队任务；队里没人认领的活也列在这里"
      size="md"
      maxHeightVh={80}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => load()}>
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="ui-caption" data-testid="my-tasks-loading">
          正在读团队任务…
        </p>
      ) : error !== null ? (
        <p className="ui-caption text-danger" data-testid="my-tasks-error">
          {error}
        </p>
      ) : empty ? (
        <p className="ui-caption" data-testid="my-tasks-empty">
          现在没有派到你名下的任务。组长派活之后，这里会出现，并且每轮对话都会提醒和鸣。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {(tasks ?? []).length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {(tasks ?? []).map((item) => {
                const meta = describeMyTaskMeta(item);
                return (
                  <li key={`${item.teamId}:${item.task.id}`}>
                    <button
                      type="button"
                      aria-label={`让和鸣接着做：${item.task.title}`}
                      className="ui-hit flex w-full flex-col items-start gap-0.5 rounded-md border border-line-soft px-3 py-2 text-left hover:bg-subtle-2"
                      data-testid={`my-task-${item.task.id}`}
                      onClick={() => onPick(item, buildMyTaskPrompt(item))}
                    >
                      <span className="w-full truncate text-ui-sm text-ink">{item.task.title}</span>
                      <span className="w-full truncate text-ui-xs text-muted">{meta}</span>
                      <span className="text-ui-xs text-accent">让它接着做 →</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {claimable.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="ui-caption" data-testid="claimable-heading">
                队里待认领（{claimable.length}）：没写负责人的活，谁接谁做
              </p>
              <ul className="flex flex-col gap-1.5">
                {claimable.map((item) => {
                  const meta = describeMyTaskMeta(item);
                  return (
                    <li key={`claimable:${item.teamId}:${item.task.id}`}>
                      <button
                        type="button"
                        aria-label={`认领并接着做：${item.task.title}`}
                        className="ui-hit flex w-full flex-col items-start gap-0.5 rounded-md border border-line-soft px-3 py-2 text-left hover:bg-subtle-2"
                        data-testid={`claimable-task-${item.task.id}`}
                        onClick={() => onPick(item, buildClaimTaskPrompt(item))}
                      >
                        <span className="w-full truncate text-ui-sm text-ink">{item.task.title}</span>
                        <span className="w-full truncate text-ui-xs text-muted">{meta}</span>
                        <span className="text-ui-xs text-accent">认领并接着做 →</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
