import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import { useUiStore } from "../../store/ui.js";
import {
  MODULE_BY_ID,
  moduleStorageBytes,
  type BuiltinModule,
  type ModuleId,
  type PluginGroup,
} from "../../lib/modules/registry.js";
import { useModuleStore } from "../../lib/modules/store.js";
import { installPluginPackage, removePluginPackage } from "../../lib/modules/cloudInstall.js";
import { AutomationIcon, InfoHubIcon, StaffIcon, WorkflowIcon } from "../icons.js";
import { BTN_DANGER_SM, BTN_GHOST, BTN_PRIMARY, CHIP, HINT, Switch } from "./shared.js";

/**
 * 插件卡（d.133）：用户看到一个「插件」，内部可以贡献多个页面。
 *
 * - 信息插件：信息中枢页面 + 首页归档卡 + infohub_* 工具；
 * - 助理插件：幕僚 / 自动化 / 工作流三个页面与各自后台任务。
 *
 * 安装/删除/启停都按插件整体执行；页面入口在卡片里逐个列出。旧的本体「模块」概念
 * 只作为内部 id 保留，不再出现在用户界面。
 */

const GROUP_ICONS: Record<PluginGroup["id"], ComponentType<SVGProps<SVGSVGElement>>> = {
  assistant: StaffIcon,
  infohub: InfoHubIcon,
};

const MODULE_ICONS: Record<ModuleId, ComponentType<SVGProps<SVGSVGElement>>> = {
  staff: StaffIcon,
  infohub: InfoHubIcon,
  automations: AutomationIcon,
  workflows: WorkflowIcon,
};

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "无数据";
  if (bytes < 1024) return `约 ${bytes} B`;
  if (bytes < 1024 * 1024) return `约 ${(bytes / 1024).toFixed(1)} KB`;
  return `约 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PluginGroupCard({ group }: { group: PluginGroup }) {
  const modules = group.moduleIds.map((id) => MODULE_BY_ID[id]).filter((mod): mod is BuiltinModule => Boolean(mod));
  const installedMap = useModuleStore((s) => s.installed);
  const enabledMap = useModuleStore((s) => s.enabled);
  const install = useModuleStore((s) => s.install);
  const uninstall = useModuleStore((s) => s.uninstall);
  const setEnabled = useModuleStore((s) => s.setEnabled);
  const setPage = useUiStore((s) => s.setPage);

  const installedCount = modules.filter((mod) => installedMap[mod.id]).length;
  const installed = installedCount === modules.length;
  const enabled = installed && modules.every((mod) => enabledMap[mod.id]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [tick, setTick] = useState(0);
  const occupancy = useMemo(
    () => modules.reduce((sum, mod) => sum + moduleStorageBytes(mod), 0),
    // tick 驱动占用重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, tick],
  );
  const Icon = GROUP_ICONS[group.id];

  const installAll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      for (const mod of modules) {
        if (installedMap[mod.id]) continue;
        // eslint-disable-next-line no-await-in-loop
        await installPluginPackage(mod.id, mod.version);
        install(mod.id);
      }
      setTick((n) => n + 1);
      setNotice(`已安装「${group.name}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "插件下载/安装失败");
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const mod of modules) {
        if (!installedMap[mod.id]) continue;
        // eslint-disable-next-line no-await-in-loop
        await removePluginPackage(mod.id).catch(() => null);
        uninstall(mod.id);
      }
      setTick((n) => n + 1);
      setNotice(`已删除「${group.name}」，本机已有数据未删除`);
    } finally {
      setBusy(false);
      setRemoving(false);
    }
  };

  return (
    <section
      role="region"
      aria-label={`插件 ${group.name}`}
      data-plugin-group={group.id}
      className="ui-card plugin-card p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="plugin-icon-tile mt-0.5 h-9 w-9">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="ui-section-title">{group.name}</span>
            <span className={CHIP}>插件</span>
            <span className="ui-micro text-muted">{modules[0]?.version ?? ""}</span>
            <span className="ui-micro text-muted">
              {installed ? "已安装" : installedCount > 0 ? `已安装 ${installedCount}/${modules.length}` : "未安装"}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-6 text-muted">{group.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installed ? (
            <Switch
              label={`${enabled ? "停用" : "启用"}插件 ${group.name}`}
              checked={enabled}
              onChange={(next) => {
                for (const mod of modules) setEnabled(mod.id, next);
                setTick((n) => n + 1);
                setNotice(next ? null : `已停用「${group.name}」，本机数据未删除`);
              }}
            />
          ) : (
            <button
              type="button"
              aria-label={`安装插件 ${group.name}`}
              className={BTN_PRIMARY}
              disabled={busy}
              onClick={() => void installAll()}
            >
              {busy ? "正在下载…" : "安装"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-1.5 text-[11px] leading-5 sm:grid-cols-2">
        <div>
          <span className="font-semibold text-muted">这个插件带来</span>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {modules.map((mod) => {
              const ModIcon = MODULE_ICONS[mod.id];
              return (
                <li key={mod.id} className="flex items-center gap-1.5">
                  <ModIcon width={12} height={12} />
                  <span>{mod.name}</span>
                  {installedMap[mod.id] ? (
                    <button
                      type="button"
                      className="ui-link ml-auto"
                      disabled={!enabledMap[mod.id]}
                      onClick={() => setPage(mod.page)}
                    >
                      打开
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <span className="font-semibold text-muted">本机数据</span>
          <p className="mt-0.5 text-[var(--body)]">
            {modules.some((mod) => mod.storageKeys.length > 0)
              ? `本机数据 ${modules.reduce((sum, mod) => sum + mod.storageKeys.length, 0)} 项 · ${fmtBytes(occupancy)}`
              : "数据由插件在本机管理"}
          </p>
          <p className="text-[10px] text-muted">删除插件只撤销入口与后台任务，不删除业务数据。</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {installed ? (
          <button
            type="button"
            aria-label={`删除插件 ${group.name}`}
            className={`${BTN_DANGER_SM} ml-auto`}
            onClick={() => setRemoving(true)}
          >
            删除
          </button>
        ) : (
          <span className={HINT}>
            从云端安装；点安装会下载官方签名插件包，安装包本身不携带任何插件。
          </span>
        )}
        {notice ? (
          <span role="status" className="ui-caption text-[var(--warn)]">
            {notice}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="ui-caption text-[var(--danger)]">
            {error}
          </span>
        ) : null}
      </div>

      {removing ? (
        <div className="plugin-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
          <div role="dialog" aria-modal="true" aria-label={`删除插件 ${group.name}`} className="ui-card w-[min(440px,94vw)] p-4">
            <p className="ui-section-title">删除「{group.name}」？</p>
            <p className="mt-1 text-[13px] leading-6">删除只移除插件入口与后台任务，不删除本机已有数据。</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className={BTN_GHOST} onClick={() => setRemoving(false)}>
                取消
              </button>
              <button type="button" className="ui-btn ui-btn-md ui-btn-danger" disabled={busy} onClick={() => void removeAll()}>
                {busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
