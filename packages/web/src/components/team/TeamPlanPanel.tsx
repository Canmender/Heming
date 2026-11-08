import { useRef, useState } from "react";
import type { TeamItemStatus, TeamPlanItem, TeamWorkspaceSnapshot } from "@heming/shared";
import {
  createTeamPlan,
  deleteTeamPlan,
  fetchWorkspaceTeam,
  updateTeamPlan,
} from "../../lib/api.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";
import { ConfirmDialog } from "../ConfirmDialog.js";

/** 方案项状态的中文与流转顺序（点一下切下一档，与任务一致）。 */
export const PLAN_STATUS_LABEL: Record<TeamItemStatus, string> = {
  todo: "待开始",
  doing: "进行中",
  done: "已完成",
  blocked: "有卡点",
};

export const NEXT_STATUS: Record<TeamItemStatus, TeamItemStatus> = {
  todo: "doing",
  doing: "done",
  done: "todo",
  blocked: "doing",
};

const STATUS_STYLE: Record<TeamItemStatus, string> = {
  todo: "border-line text-muted",
  doing: "border-[#b2ddff] bg-[#eff8ff] text-[#175cd3]",
  done: "border-[#abefc6] bg-[#ecfdf3] text-[#067647]",
  blocked: "border-[#fedf89] bg-[#fffaeb] text-[#b45309]",
};

/**
 * 团队方案（d.92）：目标拆成的几条「打算怎么做」。
 *
 * 只做「标题 + 说明 + 状态 + 排序」四件事：方案不是文档编辑器，太长会变成没人更新的大纲。
 * 任务可以挂到方案下（TeamTaskPanel 的 planId 选择），这样「为什么做这件事」有出处。
 */
export function TeamPlanPanel({
  teamId,
  plans,
  busy,
  onChanged,
  onError,
}: {
  teamId: string;
  plans: TeamPlanItem[];
  busy: boolean;
  onChanged: (snapshot: TeamWorkspaceSnapshot) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [adding, setAdding] = useState(false);
  /** 待删除方案：先出应用内确认框，确认后才真的发请求（取消不发）。 */
  const [pendingDelete, setPendingDelete] = useState<TeamPlanItem | null>(null);
  /** 打开确认框时焦点落在「取消」：误按回车不会执行破坏性操作。 */
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const refresh = async () => onChanged(await fetchWorkspaceTeam(teamId));

  const add = async () => {
    const clean = title.trim();
    if (!clean) {
      onError("请填写方案标题");
      return;
    }
    try {
      await createTeamPlan(teamId, {
        title: clean,
        detail: detail.trim() || undefined,
        orderIndex: plans.length,
      });
      setTitle("");
      setDetail("");
      setAdding(false);
      await refresh();
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : "添加方案失败");
    }
  };

  const cycle = async (plan: TeamPlanItem) => {
    try {
      await updateTeamPlan(teamId, plan.id, { status: NEXT_STATUS[plan.status] });
      await refresh();
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : "更新方案失败");
    }
  };

  const remove = async (plan: TeamPlanItem) => {
    try {
      await deleteTeamPlan(teamId, plan.id);
      await refresh();
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : "删除方案失败");
    }
  };

  const confirmRemove = async () => {
    const plan = pendingDelete;
    if (!plan) return;
    setPendingDelete(null);
    await remove(plan);
  };

  return (
    <section aria-label="团队方案" className="ui-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="ui-section-title">方案</h2>
        <span className="ui-micro">{plans.length}</span>
        <button
          type="button"
          className="ui-link ml-auto"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "取消" : "添加方案"}
        </button>
      </div>

      {adding && (
        <form
          className="mt-2 rounded-lg border border-line-soft p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            aria-label="方案标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：先把周报自动化"
            className="ui-input w-full"
          />
          <textarea
            aria-label="方案说明"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="怎么做、验收标准（可选）"
            rows={2}
            className="ui-input mt-1.5 w-full resize-y"
          />
          <button
            type="submit"
            className="ui-btn ui-btn-sm ui-btn-primary mt-2"
            disabled={busy}
          >
            保存
          </button>
        </form>
      )}

      {plans.length === 0 ? (
        <p className="mt-2 ui-caption">
          还没有方案。方案是「从目标到任务」的中间层：先写几条做法，再把任务挂上去。
        </p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1.5">
          {plans.map((plan, i) => (
            <li
              key={plan.id}
              className={`flex items-start gap-2 rounded-lg border border-line-soft px-2.5 py-2 ${FOCUS_RING}`}
            >
              <span className="mt-0.5 w-4 shrink-0 text-[11px] tabular-nums text-muted">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium">{plan.title}</span>
                  <button
                    type="button"
                    onClick={() => void cycle(plan)}
                    title="点击切换状态"
                    className={`rounded-full border px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[plan.status]}`}
                  >
                    {PLAN_STATUS_LABEL[plan.status]}
                  </button>
                </div>
                {plan.detail && (
                  <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-5 text-muted">
                    {plan.detail}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={`删除方案 ${plan.title}`}
                className="shrink-0 text-[11px] text-muted hover:text-[var(--danger)]"
                onClick={() => setPendingDelete(plan)}
              >
                删除
              </button>
            </li>
          ))}
        </ol>
      )}
      {pendingDelete ? (
        <ConfirmDialog
          title="删除方案"
          onCancel={() => setPendingDelete(null)}
          initialFocusRef={cancelRef}
          footer={
            <>
              <button
                type="button"
                ref={cancelRef}
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-danger"
                onClick={() => void confirmRemove()}
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除方案「{pendingDelete.title}」？方案本身删除后不可恢复；挂在它下面的任务会保留，但会解绑为「不挂方案」。
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
