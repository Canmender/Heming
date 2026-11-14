import type { InstalledPlugin } from "../../lib/plugins/index.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { Button } from "../ui/Button.js";

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
      title="卸载插件？"
      onCancel={onCancel}
      footer={
        <>
          <Button
            type="button"
            onClick={onCancel}
            size="md" variant="ghost" className="text-muted"
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            size="md" variant="danger"
          >
            卸载
          </Button>
        </>
      }
    >
      <p className="ui-body-sm">
        插件「{plugin.manifest.name}」卸载后不可恢复：{plugin.skillIds.length} 个技能（含使用统计与智能体分配）与{" "}
        {plugin.serverIds.length} 台 MCP 服务（含工具清单与启用状态）会一并删除。
      </p>
    </ConfirmDialog>
  );
}
