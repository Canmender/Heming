import { useEffect, useMemo, useState } from "react";
import { useAutomationStore } from "../lib/automation/store.js";
import { DEFAULT_DRAFT, ALL_WEEKDAYS, type AutomationKind } from "../lib/automation/model.js";
import { AutomationPage } from "./AutomationPage.js";
import { WorkflowPage } from "../../../workflows/src/components/workflow/WorkflowPage.js";
import { StaffPage } from "../../../staff/src/components/StaffPage.js";
import { useWorkflowStore } from "../../../workflows/src/lib/workflow/store.js";
import { createNode } from "../../../workflows/src/lib/workflow/model.js";
import { registerAllNodes } from "../../../workflows/src/lib/workflow/nodes/index.js";
import { useUiStore } from "@heming/sdk";

/**
 * 自动化插件主页（d.134 用户要求）。
 *
 * 一个页面，两条创建路径：
 * - **快速创建**：普通定时任务（每天几点、最多跑几次）；
 * - **完整创建**：工作流任务（定时触发节点 + 次数上限），创建后进入画布继续编排。
 *
 * 已有内容以 Tab 放在同一页：任务 / 工作流 / 简报（幕僚）。
 * 页面本身不再分三个导航入口；三个能力仍共用同一插件与同一份本机数据。
 */

type Tab = "tasks" | "workflows" | "briefing";
type CreateMode = "quick" | "full" | null;

const TABS: { key: Tab; label: string }[] = [
  { key: "tasks", label: "任务" },
  { key: "workflows", label: "工作流" },
  { key: "briefing", label: "简报" },
];

function todayTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

