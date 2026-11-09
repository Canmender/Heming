import type { PluginPermissionView } from "./viewModel.js";
import { hostPreview } from "./viewModel.js";

/**
 * 权限清单（安装预览 / 详情抽屉共用）。
 *
 * 展示顺序固定：网络 -> 工具风险上限 -> 文件根。
 * 网络只列前 3 行，其余折成「共 N 项」——插件允许 20 个主机，
 * 全量铺开会把弹窗撑满，用户真正要看的是「大概访问哪些、总数多少」。
 */
export function PluginPermissionList({
  view,
  schemaVersion,
}: {
  view: PluginPermissionView;
  schemaVersion: number;
}) {
  const network = hostPreview(view);
  return (
    <div aria-label="插件权限" className="mt-2 rounded-lg border border-line-soft bg-white p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-section-title">权限</span>
        {view.legacy ? (
          <span className="ui-chip">旧格式清单 v{schemaVersion}</span>
        ) : (
          <span className="ui-chip">{view.accepted ? "已声明" : "存在未声明主机"}</span>
        )}
      </div>

      <dl className="mt-1.5 grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 ui-caption">
        <dt className="text-muted">网络</dt>
        <dd className="min-w-0">
          {view.legacy ? (
            <span>未声明；按服务地址放行（安装时已确认的既有事实）</span>
          ) : network.total === 0 ? (
            <span>不访问网络</span>
          ) : (
            <span className="break-all">
              {network.shown.join("、")}
              {network.more > 0 ? ` 等，共 ${network.total} 项` : `（共 ${network.total} 项）`}
            </span>
          )}
        </dd>
        <dt className="text-muted">工具风险</dt>
        <dd>
          上限 {view.ceilingLabel}
          {view.ceiling === "read" ? "（写工具不注入）" : ""}
        </dd>
        <dt className="text-muted">文件根</dt>
        <dd>
          {view.files.length > 0 ? (
            <>
              {view.files.join("、")}
              <span className="ui-micro block text-muted">预留字段：当前不生效（插件不带文件工具）</span>
            </>
          ) : (
            "未声明（预留字段，当前不生效）"
          )}
        </dd>
      </dl>

      {view.legacy && (
        <p className="mt-1 ui-caption">
          旧格式清单（v{schemaVersion}）：没有声明权限，安装时按你确认过的服务地址放行。
        </p>
      )}
    </div>
  );
}
