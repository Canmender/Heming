import { useAutomationStore } from "../automation/store.js";
import { useStaffStore } from "../staff/store.js";
import type { ModuleId } from "./registry.js";

/**
 * 内置能力模块的「清理本机数据」（d.71 收尾轮）。
 *
 * 为什么不在卡片上直接删 localStorage 键：这些模块的数据同时活在 zustand store 的内存里，
 * 只删磁盘会出现「界面还有、下一次写入又回来」的假清理。所以清理动作必须走各模块
 * 自己的 store 方法——清内存、清磁盘、并遵守模块自己的级联规则（删任务级联删运行记录）。
 *
 * 边界：
 * - **只清内容，不清配置**：幕僚保留「是否常驻 / 来源 / 频率」设置，只清简报与已见账本；
 * - **不可恢复**：弹窗里逐项写明会删什么，确认后才执行；
 * - **信息中枢没有清理入口**：归档与配置由 InfoHub 自己管理，和鸣只读，删它们不是和鸣的权限。
 */

export interface ModuleCleanupPlan {
  /** 弹窗标题（“清理「幕僚」的本机数据？”）。 */
  title: string;
  /** 一句后果说明。 */
  description: string;
  /** 逐项列出会被删除的内容（渲染成列表）。 */
  items: string[];
  /** 执行清理；返回错误文案表示本轮不能清理（例如自动化任务正在运行）。 */
  run: () => string | null;
}

/** 哪些模块有清理入口（没有返回 null 的模块，卡片上不显示按钮）。 */
export function moduleCleanupPlan(id: ModuleId): ModuleCleanupPlan | null {
  if (id === "staff") {
    return {
      title: "清理「幕僚」的本机数据？",
      description: "会删除历史上生成过的简报与已见账本；「是否常驻、来源、频率」等设置会保留。",
      items: [
        "全部历史简报（首页幕僚卡会回到「还没有简报」）",
        "已见账本（清空后同样的日程/任务可能再次提醒一次）",
      ],
      run: () => {
        useStaffStore.getState().clearHistory();
        return null;
      },
    };
  }
  if (id === "automations") {
    return {
      title: "清理「自动化」的本机数据？",
      description: "会删除全部自动化任务及其运行记录，不可恢复；模块开关状态不变。",
      items: [
        "全部自动化任务（含下次执行时间与启用状态）",
        "每个任务对应的运行记录",
      ],
      run: () => {
        const store = useAutomationStore.getState();
        // 正在跑的任务不清：remove 后 finishRun 会找不到目标，记录与状态会不一致。
        if (store.runningId) {
          return "有自动化任务正在运行，请等它结束或先停用模块后再清理。";
        }
        for (const task of [...store.tasks]) store.remove(task.id);
        return null;
      },
    };
  }
  return null;
}
