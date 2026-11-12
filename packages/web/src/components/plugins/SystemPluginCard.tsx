import type { SystemPlugin } from "../../lib/plugins/index.js";
import { ShieldIcon } from "../icons.js";
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
      className="ui-card plugin-card mb-4 bg-[var(--panel)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="plugin-icon-tile h-8 w-8" aria-hidden="true">
          <ShieldIcon width={15} height={15} />
        </span>
        <span className="text-[13px] font-extrabold">{system.name}</span>
        <span className={CHIP}>内置</span>
        <span className={CHIP}>v{system.version}</span>
        {/* 只留「内置 + 版本」两枚：原来还有「置顶」「随应用内置」，四个胶囊里两个在说同一件事，
            而卡片底部那句已经写清「不可停用或卸载」。 */}
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

      {/* 这句不再重复上面那句「随应用内置…不可停用或卸载」，只补一个不同的事实：更新方式。 */}
      <p className="mt-2 ui-caption">技能与工具随应用版本更新，无需单独升级。</p>
    </section>
  );
}
