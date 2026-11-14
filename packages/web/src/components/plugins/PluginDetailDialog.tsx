import { useRef, useState } from "react";
import { Button } from "../ui/Button.js";
import type {
  InstalledPlugin,
  PluginContributionKind,
  PluginServerInfo,
  PluginSkillInfo,
} from "../../lib/plugins/index.js";
import type { ToolPackGroup } from "./viewModel.js";
import { Dialog } from "../ui/Dialog.js";
import { PackageIcon } from "../icons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { PluginPermissionList } from "./PluginPermissionList.js";
import { WidgetSettingsCard } from "../settings/WidgetSettingsCard.js";
import { useWidgetsStore, widgetsAvailable } from "../../lib/widgets/store.js";
import {
  CHIP,
  HINT,
  Switch,
  fmtBytes,
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
 *
 * d.136：有窗口的插件（如桌宠）在这里多一段「窗口设置」——显示/缩放/穿透/位置
 * 与插件声明的设置项。设置 → 外观区不再出现「桌面小组件」卡：窗口行为属于插件本身。
 *
 * 模块运行时下线后只剩包插件一条来源：声明式插件与界面插件共用这一个壳，
 * 不再有「内置插件组」的第二套正文。
 */

interface CommonDetailProps {
  onClose: () => void;
}

/** 包详情（声明式 / 界面插件）的 props。 */
interface PackageDetailProps extends CommonDetailProps {
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
  onRemove: () => void;
  onGoSkills: () => void;
  onGoInterfaces: () => void;
  /** 打开插件自己的页面（d.124）；没声明页面或页面当前不可用时省略。 */
  onOpenPage?: () => void;
  /** 贡献级开关（技能/服务/命令/工具束），受主开关控制。 */
  onKindToggle: (kind: PluginContributionKind, enabled: boolean) => void;
}

/** 包详情（声明式 / 界面插件）的 props。 */
export type PluginDetailDialogProps = PackageDetailProps;

/**
 * 插件详情弹窗（d.64 / d.134）：声明式插件与界面插件共用这个外壳。
 *
 * 两种来源都在这里看「贡献 / 数据 / 启停 / 删除」，不另开一套详情面板；
 * 用户口径只有一个——插件详情。内部「模块」词汇不进入界面文案。
 */
export function PluginDetailDialog(props: PluginDetailDialogProps) {
  const title = props.plugin.manifest.name;

  return (
    <Dialog
      ariaLabel={`插件详情 ${title}`}
      title="插件详情"
      icon={<PackageIcon width={16} height={16} />}
      size="lg"
      maxHeightVh={88}
      onClose={props.onClose}
      closeLabel="关闭插件详情"
      bodyClassName="p-0"
    >
      <PackageDetailBody {...props} />
    </Dialog>
  );
}

/** 包插件详情正文（原实现，只从外壳里拆出来）。 */
function PackageDetailBody({
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
  onOpenPage,
  onKindToggle,
}: PackageDetailProps) {
  const counts = contributionCountsOf(plugin);
  const permission = permissionViewOf(plugin.manifest);
  const [pending, setPending] = useState<PendingToolToggle | null>(null);
  const pluginEnabled = plugin.enabled;
  /** 清单声明的页面（每插件最多 1 个）。 */
  const page = plugin.manifest.contributions.page;
  /**
   * d.125：首页卡片与后台页。前者是数据（宿主渲染入口），后者是包内 HTML
   * （宿主建隐藏窗口跑它）——都不是可单独启停的贡献类别，所以只做只读展示。
   */
  const homeCards = plugin.manifest.contributions.homeCards;
  const background = plugin.manifest.contributions.background;
  /**
   * 只有「装好并且有窗口记录」的插件才显示窗口设置：
   * 页面型插件没有浮窗，纯技能包也没有，这时整段不渲染，不留空标题。
   */
  const hasWidgetRecord = useWidgetsStore((state) =>
    state.records.some((record) => record.id === plugin.manifest.id),
  );
  const widgetsReady = widgetsAvailable();

  return (
    <>
      <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui-base font-semibold">{plugin.manifest.name}</span>
            <span className={CHIP}>v{plugin.manifest.version}</span>
            <span className={CHIP}>{plugin.enabled ? "已启用" : "已停用"}</span>
            <span className={CHIP}>schemaVersion {plugin.manifest.schemaVersion}</span>
          </div>
          <div className={`mt-0.5 ${HINT}`}>
            {plugin.manifest.id}
            {plugin.manifest.author ? ` · ${plugin.manifest.author}` : ""}
          </div>
          <p className="mt-2 break-words ui-body-sm text-muted">
            {plugin.manifest.description || "暂无描述"}
          </p>
          <div className={`mt-2 ${HINT}`}>
            安装于 {formatAt(plugin.installedAt)} · 更新于 {formatAt(plugin.updatedAt)}
            <br />
            停用插件会同时关闭其技能与 MCP 服务；数据与配置保留。
          </div>

          <section className="mt-4" aria-label="插件贡献">
            <h3 className="ui-section-title">贡献</h3>
            <p className="mt-1 ui-body-sm">
              {contributionText(counts)}
              {page ? " · 页面 1" : ""}
              {homeCards.length > 0 ? ` · 首页卡片 ${homeCards.length}` : ""}
            </p>
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
              {/* d.124 页面：第五类贡献面，但不是可单独启停的「类别」——它只有 1 个，
                  跟着插件总开关走，所以这一行给「打开页面」而不是 Switch。 */}
              {page ? (
                <li className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft px-3 py-1.5">
                  <span className="ui-body-sm font-medium">页面</span>
                  <span className={`${CHIP} ui-numeric`}>1</span>
                  <span className="ml-auto ui-caption">{page.title}</span>
                  {onOpenPage ? (
                    <Button
                      type="button"
                      aria-label="打开插件页面"
                      onClick={onOpenPage}
                      size="sm" variant="ghost"
                    >
                      打开页面
                    </Button>
                  ) : (
                    <span className="ui-caption">{plugin.enabled ? "暂不可用" : "主开关已关闭"}</span>
                  )}
                </li>
              ) : null}
              {/* d.125 首页卡片：卡片文案由插件运行时回填，这里只展示清单声明的入口。 */}
              {homeCards.length > 0 ? (
                <li className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft px-3 py-1.5">
                  <span className="ui-body-sm font-medium">首页卡片</span>
                  <span className={`${CHIP} ui-numeric`}>{homeCards.length}</span>
                  <span className="ml-auto ui-caption">
                    {homeCards.map((card) => card.title).join("、")}
                  </span>
                  <span className="ui-caption">
                    {plugin.enabled ? "已生效" : "主开关已关闭"}
                  </span>
                </li>
              ) : null}
              {/* d.125 后台页：宿主在插件启用时建隐藏窗口跑这个入口，停用/卸载即销毁。 */}
              {background ? (
                <li className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft px-3 py-1.5">
                  <span className="ui-body-sm font-medium">后台运行</span>
                  <span className={`${CHIP} ui-numeric`}>1</span>
                  <span className="ml-auto break-all ui-caption">{background.entry}</span>
                  <span className="ui-caption">
                    {plugin.enabled ? "运行中" : "主开关已关闭"}
                  </span>
                </li>
              ) : null}
            </ul>
            <p className="mt-1 ui-caption">
              主开关关闭时不可调整；这里只影响这一类贡献，不改人工确认与工具风险上限。
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

          {/* d.136 窗口设置：放在只读的「贡献/权限」之后、技能清单之前——
              先看清插件声明了什么、被授权了什么，再动手调它的窗口。
              没有窗口记录的插件（页面型/纯技能包）整段不渲染，不留空标题。 */}
          {widgetsReady && hasWidgetRecord ? (
            <section className="mt-4" aria-label="窗口设置">
              <h3 className="ui-section-title">窗口设置</h3>
              <p className="mt-1 ui-caption">
                显示/隐藏、缩放、鼠标穿透与位置由宿主提供，下面几项由插件自己声明。
              </p>
              <div className="mt-2">
                <WidgetSettingsCard onlyPluginId={plugin.manifest.id} embedded />
              </div>
            </section>
          ) : null}

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
                              <Button type="button" onClick={onGoInterfaces} size="sm" variant="ghost">
                                在 MCP Tab 管理
                              </Button>
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
                          <span className={`${CHIP} text-warn`}>未连接/未提供</span>
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
              工具束只声明归属，不改变任何工具开关；逐项确认后才会切到「MCP」Tab 的真实开关，
              每次调用仍按 HITL 确认。{pluginEnabled ? "" : "插件已停用：工具开关暂不可操作。"}
            </p>
            {toolPacks.length > 0 && (
              <Button type="button" size="sm" variant="ghost" className="mt-1" onClick={onGoInterfaces}>
                在 MCP Tab 管理
              </Button>
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
                    <code className="mt-0.5 block break-all text-ui-xs text-muted">{server.url}</code>
                  </li>
                ))}
              </ul>
            )}
            <p className={`mt-1 ${HINT}`}>
              连接与工具授权在「MCP」Tab 进行；本页只读，不联网。
            </p>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft bg-subtle-2 px-4 py-2.5">
          <Button type="button" onClick={onGoSkills} size="sm" variant="ghost">
            查看技能
          </Button>
          {page && onOpenPage ? (
            <Button type="button" onClick={onOpenPage} size="sm" variant="ghost">
              打开页面
            </Button>
          ) : null}
          {servers.length > 0 && (
            <Button type="button" onClick={onGoInterfaces} size="sm" variant="ghost">
              查看 MCP 服务
            </Button>
          )}
          <Button type="button" onClick={onRemove} size="sm" variant="ghost" className="text-danger">
            卸载插件
          </Button>
          <Button type="button" onClick={onClose} size="md" variant="ghost">
            关闭
          </Button>
        </div>

      {pending && (
        <ConfirmDialog
          title={`${pending.next ? "启用" : "停用"}工具 ${pending.tool}`}
          onCancel={() => setPending(null)}
          footer={
            <>
              <Button
                type="button"
                onClick={() => setPending(null)}
                size="md" variant="ghost"
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  mcp.setToolEnabled(pending.serverId, pending.tool, pending.next);
                  setPending(null);
                }}
                size="sm" variant="ghost"
              >
                {pending.next ? "启用" : "停用"}
              </Button>
            </>
          }
        >
          <p className="text-ui-sm leading-6">
            风险：{pending.risk === "read" ? "只读（read）" : "写入（write）"}。
            {pending.next ? "启用" : "停用"}只代表模型是否能看到该工具，
            {pending.next
              ? "每次调用仍按 HITL 确认。"
              : "停用后模型不再看到该工具，已授权状态保留。"}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}


