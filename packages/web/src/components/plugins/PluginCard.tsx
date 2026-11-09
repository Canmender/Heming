import type { InstalledPlugin } from "../../lib/plugins/index.js";
import {
  contributionCountsOf,
  contributionText,
  isPartiallyDisabled,
  partialDisabledTitle,
  permissionText,
  permissionViewOf,
} from "./viewModel.js";
import {
  BTN_DANGER_SM,
  BTN_GHOST_SM,
  CHIP,
  HINT,
  PLUGIN_CARD,
  Switch,
  formatAt,
} from "./shared.js";

/**
 * 插件卡（d.64 · T2）：在原有安装/更新/停用/卸载/详情之外，
 * 补「贡献」行（技能 N · 服务 N · 命令 N）与「权限」摘要（主机数 / 风险上限）。
 *
 * 2026-11 UI/UX 轮：左侧图标砖 + 状态点给出「一眼可见的启停」，描述限两行，
 * 底部按「时间 / 动作」分组；可访问名、贡献与权限原文保持不变。
 *
 * 停用插件照常显示声明贡献：停用是「现在不生效」，不是「没装」；
 * 权限摘要对 v1/v2 旧包明说「未声明」，避免让用户以为旧包也受新权限约束。
 */
export function PluginCard({
  plugin,
  highlighted,
  onDetail,
  onToggle,
  onRemove,
  onGoSkills,
  onGoInterfaces,
}: {
  plugin: InstalledPlugin;
  highlighted: boolean;
  onDetail: () => void;
  onToggle: (next: boolean) => void;
  onRemove: () => void;
  onGoSkills: () => void;
  onGoInterfaces: () => void;
}) {
  const manifest = plugin.manifest;
  const counts = contributionCountsOf(plugin);
  const permission = permissionViewOf(manifest);
  const skillNames = manifest.contributions.skills.map((skill) => skill.name);
  const partiallyDisabled = isPartiallyDisabled(plugin);
  const initial = Array.from(manifest.name)[0]?.toUpperCase() ?? "?";

  return (
    <section
      data-plugin-id={manifest.id}
      data-enabled={plugin.enabled}
      role="region"
      aria-label={`插件 ${manifest.name}`}
      className={`${PLUGIN_CARD} plugin-card p-4 ${highlighted ? "ring-2 ring-[#1a1a1a]/25" : ""}`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="plugin-icon-tile h-9 w-9 text-[13px] font-bold"
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-extrabold">{manifest.name}</span>
            <span className={CHIP}>v{manifest.version}</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <span
                aria-hidden="true"
                className="plugin-dot"
                data-off={plugin.enabled ? undefined : "true"}
                data-warn={partiallyDisabled && plugin.enabled ? "true" : undefined}
              />
              {plugin.enabled ? "已启用" : "已停用"}
            </span>
            {partiallyDisabled && (
              <span className={CHIP} title={partialDisabledTitle(plugin)}>
                部分停用
              </span>
            )}
          </div>
          <div className={`mt-0.5 ${HINT}`}>
            {manifest.id}
            {manifest.author ? ` · ${manifest.author}` : ""} · {counts.skills} 个技能 ·{" "}
            {counts.servers} 台 MCP 服务
          </div>
        </div>
        <Switch
          label={`启用插件 ${manifest.name}`}
          checked={plugin.enabled}
          onChange={onToggle}
        />
      </div>

      <p className="mt-2 line-clamp-2 break-words ui-body-sm text-muted">
        {manifest.description || "暂无描述"}
      </p>

      {/* 贡献与权限：统一能力中枢的两条摘要，点详情看完整清单 */}
      <dl className="mt-2 grid gap-x-4 gap-y-1 ui-caption sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="inline text-muted">贡献：</dt>
          <dd className="inline">{contributionText(counts)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="inline text-muted">权限：</dt>
          <dd className="inline">{permissionText(permission)}</dd>
        </div>
      </dl>

      <div className="mt-2 flex flex-wrap gap-1">
        {skillNames.map((name) => (
          <span key={`skill:${name}`} className={CHIP}>
            {name}
          </span>
        ))}
        {manifest.contributions.mcpServers.map((server) => (
          <span key={`server:${server.key}`} className={CHIP} title={server.url}>
            MCP · {server.name}
          </span>
        ))}
        {counts.commands > 0 && (
          <span className={CHIP} title="安装后出现在命令面板">
            命令 · {counts.commands}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2.5 ui-caption">
        <span className="text-muted">安装于 {formatAt(plugin.installedAt)}</span>
        <span className="text-muted">· 更新于 {formatAt(plugin.updatedAt)}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label={`查看插件详情 ${manifest.name}`}
            onClick={onDetail}
            className={BTN_GHOST_SM}
          >
            详情
          </button>
          {manifest.contributions.mcpServers.length > 0 && (
            <button
              type="button"
              aria-label={`查看插件 MCP 服务 ${manifest.name}`}
              onClick={onGoInterfaces}
              className={BTN_GHOST_SM}
            >
              查看 MCP 服务
            </button>
          )}
          <button
            type="button"
            aria-label={`查看插件技能 ${manifest.name}`}
            onClick={onGoSkills}
            className={BTN_GHOST_SM}
          >
            查看技能
          </button>
          <button
            type="button"
            aria-label={`卸载插件 ${manifest.name}`}
            onClick={onRemove}
            className={BTN_DANGER_SM}
          >
            卸载
          </button>
        </div>
      </div>
    </section>
  );
}
