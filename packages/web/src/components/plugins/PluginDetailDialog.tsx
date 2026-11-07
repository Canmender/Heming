import { useRef, useState } from "react";
import type {
  InstalledPlugin,
  PluginContributionKind,
  PluginServerInfo,
  PluginSkillInfo,
} from "../../lib/plugins/index.js";
import type { ToolPackGroup } from "./viewModel.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { PluginPermissionList } from "./PluginPermissionList.js";
import {
  BTN_DANGER_SM,
  BTN_GHOST,
  BTN_GHOST_SM,
  CHIP,
  HINT,
  Switch,
  formatAt,
} from "./shared.js";
import {
  contributionCountsOf,
  contributionKindRows,
  contributionText,
  isOwnPluginTool,
  permissionViewOf,
  shortFingerprint,
  signatureStatusLabel,
} from "./viewModel.js";

/** 某个工具开关的待确认请求（d.66：逐个确认，绝不批量）。 */
interface PendingToolToggle {
  tool: string;
  serverId: string;
  risk: "read" | "write";
  next: boolean;
}

/**
 * 插件详情抽屉（d.64 · T2）：技能/服务两份物化清单之外，
 * 补「贡献」与「权限」两段——安装前的声明在装好之后也要能随时回看。
 */
export function PluginDetailDialog({
  plugin,
  skills,
  servers,
  toolPacks,
  mcp,
  serverNameOf,
  hostOf,
  onClose,
  onRemove,
  onGoSkills,
  onGoInterfaces,
  onKindToggle,
}: {
  plugin: InstalledPlugin;
  skills: PluginSkillInfo[];
  servers: PluginServerInfo[];
  /** 该插件的工具束（来自能力目录解析，含 matched/unresolved）。 */
  toolPacks: ToolPackGroup["packs"];
  /** 工具开关的真实写入口（与 MCP 服务同源）。 */
  mcp: { setToolEnabled(serverId: string, toolName: string, enabled: boolean): void };
  /** serverId → 服务名（所属服务列展示）。 */
  serverNameOf: (serverId: string) => string;
  hostOf: (url: string) => string;
  onClose: () => void;
  onRemove: () => void;
  onGoSkills: () => void;
  onGoInterfaces: () => void;
  /** 贡献级开关（技能/服务/命令/工具束），受主开关控制。 */
  onKindToggle: (kind: PluginContributionKind, enabled: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });
  const counts = contributionCountsOf(plugin);
  const permission = permissionViewOf(plugin.manifest);
  const [pending, setPending] = useState<PendingToolToggle | null>(null);
  const pluginEnabled = plugin.enabled;

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
            <ul className="mt-2 flex flex-col gap-1.5">
              {contributionKindRows(plugin).map((row) => {
                // 本包没声明的类别：开关照常显示当前值，但置灰并写明「本包未声明」——
                // 可点却点不出任何效果的开关比灰掉更容易让人以为坏了（d.77）。
                const undeclared = row.count === 0;
                return (
                  <li
                    key={row.kind}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft px-3 py-1.5"
                  >
                    <span className="ui-body-sm font-medium">{row.label}</span>
                    <span className={`${CHIP} ui-numeric`}>{row.count}</span>
                    <span className="ml-auto ui-caption">
                      {undeclared
                        ? "本包未声明"
                        : !plugin.enabled
                          ? "主开关已关闭"
                          : row.enabled
                            ? "生效中"
                            : "本类已停用"}
                    </span>
                    <Switch
                      label={`启用本插件的${row.label}`}
                      checked={row.enabled}
                      disabled={!plugin.enabled || undeclared}
                      onChange={(next) => onKindToggle(row.kind, next)}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 ui-caption">
              主开关关闭时不可单独调整；这里的切换只影响这一类贡献，
              不改变人工确认规则、工具风险上限与工具默认关闭的设置。
            </p>
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
                    <ul className="mt-1 flex w-full flex-col gap-1">
                      {pack.entries.map((entry) => {
                        const own = isOwnPluginTool(entry.serverId, plugin.manifest.id);
                        const toggleLabel = `${entry.enabled ? "停用" : "启用"}工具 ${entry.tool}`;
                        return (
                          <li
                            key={`entry:${entry.tool}`}
                            className="flex flex-wrap items-center gap-2 ui-caption"
                          >
                            <span className="font-mono ui-body-sm">{entry.tool}</span>
                            <span className={CHIP}>{entry.risk === "read" ? "只读" : "写入"}</span>
                            <span className="text-muted">
                              {entry.serverId
                                ? `服务：${serverNameOf(entry.serverId)}`
                                : "服务：未连接/未提供"}
                            </span>
                            <span className={`ml-auto ${CHIP}`}>
                              {entry.enabled ? "已启用" : "已停用"}
                            </span>
                            {own ? (
                              <Switch
                                label={toggleLabel}
                                checked={entry.enabled}
                                disabled={!pluginEnabled}
                                onChange={(next) =>
                                  setPending({
                                    tool: entry.tool,
                                    serverId: entry.serverId as string,
                                    risk: entry.risk,
                                    next,
                                  })
                                }
                              />
                            ) : (
                              <button type="button" onClick={onGoInterfaces} className={BTN_GHOST_SM}>
                                在 MCP 服务 Tab 管理
                              </button>
                            )}
                          </li>
                        );
                      })}
                      {pack.unresolved.map((name) => (
                        <li
                          key={`unresolved:${name}`}
                          className="flex flex-wrap items-center gap-2 ui-caption"
                        >
                          <span className="font-mono ui-body-sm">{name}</span>
                          <span className={`${CHIP} text-[#8a5a00]`}>未连接/未提供</span>
                          <Switch
                            label={`启用工具 ${name}`}
                            checked={false}
                            disabled
                            onChange={() => {}}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 ui-caption">
              工具束只声明归属，不改变任何工具开关；逐项确认后才会切到「MCP 服务」Tab 的真实开关，
              每次调用仍按 HITL 确认。{pluginEnabled ? "" : "插件已停用：工具开关暂不可操作。"}
            </p>
            {toolPacks.length > 0 && (
              <button type="button" onClick={onGoInterfaces} className={`mt-1 ${BTN_GHOST_SM}`}>
                在 MCP 服务 Tab 管理
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
              连接与工具授权在「MCP 服务」Tab 进行；本页只读，不发起网络请求。
            </p>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button type="button" onClick={onGoSkills} className={BTN_GHOST_SM}>
            查看技能
          </button>
          {servers.length > 0 && (
            <button type="button" onClick={onGoInterfaces} className={BTN_GHOST_SM}>
              查看 MCP 服务
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

      {pending && (
        <ConfirmDialog
          title={`${pending.next ? "启用" : "停用"}工具 ${pending.tool}`}
          onCancel={() => setPending(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setPending(null)}
                className={BTN_GHOST}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  mcp.setToolEnabled(pending.serverId, pending.tool, pending.next);
                  setPending(null);
                }}
                className={BTN_GHOST_SM}
              >
                {pending.next ? "启用" : "停用"}
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            风险：{pending.risk === "read" ? "只读（read）" : "写入（write）"}。
            {pending.next ? "启用" : "停用"}只代表模型是否能看到该工具，
            {pending.next
              ? "每次调用仍按 HITL 确认。"
              : "停用后模型不再看到该工具，已授权状态保留。"}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
