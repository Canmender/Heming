import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginCatalogEntry } from "@heming/shared";
import {
  downloadPluginPackage,
  fetchWidgetCatalog,
  type CatalogClientDeps,
} from "../lib/plugins/catalogClient.js";
import {
  installWidgetFromBytes,
  installWidgetFromFile,
  runWidgetAction,
  widgetsAvailable,
  type WidgetInstallOutcome,
} from "../lib/widgets/store.js";
import { migrateLegacyPetPrefs, PET_PLUGIN_ID } from "../lib/widgets/legacy.js";
import { useModalA11y } from "./useModalA11y.js";
import { XIcon } from "./icons.js";

/**
 * 「安装桌面小组件」弹窗（d.98 · 规格 §4.2 / §4.2.1）。
 *
 * 两条安装路径都收在这里，因为它们的**信任模型一样**：
 * - 云端：云端插件目录里 `distribution: "bundle"` 的包 → 下载 `.tgz` → 校验 sha256/大小
 *   → 把字节交给主进程 `widgets:install`（主进程再校验一次并解包安装）；
 * - 本地：用户自己选的 `.tgz` → 主进程开文件框并安装（渲染层不碰 fs）。
 *
 * 与声明式安装（`components/plugins/InstallDialog.tsx`）**刻意分开**：
 * 那个入口装的是不含代码的清单；界面插件包带可执行界面代码，必须在确认框里写明
 * 「包含可执行界面代码」「来源」「会创建桌面窗口」。两条路混在一个弹窗里迟早点错。
 *
 * ★ 安全口径（规格 §6.7）：只允许官方云端目录与本地文件；无签名/来源不明的包不装。
 *   签名与首方限制由主进程安装器判定，这里只负责把来源与风险如实展示并二次确认。
 */

type Phase =
  | { kind: "browse" }
  | { kind: "confirm-cloud"; entry: PluginCatalogEntry }
  | { kind: "confirm-local" }
  | { kind: "installing"; label: string }
  | { kind: "done"; message: string };

export interface PluginInstallDialogProps {
  onClose: () => void;
  /** 安装成功后的回调（插件区用来提示并刷新）。 */
  onInstalled?: (message: string) => void;
  /** 云端目录客户端（测试注入）；缺省走 catalogClient 的真实实现。 */
  catalog?: CatalogClientDeps;
}

