import type { InstalledPlugin } from "../../lib/plugins/index.js";
import { ConfirmDialog } from "../ConfirmDialog.js";

/**
 * 卸载插件的二次确认（d.64 · T2 拆出）。
 *
 * 文案必须把「删什么」说全：技能（含使用统计与智能体分配）与服务（含工具清单与启用状态）
 * 都会一并删除，且不可恢复——这是页面上破坏性最强的一个操作。
 */
export function RemovePluginDialog({
  plugin,
  onCancel,
  onConfirm,
}: {
  plugin: InstalledPlugin;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title="卸载插件"
      onCancel={onCancel}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="ui-btn ui-btn-md ui-btn-ghost text-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="ui-btn ui-btn-md ui-btn-danger"
          >
            卸载
          </button>
        </>
      }
    >
      <p className="text-[12px] leading-6">
        卸载插件「{plugin.manifest.name}」？它的 {plugin.skillIds.length}{" "}
        个技能（含使用统计与智能体分配）与 {plugin.serverIds.length}{" "}
        台 MCP 服务（含工具清单与工具启用状态）都会一并删除，此操作不可恢复。
      </p>
    </ConfirmDialog>
  );
}
