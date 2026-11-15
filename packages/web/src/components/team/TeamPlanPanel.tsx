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
import { Button } from "../../components/ui/Button.js";

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
  doing: "border-info-line bg-info-soft text-info",
  done: "border-success-line bg-success-soft text-success",
  blocked: "border-warn-line bg-warn-soft text-warn",
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
  /** 面板内的失败同时上报给页级错误条（上一轮 TeamWorkspace 已在传，这里补上类型与调用）。 */
  onError?: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [adding, setAdding] = useState(false);
  /** 待删除方案：先出应用内确认框，确认后才真的发请求（取消不发）。 */
  const [pendingDelete, setPendingDelete] = useState<TeamPlanItem | null>(null);
  /** 打开确认框时焦点落在「取消」：误按回车不会执行破坏性操作。 */
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /**
   * 面板自己的错误：就地显示在方案卡片里，而不是只写到页顶（W-06）。
   * 关闭按钮或下一次成功提交时清掉，避免一次失败长期挂在那里。
   */
  const [panelError, setPanelError] = useState("");
  /** 添加方案的提交中标记：双击「保存」只允许发一次请求（W-04）。 */
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /**
   * 正在切状态/删除的方案 id：ref 做同步判定（两次点击可能同帧发生），
   * state 只负责禁用按钮，连点第二下不会再发请求、只前进一档。
   */
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  /** 点击时取最新 props 里的方案，避免用闭包里的旧状态算下一档。 */
  const plansRef = useRef(plans);
  plansRef.current = plans;

  const isPending = (id: string) => pendingIds.includes(id);

  const beginPending = (id: string) => {
    if (pendingRef.current.has(id)) return false;
    pendingRef.current.add(id);
    setPendingIds([...pendingRef.current]);
    return true;
  };

  const endPending = (id: string) => {
    pendingRef.current.delete(id);
    setPendingIds([...pendingRef.current]);
  };

  const refresh = async () => onChanged(await fetchWorkspaceTeam(teamId));

  /** 面板内的失败：既就地显示在方案卡片里，也上报给页级错误条。 */
  const report = (message: string) => {
    setPanelError(message);
    onError?.(message);
  };

  const add = async () => {
    const clean = title.trim();
    if (!clean) {
      report("请填写方案标题");
      return;
    }
    // 服务端没有创建方案的幂等键：重复提交会真的多出一条方案（W-04）。
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setPanelError("");
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
      report(err instanceof Error && err.message ? err.message : "添加方案失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const cycle = async (plan: TeamPlanItem) => {
    if (!beginPending(plan.id)) return;
    setPanelError("");
    try {
      // 用最新 props 里的状态算下一档；pending 期间第二下点击被忽略。
      const latest = plansRef.current.find((p) => p.id === plan.id) ?? plan;
      await updateTeamPlan(teamId, plan.id, { status: NEXT_STATUS[latest.status] });
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "更新方案失败");
    } finally {
      endPending(plan.id);
    }
  };

  const remove = async (plan: TeamPlanItem) => {
    if (!beginPending(plan.id)) return;
    setPanelError("");
    try {
      await deleteTeamPlan(teamId, plan.id);
      await refresh();
    } catch (err) {
      report(err instanceof Error && err.message ? err.message : "删除方案失败");
    } finally {
      endPending(plan.id);
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
        <h2 className="ui-block-title">方案</h2>
        <span className="ui-micro">{plans.length}</span>
        <button
          type="button"
          className="ui-link ml-auto"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "取消" : "添加方案"}
        </button>
      </div>

      {panelError && (
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-lg border border-danger-line bg-danger-soft px-2.5 py-2 text-ui-sm text-danger"
        >
          <span className="min-w-0 flex-1 break-words">{panelError}</span>
          <button
            type="button"
            className="shrink-0 text-ui-xs underline"
            onClick={() => setPanelError("")}
          >
            关闭
          </button>
        </p>
      )}

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
          <Button
            type="submit"
            size="sm" variant="primary" className="mt-2"
            disabled={busy || saving}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
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
              <span className="mt-0.5 w-4 shrink-0 text-ui-xs tabular-nums text-muted">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-ui-md font-medium">{plan.title}</span>
                  <button
                    type="button"
                    onClick={() => void cycle(plan)}
                    disabled={isPending(plan.id)}
                    title="点击切换状态"
                    className={`rounded-full border px-1.5 py-0.5 text-ui-xs ${STATUS_STYLE[plan.status]} ${
                      isPending(plan.id) ? "opacity-60" : ""
                    }`}
                  >
                    {PLAN_STATUS_LABEL[plan.status]}
                  </button>
                </div>
                {plan.detail && (
                  <p className="mt-0.5 whitespace-pre-wrap text-ui-xs leading-5 text-muted">
                    {plan.detail}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={`删除方案 ${plan.title}`}
                className="shrink-0 text-ui-xs text-muted hover:text-danger disabled:opacity-60"
                disabled={isPending(plan.id)}
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
          title="删除方案？"
          onCancel={() => setPendingDelete(null)}
          initialFocusRef={cancelRef}
          footer={
            <>
              <Button
                type="button"
                ref={cancelRef}
                size="md" variant="ghost"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant="danger"
                onClick={() => void confirmRemove()}
              >
                删除
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            删除方案「{pendingDelete.title}」？方案本身删除后不可恢复；挂在它下面的任务会保留，但会解绑为「不挂方案」。
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