function sizeText(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "大小未知";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 指纹只展示前 8 位：确认框里用来核对，不占版面。 */
function shortFingerprint(sha256: string | undefined): string {
  return sha256 ? `${sha256.slice(0, 8)}…` : "—";
}

export function PluginInstallDialog({
  onClose,
  onInstalled,
  catalog: catalogDeps,
}: PluginInstallDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });

  const [phase, setPhase] = useState<Phase>({ kind: "browse" });
  const [entries, setEntries] = useState<PluginCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = widgetsAvailable();

  const loadCatalog = useCallback(async (): Promise<void> => {
    if (!available) return;
    setLoading(true);
    setLoadError(null);
    try {
      setEntries(await fetchWidgetCatalog(catalogDeps));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [available, catalogDeps]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  /**
   * 安装成功后：首次装 heming.pet 先迁移旧偏好，再显式显示一次窗口。
   *
   * 主进程**安装成功后不会自动 show**（避免用户没反应过来桌面上突然出现东西）；
   * 但用户在这个弹窗里点了「确认安装」，显示出来才是预期结果，所以这里显式 action("show")。
   */
  const afterInstalled = useCallback(
    async (outcome: WidgetInstallOutcome): Promise<void> => {
      const record = outcome.record;
      if (record?.id === PET_PLUGIN_ID && outcome.updated !== true) {
        const migrated = await migrateLegacyPetPrefs();
        if (!migrated.ok && migrated.error) {
          setError(`已安装，但旧桌宠设置迁移失败：${migrated.error}`);
        }
      }
      if (record) {
        // 显示失败（记录损坏/窗口起不来）不阻塞安装成功提示——列表里会显示 error
        await runWidgetAction(record.id, "show");
      }
      const message = record
        ? `已${outcome.updated ? "更新" : "安装"}桌面小组件「${record.name}」v${record.version}`
        : "插件已安装";
      onInstalled?.(message);
      setPhase({ kind: "done", message });
    },
    [onInstalled],
  );

  const installCloud = async (entry: PluginCatalogEntry): Promise<void> => {
    setError(null);
    setPhase({ kind: "installing", label: `正在下载并校验「${entry.name}」…` });
    try {
      const pkg = await downloadPluginPackage(entry, catalogDeps);
      const outcome = await installWidgetFromBytes(pkg.bytes, { expectedSha256: pkg.sha256 });
      if (!outcome.ok) {
        setError(outcome.error ?? "安装失败");
        setPhase({ kind: "browse" });
        return;
      }
      await afterInstalled(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase({ kind: "browse" });
    }
  };

  const installLocal = async (): Promise<void> => {
    setError(null);
    setPhase({ kind: "installing", label: "正在读取本地插件包…" });
    const outcome = await installWidgetFromFile();
    if (!outcome.ok) {
      setError(outcome.error ?? "安装失败");
      setPhase({ kind: "browse" });
      return;
    }
    await afterInstalled(outcome);
  };

  const busy = phase.kind === "installing";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="安装桌面小组件"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-xl border border-line-soft bg-[var(--surface)] shadow-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="truncate ui-section-title">安装桌面小组件</span>
          <button
            type="button"
            aria-label="关闭安装弹窗"
            onClick={onClose}
            className="shrink-0 rounded-sm p-1 text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            <XIcon width={16} height={16} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* 风险声明常驻：这不是普通清单插件，包里有会跑起来的界面代码 */}
          <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3">
            <p className="ui-body-sm font-medium text-[var(--danger)]">
              本插件包含可执行界面代码
            </p>
            <p className="mt-1 ui-caption">
              装好后会在独立窗口里运行（独立 origin、沙箱、无 Node/文件权限）。只允许安装
              <strong className="mx-0.5">插件仓库</strong>或
              <strong className="mx-0.5">你本地确认过的 .tgz</strong>；
              无签名或来源不明的包一律不会安装。
            </p>
          </div>

          {!available && (
            <p className="mt-3 rounded-lg bg-[var(--subtle-2)] px-3 py-2 ui-caption">
              浏览器里没有桌面窗口与安装能力，桌面小组件只在安装版里可用。
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 ui-body-sm text-[var(--danger)]">
              {error}
            </p>
          )}

          {phase.kind === "done" && (
            <div className="mt-3 rounded-lg border border-line bg-[var(--subtle-2)] p-3">
              <p className="ui-body-sm font-medium">{phase.message}</p>
              <p className="mt-1 ui-caption">
                可以在「桌面小组件」列表里启用/停用、显示/隐藏、调设置；卸载会删除插件文件与设置。
              </p>
            </div>
          )}

          {available && phase.kind === "browse" && (
            <>
              {/* 云端目录（bundle） */}
              <section className="mt-4" aria-label="云端插件目录">
                <div className="flex items-center justify-between gap-2">
                  <span className="ui-section-title">云端目录 · 插件</span>
                  <button
                    type="button"
                    onClick={() => void loadCatalog()}
                    disabled={loading}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    刷新目录
                  </button>
                </div>
                {loading && <p className="mt-2 ui-caption">正在读取云端插件目录…</p>}
                {loadError && (
                  <p role="alert" className="mt-2 ui-caption text-[var(--danger)]">
                    {loadError}
                  </p>
                )}
                {!loading && !loadError && entries !== null && entries.length === 0 && (
                  <p className="mt-2 ui-caption">云端目录里暂时没有插件。</p>
                )}
                {entries && entries.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {entries.map((entry) => (
                      <li
                        key={`${entry.id}@${entry.version}`}
                        className="rounded-lg border border-line bg-[var(--surface)] p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="ui-body-sm font-bold">{entry.name}</span>
                          <span className="ui-chip">v{entry.version}</span>
                          <span className="ui-chip">插件仓库</span>
                          <span className="ui-chip text-[var(--danger)]">包含可执行界面代码</span>
                          <span className="ml-auto ui-caption">
                            {sizeText(entry.package?.size)}
                          </span>
                        </div>
                        <p className="mt-1 ui-caption">
                          {entry.description || "（无描述）"}
                          {entry.package ? ` · 指纹 ${shortFingerprint(entry.package.sha256)}` : ""}
                        </p>
                        <button
                          type="button"
                          disabled={!entry.package}
                          onClick={() => setPhase({ kind: "confirm-cloud", entry })}
                          className="ui-btn ui-btn-sm ui-btn-primary mt-2"
                        >
                          {entry.package ? "下载并安装" : "目录缺少包指纹，不可安装"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* 本地 .tgz */}
              <section className="mt-4 border-t border-line-soft pt-4" aria-label="本地插件包">
                <span className="ui-section-title">本地插件包</span>
                <p className="mt-1 ui-caption">
                  选择你从可信来源拿到的 <code>.tgz</code> 插件包；安装前会展示确认。
                </p>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "confirm-local" })}
                  className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
                >
                  选择本地 .tgz
                </button>
              </section>
            </>
          )}

          {phase.kind === "confirm-cloud" && (
            <div className="mt-4 rounded-lg border border-line bg-[var(--subtle-2)] p-3">
              <p className="ui-body-sm font-medium">
                确认安装「{phase.entry.name}」v{phase.entry.version}？
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 ui-caption">
                <li>来源：插件仓库（下载后会校验 sha256 与包大小）。</li>
                <li>包含可执行界面代码，安装后会在独立窗口里运行。</li>
                <li>会写入本机插件目录，并创建该插件的窗口与托盘图标。</li>
              </ul>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "browse" })}
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void installCloud(phase.entry)}
                  className="ui-btn ui-btn-sm ui-btn-primary"
                >
                  确认安装
                </button>
              </div>
            </div>
          )}

          {phase.kind === "confirm-local" && (
            <div className="mt-4 rounded-lg border border-line bg-[var(--subtle-2)] p-3">
              <p className="ui-body-sm font-medium">确认安装本地插件包？</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 ui-caption">
                <li>本地包来源由你自己确认，宿主无法判断它是否可靠。</li>
                <li>包含可执行界面代码，安装后会在独立窗口里运行。</li>
                <li>会写入本机插件目录，并创建该插件的窗口与托盘图标。</li>
              </ul>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "browse" })}
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void installLocal()}
                  className="ui-btn ui-btn-sm ui-btn-primary"
                >
                  选择并安装
                </button>
              </div>
            </div>
          )}

          {phase.kind === "installing" && (
            <p role="status" className="mt-3 ui-body-sm">
              {phase.label}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <span className="mr-auto ui-caption">
            安装包不随应用分发，由云端目录或本地文件提供。
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            {phase.kind === "done" ? "完成" : "关闭"}
          </button>
        </div>
      </div>
    </div>
  );
}
