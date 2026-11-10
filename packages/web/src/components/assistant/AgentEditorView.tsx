import type { Agent } from "@heming/shared";
import { AgentFormPanel } from "./AgentFormPanel.js";

/**
 * 智能体 Tab · 编辑页（d.126 阶段 B）。
 *
 * 「编辑智能体」从弹窗改成页内视图：同一 Tab 内从名册换成表单，保存/取消后回名册。
 * 表单实现仍是 `AgentFormPanel`（`variant="page"`）——与弹窗共用字段、校验与删除确认，
 * 只是去掉遮罩与模态语义，不再把用户从页面里拽进一层弹窗。
 */

export interface AgentEditorViewProps {
  mode: "create" | "edit";
  /** 编辑时的目标智能体（新建不传）。 */
  agent?: Agent;
  /** 新建时焦点落点：名称 / 第一个模板。 */
  startAt?: "name" | "templates";
  /** 创建成功回调（智能体页据此直接切到对话并打开会话）。 */
  onCreated?: (created: Agent) => void;
  /** 返回名册（取消 / 保存成功 / 删除成功都走这里）。 */
  onClose: () => void;
}

export function AgentEditorView({
  mode,
  agent,
  startAt = "name",
  onCreated,
  onClose,
}: AgentEditorViewProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-6 py-5 max-[1199px]:px-4">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="返回智能体名册"
            className="ui-btn ui-btn-sm ui-btn-ghost"
          >
            ‹ 返回名册
          </button>
          <span className="ui-caption">智能体 · {mode === "create" ? "新建" : "编辑"}</span>
        </div>
        <AgentFormPanel
          variant="page"
          mode={mode}
          {...(agent ? { agent } : {})}
          startAt={startAt}
          {...(onCreated ? { onCreated } : {})}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
