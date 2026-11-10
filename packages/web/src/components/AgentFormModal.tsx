import type { Agent } from "@heming/shared";
import { AgentFormPanel } from "./assistant/AgentFormPanel.js";

export { AGENT_TEMPLATES } from "./assistant/agentTemplates.js";
export type { AgentTemplate } from "./assistant/agentTemplates.js";

/**
 * 智能体创建/编辑弹窗（d.126 起只是**薄包装**）。
 *
 * 表单实现已抽到 `components/assistant/AgentFormPanel`（`variant="modal"`），
 * 因为智能体页本轮把「编辑智能体」改成独立页面（`variant="page"`）——
 * 两处必须共用同一份字段、校验、提交与删除确认，不能各写一套。
 *
 * 保留本组件与这些导出：`AgentFormModal` 仍被既有用例与其他入口引用，
 * 弹窗形态的 DOM/文案/焦点行为与 d.125 完全一致。
 */
export function AgentFormModal({
  open,
  mode,
  agent,
  startAt = "name",
  onCreated,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  agent?: Agent;
  /** 打开时把焦点放在哪：名册「＋ 新建」落在名称，「从模板创建」落在第一个模板。 */
  startAt?: "name" | "templates";
  /** 创建成功后回调（智能体页据此直接开始对话，不新增页面/路由）。 */
  onCreated?: (created: Agent) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <AgentFormPanel
      variant="modal"
      mode={mode}
      {...(agent ? { agent } : {})}
      startAt={startAt}
      {...(onCreated ? { onCreated } : {})}
      onClose={onClose}
    />
  );
}
