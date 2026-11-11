import { WorkflowPage as Page } from "./components/workflow/WorkflowPage.js";
import { useWorkflowScheduler } from "./lib/workflow/scheduler.js";

/**
 * 工作流模块（d.131 M5）：画布/编辑器/引擎/到点调度全部随模块包分发。
 * 执行数据仍在 localStorage；HTTP 凭据走宿主 secureStorage 桥（受权限/加密能力约束）。
 */
export const manifest = { id: "workflows", version: "1.0.0" };

export const pages = { workflows: Page };

export function WorkflowBackground({ active }: { active: boolean }) {
  useWorkflowScheduler(active);
  return null;
}

export const background = { workflows: WorkflowBackground };
