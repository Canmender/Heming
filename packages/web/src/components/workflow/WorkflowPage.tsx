/**
 * 工作流页面壳：页头 + 三个 Tab（工作流 / 执行记录 / 凭据）+ 编辑器切换。
 *
 * 为什么把「列表 / 执行记录 / 凭据」放同一页而不是三个导航项：它们是同一个能力的
 * 三个侧面，用户在工作流里配置 HTTP 认证时不该先切到别的页面；执行记录也要能
 * 从工作流列表直接点开。导航只保留一个「工作流」入口，减少侧栏噪音。
 *
 * 模块加载时**注册一次节点库**（`registerAllNodes`）：调色板、模板、参数表单
 * 全部依赖注册表。放在模块顶层而不是 effect 里，是为了让页面首次渲染时
 * 模板也能构建；`registerAllNodes` 自身幂等，重复 import/热更新不会重复注册抛错。
 */

import { useState } from "react";
import { registerAllNodes } from "../../lib/workflow/nodes/index.js";
import { useWorkflowStore } from "../../lib/workflow/store.js";
import { useWorkflowExecutionsStore } from "../../lib/workflow/executions.js";
import { useWorkflowCredentialsStore } from "../../lib/workflow/credentials.js";
import { createWorkflowRuntime } from "../../lib/workflow/runtime.js";
import { PageShell } from "../layout/PageShell.js";
import { WorkflowList } from "./WorkflowList.js";
import { WorkflowEditor } from "./WorkflowEditor.js";
import { ExecutionsPanel } from "./ExecutionsPanel.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

registerAllNodes();

type WorkflowTab = "workflows" | "executions" | "credentials";

const TAB_LABEL: Record<WorkflowTab, string> = {
  workflows: "工作流",
  executions: "执行记录",
  credentials: "凭据",
};

export function WorkflowPage() {
  const workflows = useWorkflowStore((state) => state.workflows);
  const selectedId = useWorkflowStore((state) => state.selectedId);
  const select = useWorkflowStore((state) => state.select);
  const executions = useWorkflowExecutionsStore((state) => state.executions);
  const credentials = useWorkflowCredentialsStore((state) => state.credentials);
  const [tab, setTab] = useState<WorkflowTab>("workflows");

  const selected = workflows.find((workflow) => workflow.id === selectedId);

  if (selected) {
    return (
      <PageShell
        title="工作流"
        subtitle={selected.description ?? "拖动节点、连线，让一条流程替你跑重复的事。"}
        width="full"
        scroll={false}
      >
        <WorkflowEditor workflow={selected} onBack={() => select(null)} />
      </PageShell>
    );
  }

  const counts: Record<WorkflowTab, number> = {
    workflows: workflows.length,
    executions: executions.length,
    credentials: credentials.length,
  };

  async function rerun(executionId: string): Promise<void> {
    const execution = useWorkflowExecutionsStore
      .getState()
      .executions.find((item) => item.id === executionId);
    if (!execution) return;
    const workflow = useWorkflowStore.getState().workflows.find((item) => item.id === execution.workflowId);
    if (!workflow) return;
    // 重跑用新的手动执行：旧记录的输入数据只在调试时有意义，重跑按当前工作流版本走。
    const runtime = createWorkflowRuntime();
    await runtime.run(workflow, { mode: "manual" });
  }

  return (
    <PageShell
      title="工作流"
      subtitle="节点式自动化：手动/定时触发，按步骤处理数据，执行记录只存本机。"
      width="full"
      scroll={false}
      headerExtra={
        <div
          role="tablist"
          aria-label="工作流分区"
          className="flex gap-1 px-6 max-[1199px]:px-4"
        >
          {(Object.keys(TAB_LABEL) as WorkflowTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`workflow-tabpanel-${key}`}
              id={`workflow-tab-${key}`}
              onClick={() => setTab(key)}
              className={`border-b-2 px-3 py-2 text-[12px] ${
                tab === key
                  ? "border-ink font-medium text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {TAB_LABEL[key]}
              {counts[key] > 0 ? <span className="ml-1 text-[10px] text-muted">{counts[key]}</span> : null}
            </button>
          ))}
        </div>
      }
    >
      <div
        role="tabpanel"
        id={`workflow-tabpanel-${tab}`}
        aria-labelledby={`workflow-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5 max-[1199px]:px-4"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[1100px] flex-col">
          {tab === "workflows" ? <WorkflowList onOpen={(workflow) => select(workflow.id)} /> : null}
          {tab === "executions" ? (
            <ExecutionsPanel
              onRerun={(execution) => {
                void rerun(execution.id);
              }}
            />
          ) : null}
          {tab === "credentials" ? <CredentialsPanel /> : null}
        </div>
      </div>
    </PageShell>
  );
}
