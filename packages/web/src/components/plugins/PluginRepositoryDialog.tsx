import { useEffect, useRef, useState } from "react";
import type { ModuleCatalogEntry, PluginCatalogEntry } from "@heming/shared";
import type { CatalogClientDeps } from "../../lib/plugins/catalogClient.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { PluginRepositoryPanel } from "./PluginRepositoryPanel.js";
import { fetchModuleCatalog } from "../../lib/modules/catalogClient.js";
import { MODULE_BY_ID, PLUGIN_GROUPS, type ModuleId } from "../../lib/modules/registry.js";
import { BTN_GHOST, BTN_PRIMARY, CHIP, ERROR_TEXT, HINT } from "./shared.js";

/**
 * 「从插件仓库安装」弹窗（d.135 合并版）：
 *
 * 和鸣只有**一份云端插件仓库**。这里把两类可安装项放在同一个弹窗里：
 * - 官方插件（自动化 / 信息）：下载签名 module.tgz，安装到本机模块目录；
 * - 更多插件：声明式插件 / 首方签名界面插件（含桌面小组件），走原有清单安装预览。
 *
 * 之前分成「从插件仓库安装」和「安装官方插件」两个入口，用户看到的是两个仓库，
 * 实际都来自同一台服务器——现在只留一个入口、一个弹窗。
 */
export function PluginRepositoryDialog({
  installed,
  loadingKey,
  onLoad,
  onClose,
  onError,
  catalog,
  moduleInstalled,
  onInstallModule,
}: {
  installed: { id: string; version: string }[];
  loadingKey?: string | null;
  onLoad: (entry: PluginCatalogEntry) => void | Promise<void>;
  onClose: () => void;
  onError?: (message: string) => void;
  catalog?: CatalogClientDeps;
  /** 已安装的模块 id → 是否启用（官方插件区用）。 */
  moduleInstalled?: Record<string, boolean>;
  /** 安装官方插件：下载 + 验签 + 落盘（由插件页提供）。 */
  onInstallModule?: (id: ModuleId, version: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });
  const [modules, setModules] = useState<ModuleCatalogEntry[] | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!onInstallModule) return;
    let alive = true;
    fetchModuleCatalog()
      .then((entries) => alive && setModules(entries))
      .catch((err: unknown) => alive && setModuleError(err instanceof Error ? err.message : "读取官方插件目录失败"));
    return () => {
      alive = false;
    };
  }, [onInstallModule]);

  const officialGroups = onInstallModule
    ? PLUGIN_GROUPS.map((group) => {
        const members = group.moduleIds
          .map((id) => modules?.find((entry) => entry.id === id))
          .filter((entry): entry is ModuleCatalogEntry => Boolean(entry));
        const installedAll = group.moduleIds.every((id) => Boolean(moduleInstalled?.[id]));
        return { group, members, installedAll, version: members[0]?.version ?? "" };
      }).filter((item) => item.members.length > 0)
    : [];

  const installOfficial = async (group: (typeof officialGroups)[number]) => {
    if (!onInstallModule) return;
    setBusyGroup(group.group.id);
    setNotice(null);
    setModuleError(null);
    try {
      for (const member of group.members) {
        const mod = MODULE_BY_ID[member.id as ModuleId];
        if (!mod || moduleInstalled?.[mod.id]) continue;
        // eslint-disable-next-line no-await-in-loop
        await onInstallModule(mod.id, member.version);
      }
      setNotice(`已安装「${group.group.name}」`);
    } catch (err) {
      setModuleError(err instanceof Error ? err.message : "官方插件下载/安装失败");
    } finally {
      setBusyGroup(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="插件仓库"
        className="plugin-dialog-pop flex max-h-[86vh] w-full max-w-[860px] flex-col rounded-2xl border border-line bg-[var(--surface)] shadow-xl"
      >
        <div className="flex items-start gap-2 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="ui-section-title">插件仓库</h2>
            <p className="ui-caption">
              和鸣只有一份云端插件仓库：官方插件与扩展插件都从这里安装；下载的原样清单/签名包会在安装前校验。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            className="ml-auto rounded-md p-1 text-muted hover:bg-[var(--subtle-2)]"
            onClick={onClose}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {onInstallModule ? (
            <section aria-label="官方插件" className="mb-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h3 className="ui-section-title">官方插件</h3>
                <span className={`${CHIP}`}>随仓库分发</span>
                <span className={`ml-auto ${HINT}`}>下载官方签名插件包，安装后即启用</span>
              </div>
              {moduleError ? (
                <p role="alert" className={ERROR_TEXT}>{moduleError}</p>
              ) : !modules ? (
                <p className="ui-caption">正在读取官方插件目录…</p>
              ) : officialGroups.length === 0 ? (
                <p className="ui-caption">云端暂未提供官方插件。</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {officialGroups.map((item) => (
                    <li key={item.group.id} className="ui-card flex items-center gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-bold">{item.group.name}</span>
                          <span className={CHIP}>{item.version}</span>
                          {item.installedAll ? <span className={CHIP}>已安装</span> : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted">{item.group.description}</p>
                      </div>
                      <button
                        type="button"
                        className={item.installedAll ? BTN_GHOST : BTN_PRIMARY}
                        disabled={busyGroup === item.group.id || item.installedAll}
                        aria-label={`安装插件 ${item.group.name}`}
                        onClick={() => void installOfficial(item)}
                      >
                        {busyGroup === item.group.id ? "正在下载…" : item.installedAll ? "已安装" : "安装"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {notice ? (
                <p role="status" className="mt-1 ui-caption text-[var(--success)]">{notice}</p>
              ) : null}
            </section>
          ) : null}

          <section aria-label="更多插件">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="ui-section-title">更多插件</h3>
              <span className={`ml-auto ${HINT}`}>声明式插件与首方签名界面插件</span>
            </div>
            <PluginRepositoryPanel
              catalog={catalog}
              installed={installed}
              loadingKey={loadingKey}
              onLoad={onLoad}
              onError={onError}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
