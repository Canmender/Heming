import { useEffect, useRef, useState } from "react";
import type { ModuleCatalogEntry } from "@heming/shared";
import { fetchModuleCatalog } from "../../lib/modules/catalogClient.js";
import { MODULE_BY_ID, type ModuleId } from "../../lib/modules/registry.js";
import { useModalA11y } from "../useModalA11y.js";
import { PackageIcon, XIcon } from "../icons.js";
import { BTN_GHOST, BTN_PRIMARY, CHIP, ERROR_TEXT, HINT } from "./shared.js";

/**
 * 「从云端安装插件」弹窗（d.117）。
 *
 * 原生应用不再写死「内置模块」卡片：这里只列服务端 `/api/modules` 真实提供的模块。
 * 目录为空/不可用时如实说明，不把任何模块画成「已存在」。
 *
 * 安装只改本机模块状态（`heming.modules.v1`）；带引擎的模块（信息中枢）在启用后
 * 才按需下载官方签名引擎包——这一步由 `useInfohubStore.ensureRunning()` 负责，
 * 本弹窗不下载任何东西。
 */
export function CloudModulesDialog({
  onClose,
  installed,
  onInstall,
}: {
  onClose: () => void;
  installed: Record<string, boolean>;
  onInstall: (id: ModuleId) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(dialogRef, onClose, { active: true });

  const [entries, setEntries] = useState<ModuleCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchModuleCatalog());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在打开时取一次；重试按钮显式再调
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = (entry: ModuleCatalogEntry) => {
    const known = MODULE_BY_ID[entry.id as ModuleId];
    if (!known) return;
    setBusyId(entry.id);
    onInstall(known.id);
    setBusyId(null);
    setNotice(`已安装「${entry.name}」，入口已加到左侧导航最下面`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="从云端安装插件"
        className="plugin-dialog-pop flex max-h-[80vh] w-[min(720px,94vw)] flex-col rounded-2xl border border-line bg-[var(--surface)] shadow-xl"
      >
        <header className="flex items-start gap-3 border-b border-line-soft px-4 py-3">
          <span className="mt-0.5 text-muted" aria-hidden="true">
            <PackageIcon width={18} height={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="ui-section-title">从云端安装插件</h2>
            <p className={`mt-1 ${HINT}`}>
              插件由云端目录提供，安装包里不携带；装过才生效。带引擎的插件首次启用时才下载引擎。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-sm p-1 text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            <XIcon width={16} height={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="ui-body-sm text-muted">正在读取云端插件目录…</p>
          ) : error ? (
            <div role="alert" className={ERROR_TEXT}>
              <p>{error}</p>
              <button type="button" className={`${BTN_GHOST} mt-2`} onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="ui-empty py-8">
              <p className="ui-empty-title">云端暂未提供可安装插件</p>
              <p className="ui-empty-desc">
                原生应用不携带插件；服务端上线插件目录后，这里会出现可安装项。
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => {
                const known = Boolean(MODULE_BY_ID[entry.id as ModuleId]);
                const isInstalled = Boolean(installed[entry.id]);
                const busy = busyId === entry.id;
                return (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-line-soft bg-[var(--surface)] p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-extrabold">{entry.name}</span>
                      <span className={CHIP}>v{entry.version}</span>
                      {entry.engine ? <span className={CHIP}>含引擎</span> : null}
                      {isInstalled ? <span className={CHIP}>已安装</span> : null}
                      <span className="ml-auto">
                        {isInstalled ? (
                          <span className="ui-caption">已安装，可在列表里启停</span>
                        ) : (
                          <button
                            type="button"
                            disabled={!known || busy}
                            title={known ? undefined : "当前版本不支持这个插件"}
                            aria-label={`安装插件 ${entry.name}`}
                            onClick={() => install(entry)}
                            className={`${BTN_PRIMARY} disabled:cursor-not-allowed disabled:opacity-40`}
                          >
                            {busy ? "安装中…" : "安装"}
                          </button>
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-6 text-muted">
                      {entry.description || "暂无描述"}
                    </p>
                    {entry.engine ? (
                      <p className={`mt-1 ${HINT}`}>
                        安装只注册入口；首次启用时从更新源下载官方签名引擎包，引擎不进安装包。
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {notice ? (
            <p role="status" className="ui-caption mt-2 text-[var(--success)]">
              {notice}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
