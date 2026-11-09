import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import { useUiStore } from "../../store/ui.js";
import {
  MODULE_BY_ID,
  moduleStorageBytes,
  type BuiltinModule,
  type ModuleId,
} from "../../lib/modules/registry.js";
import { missingRequirements, useModuleStore } from "../../lib/modules/store.js";
import { AutomationIcon, InfoHubIcon, StaffIcon, WorkflowIcon } from "../icons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { BTN_DANGER_SM, BTN_GHOST, BTN_PRIMARY, CHIP, HINT, Switch } from "./shared.js";

/**
 * 模块卡片（插件页 · 插件 Tab）。
 *
 * 模块由**云端目录**提供（`GET /api/modules`），用户在「从云端安装模块」弹窗里选择；
 * 安装包里不携带任何模块。装过之后才在本列表里出现，可打开页面、停用或删除。
 * 每个卡片回答四个问题：**它是什么、带了什么、依赖谁、删除会怎样**。
 *
 * 状态只写 `heming.modules.v1`（`installed` / `enabled`）；页面/导航的过滤在
 * NavRail、App、命令面板各自读同一份 store，所以这里不需要通知任何页面刷新。
 *
 * ★ 删除**只移除插件入口与后台任务**，不删除任何本机业务数据（简报、归档配置、
 *   自动化任务与运行记录都留在原处），重新安装即恢复。
 * ★ 卡片不承诺数据存在哪个存储介质：插件数据目录由桌面端决定（另一条工作流），
 *   这里只展示「本机数据 N 项 / 占用约多少」。
 */

const MODULE_ICONS: Record<ModuleId, ComponentType<SVGProps<SVGSVGElement>>> = {
  staff: StaffIcon,
  infohub: InfoHubIcon,
  automations: AutomationIcon,
  workflows: WorkflowIcon,
};

