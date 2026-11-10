/**
 * 智能体页的一级 Tab（d.126 阶段 B）：**对话 / 协作 / 智能体**。
 *
 * 为什么把「读存储 → 归一 → 合法值」单独放一个纯模块：
 * - 旧版本存过 `work`（对话）与 `chat` / `tasks`（更早的「通用智能体 → 任务区」），
 *   这些值必须继续归一到「对话」，不能刷新后落到空白视图；
 * - 归一规则是纯函数，组件测试可以直接断言，不必渲染整页。
 */

/** 三个一级 Tab 的稳定键。 */
export type AssistantTab = "chat" | "collab" | "agents";

/** sessionStorage 键：沿用 v1，保住老用户的 Tab 记忆。 */
export const ASSISTANT_TAB_KEY = "heming.tab.assistant.v1";

/**
 * 允许出现在存储里的全部字面量（含历史值）。
 * `chat` 同时是「新版对话 Tab」和「旧版任务区折叠值」，语义本来就一致，无需区分。
 */
export const ASSISTANT_STORED_TABS = ["chat", "collab", "agents", "work", "tasks"] as const;
export type StoredAssistantTab = (typeof ASSISTANT_STORED_TABS)[number];

/** 展示顺序 + 文案：一级 Tab 用现有 PAGE_TAB 下划线样式。 */
export const ASSISTANT_TAB_ITEMS: readonly { key: AssistantTab; label: string }[] = [
  { key: "chat", label: "对话" },
  { key: "collab", label: "协作" },
  { key: "agents", label: "智能体" },
];

/**
 * 存储值 → 实际视图。旧值 `work` / `tasks` / 旧 `chat` 一律落到「对话」。
 * 不做「猜」：不在白名单里的值由 `useSessionTab` 先回落默认值。
 */
export function normalizeAssistantTab(stored: StoredAssistantTab): AssistantTab {
  if (stored === "collab") return "collab";
  if (stored === "agents") return "agents";
  return "chat";
}

/** 是否是需要回写新值的旧键（迁移用：读到旧值就顺手写成规范值，下次不再走归一分支）。 */
export function isLegacyAssistantTab(stored: StoredAssistantTab): boolean {
  return stored === "work" || stored === "tasks";
}
