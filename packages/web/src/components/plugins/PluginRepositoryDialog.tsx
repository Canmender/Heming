import { useRef } from "react";
import type { PluginCatalogEntry } from "@heming/shared";
import type { CatalogClientDeps } from "../../lib/plugins/catalogClient.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { PluginRepositoryPanel } from "./PluginRepositoryPanel.js";

/**
 * 「下载安装」弹窗（d.96）：从插件页直接打开云端插件库列表并选择安装。
 *
 * 为什么再开一个弹窗而不是只留「仓库」Tab：插件页的主操作就是「装点什么」，
 * 用户不该先猜「仓库在哪个 Tab」。弹窗与 Tab 共用同一个面板组件，
 * 选择安装后关闭弹窗、把清单交给同一个安装预览——不产生第二条安装路径。
 */
export function PluginRepositoryDialog({
  installed,
  loadingKey,
  onLoad,
  onClose,
  onError,
  catalog,
}: {
  installed: { id: string; version: string }[];
  loadingKey?: string | null;
  onLoad: (entry: PluginCatalogEntry) => void | Promise<void>;
  onClose: () => void;
  onError?: (message: string) => void;
  catalog?: CatalogClientDeps;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="云端插件库"
        className="flex max-h-[86vh] w-full max-w-[860px] flex-col rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-start gap-2 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="ui-section-title">云端插件库</h2>
            <p className="ui-caption">
              和鸣只维护一份云端插件仓库；下载的是原样清单，安装前会展示权限与指纹。
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
          <PluginRepositoryPanel
            catalog={catalog}
            installed={installed}
            loadingKey={loadingKey}
            onLoad={onLoad}
            onError={onError}
          />
        </div>
      </div>
    </div>
  );
}
