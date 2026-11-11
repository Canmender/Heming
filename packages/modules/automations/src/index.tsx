import { AutomationPage } from "./components/AutomationPage.js";
import { useAutomationScheduler } from "./lib/automation/scheduler.js";

/** 自动化模块（d.131 M3）：页面 + 到点调度都由模块自己提供。 */
export const manifest = { id: "automations", version: "1.0.0" };

export const pages = { automations: AutomationPage };

export function AutomationBackground({ active }: { active: boolean }) {
  useAutomationScheduler(active);
  return null;
}

export const background = { automations: AutomationBackground };