/** 字节 → 便于扫读的「约 x KB / x MB」（0 显示「无数据」）。 */
function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "无数据";
  if (bytes < 1024) return `约 ${bytes} B`;
  if (bytes < 1024 * 1024) return `约 ${(bytes / 1024).toFixed(1)} KB`;
  return `约 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 贡献摘要：页面 / 首页卡 / 后台任务 / 工具前缀。 */
export function moduleContributionText(mod: BuiltinModule): string {
  const parts: string[] = [];
  if (mod.contributions.page) parts.push("页面入口");
  if (mod.contributions.homeCard) parts.push("首页卡片");
  if (mod.contributions.backgroundLoop === "staff-loop") parts.push("后台巡检（每 60 秒）");
  if (mod.contributions.backgroundLoop === "automation-scheduler")
    parts.push("后台调度（每 15 秒）");
  if (mod.contributions.backgroundLoop === "workflow-scheduler")
    parts.push("定时触发（每 15 秒检查）");
  if (mod.contributions.toolPrefixes?.length)
    parts.push(`模型工具：${mod.contributions.toolPrefixes.join("、")}*`);
  return parts.join(" · ") || "—";
}

export function ModulePluginCard({ mod }: { mod: BuiltinModule }) {
  const installedMap = useModuleStore((s) => s.installed);
  const enabledMap = useModuleStore((s) => s.enabled);
  const install = useModuleStore((s) => s.install);
  const uninstall = useModuleStore((s) => s.uninstall);
  const setEnabled = useModuleStore((s) => s.setEnabled);
  const setPage = useUiStore((s) => s.setPage);

  const installed = installedMap[mod.id];
  const enabled = enabledMap[mod.id];
  const missing = installed ? missingRequirements({ installed: installedMap, enabled: enabledMap }, mod.id) : [];
  const effective = installed && enabled && missing.length === 0;
  const Icon = MODULE_ICONS[mod.id];
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** tick 只用来在状态变化后重算占用（占用不是响应式数据）。 */
  const [tick, setTick] = useState(0);
  const occupancy = useMemo(() => moduleStorageBytes(mod), [mod, tick]);

  const statusLabel = !installed ? "未安装" : !enabled ? "已停用" : missing.length ? "待依赖" : "已启用";
  const statusTone = !installed
    ? "border-line bg-[#f7f7f7] text-muted"
    : effective
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-amber-200 bg-amber-50 text-amber-700";

  return (
    <section
      role="region"
      aria-label={`插件模块 ${mod.name}`}
      data-module-card={mod.id}
      className="rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-soft bg-[#fafafa] text-ink">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="ui-section-title">{mod.name}</span>
            <span className={CHIP}>模块</span>
            <span className="ui-micro text-muted">{mod.version}</span>
            <span className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${statusTone}`}>
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-6 text-muted">{mod.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {installed ? (
            <Switch
              label={`${enabled ? "停用" : "启用"}模块 ${mod.name}`}
              checked={enabled}
              onChange={(next) => {
                setEnabled(mod.id, next);
                setTick((n) => n + 1);
                setNotice(next ? null : `已停用「${mod.name}」，本机数据未删除`);
              }}
            />
          ) : (
            <button
              type="button"
              aria-label={`安装模块 ${mod.name}`}
              className={BTN_PRIMARY}
              onClick={() => {
                install(mod.id);
                setTick((n) => n + 1);
                setNotice(`已安装「${mod.name}」`);
              }}
            >
              安装
            </button>
          )}
        </div>
      </div>

      <dl className="mt-3 grid gap-1.5 text-[11px] leading-5 sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-muted">贡献</dt>
          <dd className="text-[#444]">{moduleContributionText(mod)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">本机数据（删除不清理）</dt>
          <dd className="text-[#444]">
            {mod.storageKeys.length > 0
              ? `本机数据 ${mod.storageKeys.length} 项 · ${fmtBytes(occupancy)}`
              : "不占和鸣存储"}
            {mod.externalData?.length ? (
              <span className="block text-[10px] text-muted">{mod.externalData.join("；")}</span>
            ) : null}
          </dd>
        </div>
        {mod.requires?.length ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted">依赖</dt>
            <dd className={missing.length ? "text-[#8a5a00]" : "text-[#444]"}>
              需要「{mod.requires.map((id) => MODULE_BY_ID[id]?.name ?? id).join("、")}」启用
              {missing.length
                ? `（当前未满足：${missing.map((id) => MODULE_BY_ID[id]?.name ?? id).join("、")}）`
                : ""}
            </dd>
          </div>
        ) : (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted">依赖</dt>
            <dd className="text-[#444]">
              无模块依赖，可独立安装/启停
              {mod.id === "automations"
                ? "；运行时若信息中枢未连接，任务会如实报错，不影响本插件安装/启停"
                : ""}
            </dd>
          </div>
        )}
      </dl>

      <p className={`mt-2 ${HINT}`}>{installed ? mod.disableNote : "未安装：安装后即启用，同时追加到左侧导航最下面，可随时停用或删除。"}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {installed ? (
          <>
            <button
              type="button"
              disabled={!effective}
              onClick={() => setPage(mod.page)}
              className={BTN_GHOST + " disabled:cursor-not-allowed disabled:opacity-40"}
              title={effective ? undefined : "安装并启用后才可打开"}
            >
              打开页面
            </button>
            <span className="ui-caption">
              {effective ? "状态：已生效" : enabled ? "依赖项启用后自动恢复" : "随时可重新启用"}
            </span>
            <button
              type="button"
              aria-label={`删除模块 ${mod.name}`}
              className={`${BTN_DANGER_SM} ml-auto`}
              onClick={() => {
                setNotice(null);
                setConfirmingRemove(true);
              }}
            >
              删除
            </button>
          </>
        ) : (
          <span className="ui-caption">
            模块由云端目录提供；安装只注册入口与后台任务，带引擎的模块（信息中枢）首次启用时才下载官方签名模块包。
          </span>
        )}
        {notice ? (
          <span role="status" className="ui-caption text-[#8a5a00]">
            {notice}
          </span>
        ) : null}
      </div>

      {confirmingRemove ? (
        <ConfirmDialog
          title={`删除「${mod.name}」`}
          onCancel={() => setConfirmingRemove(false)}
          footer={
            <>
              <button type="button" className={BTN_GHOST} onClick={() => setConfirmingRemove(false)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-danger"
                onClick={() => {
                  uninstall(mod.id);
                  setConfirmingRemove(false);
                  setTick((n) => n + 1);
                  setNotice(`已删除「${mod.name}」，本机已有数据未删除`);
                }}
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            删除只移除插件入口与后台任务，<strong>不删除本机已有数据</strong>。重新安装后可继续使用原有数据。
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[12px] leading-5 text-muted">
            <li>下线的贡献：{moduleContributionText(mod)}</li>
            <li>
              保留的数据：
              {mod.storageKeys.length > 0 ? `本机 ${mod.storageKeys.length} 项数据` : "不占和鸣存储"}
              {mod.externalData?.length ? "；外部归档/库文件原样保留" : ""}
            </li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
