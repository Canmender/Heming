import { AutomationHomePage } from "./components/AutomationHomePage.js";
import { StaffHomeCard } from "../../staff/src/components/StaffHomeCard.js";
import { useStaffLoop } from "../../staff/src/lib/staff/loop.js";
import { useAutomationScheduler } from "./lib/automation/scheduler.js";
import { useWorkflowScheduler } from "../../workflows/src/lib/workflow/scheduler.js";

/**
 * 自动化插件（d.134）：一个页面 = 定时任务 + 工作流 + 简报。
 * 后台巡检/调度仍随插件常驻；旧 staff/workflows 模块 id 只用于数据兼容，不再单独安装。
 */
export const manifest = { id: "heming.automations", version: "1.0.0" };

export const pages = { automations: AutomationHomePage };
export const homeCards = { automations: StaffHomeCard };

export function AutomationBackground({ active }: { active: boolean }) {
  useStaffLoop(active);
  useAutomationScheduler(active);
  useWorkflowScheduler(active);
  return null;
}

export const background = { automations: AutomationBackground };