export function AutomationHomePage() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [mode, setMode] = useState<CreateMode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createTask = useAutomationStore((s) => s.create);
  const createWorkflow = useWorkflowStore((s) => s.create);
  const updateWorkflow = useWorkflowStore((s) => s.update);
  const consumeWorkflowFocus = useUiStore((s) => s.consumeWorkflowFocus);
  const consumeAutomationTab = useUiStore((s) => s.consumeAutomationTab);
  const automationTab = useUiStore((s) => s.automationTab);
  const workflowFocusId = useUiStore((s) => s.workflowFocusId);

  // 宿主通知/命令面板的 Tab 意图：切到对应 Tab 并清掉意图。
  useEffect(() => {
    if (!automationTab) return;
    setTab(automationTab);
    consumeAutomationTab();
  }, [automationTab, consumeAutomationTab]);

  // 「打开工作流」意图：切到工作流 Tab 并清掉意图。
  useEffect(() => {
    if (!workflowFocusId) return;
    setTab("workflows");
    consumeWorkflowFocus();
  }, [workflowFocusId, consumeWorkflowFocus]);

  // 快速创建表单
  const [quickName, setQuickName] = useState("每日同步归档");
  const [quickKind, setQuickKind] = useState<AutomationKind>("infohub.sync");
  const [quickTime, setQuickTime] = useState("09:00");
  const [quickRuns, setQuickRuns] = useState(0);
  // 完整创建工作流
  const [fullName, setFullName] = useState("我的定时工作流");
  const [fullTime, setFullTime] = useState("09:00");
  const [fullRuns, setFullRuns] = useState(0);

  useEffect(() => {
    registerAllNodes();
  }, []);

  const createQuick = () => {
    setError(null);
    const result = createTask({
      name: quickName.trim() || "定时任务",
      kind: quickKind,
      schedule: { type: "daily", time: quickTime, weekdays: [...ALL_WEEKDAYS] },
      sync: { ...DEFAULT_DRAFT.sync, sources: [...DEFAULT_DRAFT.sync.sources] },
      maxRuns: quickRuns > 0 ? quickRuns : undefined,
    });
    if (!result.ok) {
      setError(result.error ?? "创建失败");
      return;
    }
    setMode(null);
    setTab("tasks");
    setNotice(`已创建定时任务「${quickName.trim() || "定时任务"}」`);
  };

  const createFull = () => {
    setError(null);
    const created = createWorkflow({ name: fullName.trim() || "定时工作流" });
    if (!created.ok || !created.workflow) {
      setError(created.error ?? "创建工作流失败");
      return;
    }
    const [hour, minute] = fullTime.split(":").map((part) => Number(part));
    const trigger = createNode("scheduleTrigger", { position: { x: 80, y: 160 } });
    trigger.parameters = {
      ...trigger.parameters,
      triggerInterval: "days",
      intervalCount: 1,
      triggerAtHour: Number.isFinite(hour) ? hour : 9,
      triggerAtMinute: Number.isFinite(minute) ? minute : 0,
    };
    updateWorkflow(created.workflow.id, {
      nodes: [trigger],
      connections: {},
      active: true,
      maxRuns: fullRuns > 0 ? fullRuns : undefined,
      runCount: 0,
    });
    setMode(null);
    setTab("workflows");
    setNotice(`已创建定时工作流「${fullName.trim() || "定时工作流"}」`);
  };

  const pane = useMemo(() => {
    if (tab === "workflows") return <WorkflowPage />;
    if (tab === "briefing") return <StaffPage />;
    return <AutomationPage />;
    // 三个页面各自订阅自己的 store；切 Tab 时保留 store 状态，运行态不丢。
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line-soft px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-[18px] font-extrabold">自动化</h1>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              定时做重复的事：快速建一个普通定时任务，或完整创建一个可编排的工作流。任务与记录只存本机。
            </p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-md ui-btn-primary" onClick={() => setMode("quick")}>
              快速创建定时任务
            </button>
            <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={() => setMode("full")}>
              完整创建工作流
            </button>
          </div>
        </div>
      </header>

      {notice ? (
        <p role="status" className="border-b border-line-soft bg-[var(--success-soft)] px-5 py-1.5 text-[12px] text-[var(--success)]">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border-b border-line-soft bg-[var(--danger-soft)] px-5 py-1.5 text-[12px] text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-1 border-b border-line-soft px-5 py-2" role="tablist" aria-label="自动化视图">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`ui-btn ui-btn-sm ${tab === item.key ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">{pane}</div>

      {mode ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={mode === "quick" ? "快速创建定时任务" : "完整创建工作流"}
            className="ui-card w-[min(520px,94vw)] p-4"
          >
            <div className="flex items-center gap-2">
              <h2 className="ui-section-title">{mode === "quick" ? "快速创建定时任务" : "完整创建工作流"}</h2>
              <button
                type="button"
                aria-label="关闭"
                className="ml-auto rounded-sm p-1 text-muted hover:bg-[var(--subtle-3)]"
                onClick={() => setMode(null)}
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              {mode === "quick"
                ? "普通定时任务：按每天固定时刻执行一个本机动作；次数为 0 表示不限次数。"
                : "工作流任务：创建一条带定时触发的工作流，之后可在画布上继续加节点；次数为 0 表示不限次数。"}
            </p>

            <div className="mt-3 grid gap-3">
              <label className="grid gap-1 text-[12px]">
                <span className="font-medium">任务名称</span>
                <input
                  className="ui-input"
                  value={mode === "quick" ? quickName : fullName}
                  onChange={(e) => (mode === "quick" ? setQuickName(e.target.value) : setFullName(e.target.value))}
                  maxLength={40}
                />
              </label>
              {mode === "quick" ? (
                <label className="grid gap-1 text-[12px]">
                  <span className="font-medium">动作</span>
                  <select className="ui-input" value={quickKind} onChange={(e) => setQuickKind(e.target.value as AutomationKind)}>
                    <option value="infohub.sync">同步本机归档</option>
                    <option value="infohub.agenda">重扫日程</option>
                  </select>
                </label>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-[12px]">
                  <span className="font-medium">执行时间</span>
                  <input
                    type="time"
                    className="ui-input"
                    value={mode === "quick" ? quickTime : fullTime}
                    onChange={(e) => (mode === "quick" ? setQuickTime(e.target.value) : setFullTime(e.target.value))}
                  />
                </label>
                <label className="grid gap-1 text-[12px]">
                  <span className="font-medium">次数（0 = 不限）</span>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    className="ui-input"
                    value={mode === "quick" ? quickRuns : fullRuns}
                    onChange={(e) => {
                      const value = Math.max(0, Math.min(999, Number(e.target.value) || 0));
                      if (mode === "quick") setQuickRuns(value);
                      else setFullRuns(value);
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={() => setMode(null)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-primary"
                onClick={mode === "quick" ? createQuick : createFull}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
