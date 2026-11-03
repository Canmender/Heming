import type { SystemPlugin } from "../../lib/plugins/index.js";
import { CHIP } from "./shared.js";

/**
 * 系统插件卡片（d.65 · T2）：插件 Tab 顶部固定、置顶只读。
 *
 * 它把内置技能 / 预置 MCP 服务 / 内置工具收进插件模型，但**不是**可安装包：
 * - 没有启用开关、没有卸载/更新按钮（`pinned/uninstallable` 是类型上的事实，不是隐藏）；
 * - 不写 `heming.plugins.v1`、不计入 `MAX_PLUGINS`；
 * - 卡片只展示「它贡献了什么」，深度管理仍去技能区/接口区。
 */
export function SystemPluginCard({ system }: { system: SystemPlugin }) {
  return (
    <section
      aria-label="系统能力"
      data-testid="system-plugin-card"
      className="mb-4 rounded-xl border border-line bg-panel p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-extrabold">{system.name}</span>
        <span className={CHIP}>内置</span>
        <span className={CHIP}>置顶</span>
        <span className={CHIP}>v{system.version}</span>
        <span className={`ml-auto ${CHIP}`}>随应用内置</span>
      </div>
      <p className="mt-1 ui-caption">{system.description}</p>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 ui-body-sm">
        <div>
          <dt className="inline text-muted">技能 </dt>
          <dd className="inline ui-numeric font-medium">{system.counts.skills}</dd>
        </div>
        <div>
          <dt className="inline text-muted">服务 </dt>
          <dd className="inline ui-numeric font-medium">{system.counts.servers}</dd>
        </div>
        <div>
          <dt className="inline text-muted">工具 </dt>
          <dd className="inline ui-numeric font-medium">{system.counts.tools}</dd>
        </div>
      </dl>

      <p className="mt-2 ui-caption">随应用内置，不可停用或卸载；其技能与工具随应用版本更新。</p>
    </section>
  );
}
