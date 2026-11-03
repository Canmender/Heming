import { useRef } from "react";
import type { InstalledPlugin, PluginServerInfo, PluginSkillInfo } from "../../lib/plugins/index.js";
import type { ToolPackGroup } from "./viewModel.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { PluginPermissionList } from "./PluginPermissionList.js";
import { BTN_DANGER_SM, BTN_GHOST, BTN_GHOST_SM, CHIP, HINT, formatAt } from "./shared.js";
import { contributionCountsOf, contributionText, permissionViewOf } from "./viewModel.js";

/**
 * 插件详情抽屉（d.64 · T2）：技能/服务两份物化清单之外，
 * 补「贡献」与「权限」两段——安装前的声明在装好之后也要能随时回看。
 */
export function PluginDetailDialog({
  plugin,
  skills,
  servers,
  toolPacks,
  hostOf,
  onClose,
  onRemove,
  onGoSkills,
  onGoInterfaces,
}: {
  plugin: InstalledPlugin;
  skills: PluginSkillInfo[];
  servers: PluginServerInfo[];
  /** 该插件的工具束（来自能力目录解析，含 matched/unresolved）。 */
  toolPacks: ToolPackGroup["packs"];
  hostOf: (url: string) => string;
  onClose: () => void;
  onRemove: () => void;
  onGoSkills: () => void;
  onGoInterfaces: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });
  const counts = contributionCountsOf(plugin);
  const permission = permissionViewOf(plugin.manifest);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`插件详情 ${plugin.manifest.name}`}
        className="flex max-h-[88vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="ui-section-title">插件详情</span>
          <button
            type="button"
            aria-label="关闭插件详情"
            onClick={onClose}
            className="rounded-sm p-1 text-muted hover:bg-[#f3f3f3] hover:text-ink"
          >
            <XIcon width={14} height={14} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-extrabold">{plugin.manifest.name}</span>
            <span className={CHIP}>v{plugin.manifest.version}</span>
            <span className={CHIP}>{plugin.enabled ? "已启用" : "已停用"}</span>
            <span className={CHIP}>schemaVersion {plugin.manifest.schemaVersion}</span>
          </div>
          <div className={`mt-0.5 ${HINT}`}>
            {plugin.manifest.id}
            {plugin.manifest.author ? ` · ${plugin.manifest.author}` : ""}
          </div>
          <p className="mt-2 break-words ui-body-sm text-[#555]">
            {plugin.manifest.description || "暂无描述"}
          </p>
          <div className={`mt-2 ${HINT}`}>
            安装于 {formatAt(plugin.installedAt)} · 更新于 {formatAt(plugin.updatedAt)}
            <br />
            停用插件会同时关闭其技能与 MCP 服务；数据与配置保留。
          </div>

          <section className="mt-4" aria-label="插件贡献">
            <h3 className="ui-section-title">贡献</h3>
            <p className="mt-1 ui-body-sm">{contributionText(counts)}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {plugin.manifest.contributions.commands.map((command) => (
                <span key={`command:${command.id}`} className={CHIP} title={command.description}>
                  命令 · {command.title}
                </span>
              ))}
            </div>
          </section>

          <section className="mt-4" aria-label="插件权限">
            <h3 className="ui-section-title">权限</h3>
            <PluginPermissionList
              view={permission}
              schemaVersion={plugin.manifest.schemaVersion}
            />
          </section>

          <section className="mt-4" aria-label="插件技能">
            <h3 className="ui-section-title">技能（{skills.length}）</h3>
            {skills.length === 0 ? (
              <p className={`mt-1 ${HINT}`}>本包未声明技能</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {skills.map((skill) => (
                  <li key={skill.id} className="ui-list-row flex-col items-start gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="ui-body-sm font-medium">{skill.name}</span>
                      <span className={CHIP}>{skill.enabled ? "启用" : "已停用"}</span>
                    </div>
                    {skill.description && <p className="ui-caption">{skill.description}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-4" aria-label="插件工具束">
            <h3 className="ui-section-title">工具束（{toolPacks.length}）</h3>
            {toolPacks.length === 0 ? (
              <p className={`mt-1 ${HINT}`}>本包未声明工具束</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1.5">
                {toolPacks.map((pack) => (
                  <li key={`${plugin.manifest.id}:${pack.id}`} className="ui-list-row flex-col items-start gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="ui-body-sm font-medium">{pack.name}</span>
                      {!pack.enabled && <span className={CHIP}>插件已停用</span>}
                      <span className={`ml-auto ${CHIP}`}>
                        已匹配 {pack.matched.length}/{pack.tools.length}
                      </span>
                    </div>
                    {pack.description && <p className="ui-caption">{pack.description}</p>}
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {pack.matched.map((name) => (
                        <span key={`matched:${name}`} className={CHIP}>
                          {name}
                        </span>
                      ))}
                      {pack.unresolved.map((name) => (
                        <span key={`unresolved:${name}`} className={`${CHIP} text-[#8a5a00]`}>
                          {name} · 未连接/未提供
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 ui-caption">
              工具束只声明归属，不改变任何工具开关；连接与授权在接口区进行。
            </p>
            {toolPacks.length > 0 && (
              <button type="button" onClick={onGoInterfaces} className={`mt-1 ${BTN_GHOST_SM}`}>
                在接口区管理
              </button>
            )}
          </section>

          <section className="mt-4" aria-label="插件 MCP 服务">
            <h3 className="ui-section-title">MCP 服务（{servers.length}）</h3>
            {servers.length === 0 ? (
              <p className={`mt-1 ${HINT}`}>本包未声明 MCP 服务</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {servers.map((server) => (
                  <li key={server.id} className="ui-list-row flex-col items-start gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="ui-body-sm font-medium">{server.name}</span>
                      <span className={CHIP}>{server.enabled ? "已启用" : "已停用"}</span>
                      <span className={CHIP}>{hostOf(server.url)}</span>
                    </div>
                    <code className="mt-0.5 block break-all text-[10px] text-muted">{server.url}</code>
                  </li>
                ))}
              </ul>
            )}
            <p className={`mt-1 ${HINT}`}>
              连接与工具授权在接口区进行；本页只读，不发起网络请求。
            </p>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button type="button" onClick={onGoSkills} className={BTN_GHOST_SM}>
            查看技能
          </button>
          {servers.length > 0 && (
            <button type="button" onClick={onGoInterfaces} className={BTN_GHOST_SM}>
              查看接口
            </button>
          )}
          <button type="button" onClick={onRemove} className={BTN_DANGER_SM}>
            卸载插件
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
