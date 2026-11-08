import { useEffect, useMemo, useRef, useState } from "react";
import {
  comparePluginVersions,
  isVersionCompatible,
  pickInstallVersion,
  type MarketPlugin,
  type MarketVersion,
  type PluginCatalogEntry,
} from "@heming/shared";
import { parsePluginManifest, type PluginManifest } from "../../lib/plugins/manifest.js";
import { downloadPluginManifest } from "../../lib/plugins/catalogClient.js";
import {
  fetchMarketDetail,
  indexToCatalogEntry,
  type MarketClientDeps,
} from "../../lib/plugins/marketClient.js";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { BTN_GHOST, CHIP, ERROR_TEXT, HINT } from "./shared.js";

/**
 * 市场详情（d.108）：概述 / 贡献 / 版本历史三块。
 *
 * 数据来源分三层：
 * - 概述与版本历史来自市场索引（一次拉取，零额外请求）；
 * - 贡献块**不在索引里**，按需下载该版本 `plugin.json` 并用既有解析器算（失败可重试，
 *   不阻断版本列表与安装）；
 * - 详细介绍按需拉 `/api/plugin-market/:id/:version/detail`（404 = 没有，正常态）。
 *
 * 边界：详情里的 markdown 只走 `MarkdownMessage`（react-markdown，不渲染原始 HTML）；
 * 安装按钮只把条目交回页面（复用既有 InstallDialog 预览/验签/写入），本组件不写存储。
 */

export interface MarketDetailDialogProps {
  plugin: MarketPlugin;
  hostVersion: string;
  installed?: { id: string; version: string }[];
  deps?: MarketClientDeps;
  onClose: () => void;
  /** 交给页面：下载清单并打开既有安装预览（本组件不直接安装）。 */
  onInstall: (entry: PluginCatalogEntry, version: MarketVersion) => void | Promise<void>;
  /** 测试注入：详情文档加载（缺省 `fetchMarketDetail`）。 */
  loadDetail?: (id: string, version: string, deps?: MarketClientDeps) => Promise<string | null>;
  /** 测试注入：清单加载（缺省 `downloadPluginManifest`）。 */
  loadManifest?: (entry: PluginCatalogEntry, deps?: MarketClientDeps) => Promise<string>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dateText(value: string | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

function sortedVersions(plugin: MarketPlugin): MarketVersion[] {
  return [...plugin.versions].sort((a, b) => comparePluginVersions(b.version, a.version));
}

/** 安装按钮不可用原因（空 = 可安装）。 */
export function marketInstallBlockedReason(
  version: MarketVersion,
  hostVersion: string,
): string | null {
  if (version.status === "deleted") return "该版本已删除，不可安装";
  if (!isVersionCompatible(version, hostVersion)) {
    return `需要和鸣 ${version.engines.heming} 或更高（当前 ${hostVersion}）`;
  }
  if (version.distribution === "bundle") return "界面插件请到「桌面小组件」安装";
  return null;
}

export function MarketDetailDialog({
  plugin,
  hostVersion,
  installed = [],
  deps,
  onClose,
  onInstall,
  loadDetail = fetchMarketDetail,
  loadManifest = downloadPluginManifest,
}: MarketDetailDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });

  const fetchImpl = deps?.fetchImpl;
  const baseUrl = deps?.baseUrl;
  const versions = useMemo(() => sortedVersions(plugin), [plugin]);
  const [selectedVersion, setSelectedVersion] = useState<string>(
    () =>
      pickInstallVersion(plugin, { hostVersion })?.version ??
      versions[0]?.version ??
      "",
  );
  const version = versions.find((item) => item.version === selectedVersion) ?? versions[0];

  const [detail, setDetail] = useState<{
    loading: boolean;
    text: string | null;
    error: string | null;
  }>({ loading: false, text: null, error: null });
  const [manifestState, setManifestState] = useState<{
    loading: boolean;
    manifest: PluginManifest | null;
    error: string | null;
  }>({ loading: false, manifest: null, error: null });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  /** 详情文档：选定版本变化时重新拉；404 视为「没有详情」而不是错误。 */
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    setDetail({ loading: true, text: null, error: null });
    void loadDetail(plugin.id, version.version, { fetchImpl, baseUrl })
      .then((text) => {
        if (!cancelled) setDetail({ loading: false, text, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetail({ loading: false, text: null, error: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id, version?.version, fetchImpl, baseUrl, loadDetail, retryTick]);

  /** 贡献块：索引没有明细，按需下载清单并用既有解析器算（与安装预览同源）。 */
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    setManifestState({ loading: true, manifest: null, error: null });
    void (async () => {
      try {
        const text = await loadManifest(indexToCatalogEntry(plugin, version), { fetchImpl, baseUrl });
        const manifest = parsePluginManifest(text);
        if (!cancelled) setManifestState({ loading: false, manifest, error: null });
      } catch (err) {
        if (!cancelled) {
          setManifestState({ loading: false, manifest: null, error: errorText(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin, version, fetchImpl, baseUrl, loadManifest, retryTick]);

  const installedVersion = installed.find((item) => item.id === plugin.id)?.version ?? null;
  const deprecatedVersion = version?.status === "deprecated";
  const deprecatedPlugin = plugin.status === "deprecated";
  const alternative = plugin.alternativeId?.trim() || null;

  const retry = () => setRetryTick((n) => n + 1);

  const installVersion = async (target: MarketVersion) => {
    if (marketInstallBlockedReason(target, hostVersion)) return;
    setSelectedVersion(target.version);
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstall(indexToCatalogEntry(plugin, target), target);
    } catch (err) {
      setInstallError(`安装失败：${errorText(err)}`);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`市场详情 ${plugin.title ?? plugin.id}`}
        className="flex max-h-[88vh] w-full max-w-[820px] flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-line-soft px-4 py-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-[#fafafa] text-[16px]">
            {plugin.title?.slice(0, 1) ?? "插"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-[15px] font-extrabold">{plugin.title ?? plugin.id}</h2>
              <span className={CHIP}>{plugin.id}</span>
              {deprecatedPlugin && <span className={CHIP}>已弃用</span>}
            </div>
            <p className={`mt-0.5 ${HINT}`}>
              {plugin.author ? `${plugin.author} · ` : ""}
              更新于 {dateText(plugin.updatedAt)}
              {plugin.versions.length > 0
                ? ` · ${plugin.versions.length} 个版本`
                : ""}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭市场详情"
            className="shrink-0 rounded-sm p-1 text-muted hover:bg-[#f0f0f0]"
            onClick={onClose}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {deprecatedPlugin && (
            <div
              role="note"
              className="mb-3 rounded-lg border border-[#f3d2ce] bg-[#fffafa] p-3 ui-body-sm"
            >
              <p className="font-medium text-[#b42318]">该插件已弃用</p>
              {plugin.deprecatedReason && (
                <p className={`mt-1 ${HINT}`}>{plugin.deprecatedReason}</p>
              )}
              {alternative && (
                <p className={`mt-1 ${HINT}`}>建议迁移到「{alternative}」。</p>
              )}
            </div>
          )}

          {/* ── 概述 ── */}
          <section aria-label="概述" className="rounded-lg border border-line-soft p-3">
            <h3 className="ui-body-sm font-bold">概述</h3>
            <p className="mt-1 ui-body-sm text-muted">{plugin.description ?? "暂无描述"}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 ui-caption">
              {plugin.author && <span className={CHIP}>作者 · {plugin.author}</span>}
              {plugin.metadata?.category && (
                <span className={CHIP}>分类 · {plugin.metadata.category}</span>
              )}
              {(plugin.metadata?.tags ?? []).map((tag) => (
                <span key={`tag:${tag}`} className={CHIP}>
                  标签 · {tag}
                </span>
              ))}
              {plugin.homepage && (
                <a
                  className="ui-link"
                  href={plugin.homepage}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  主页
                </a>
              )}
              {plugin.repository && (
                <a
                  className="ui-link"
                  href={plugin.repository}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  仓库
                </a>
              )}
            </div>
          </section>

          {/* ── 贡献 ── */}
          <section aria-label="贡献" className="mt-3 rounded-lg border border-line-soft p-3">
            <div className="flex items-center gap-2">
              <h3 className="ui-body-sm font-bold">贡献</h3>
              {manifestState.loading && <span className={HINT}>正在读取清单…</span>}
            </div>
            {manifestState.error ? (
              <div className="mt-1">
                <p role="alert" className={ERROR_TEXT}>
                  贡献明细加载失败：{manifestState.error}
                </p>
                <button type="button" className="ui-link mt-1" onClick={retry}>
                  重试
                </button>
              </div>
            ) : manifestState.manifest ? (
              <>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className={CHIP}>技能 {manifestState.manifest.contributions.skills.length}</span>
                  <span className={CHIP}>
                    服务 {manifestState.manifest.contributions.mcpServers.length}
                  </span>
                  <span className={CHIP}>
                    命令 {manifestState.manifest.contributions.commands.length}
                  </span>
                  <span className={CHIP}>
                    工具束 {manifestState.manifest.contributions.toolPacks.length}
                  </span>
                  <span className={CHIP}>
                    风险上限{" "}
                    {manifestState.manifest.permissions.tools === "write"
                      ? "读写"
                      : manifestState.manifest.permissions.tools === "read"
                        ? "只读"
                        : "不提供工具"}
                  </span>
                  <span className={CHIP}>
                    网络主机 {manifestState.manifest.permissions.network.length}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {manifestState.manifest.contributions.skills.map((skill) => (
                    <span key={`skill:${skill.name}`} className="ui-chip">
                      {skill.name}
                    </span>
                  ))}
                  {manifestState.manifest.contributions.mcpServers.map((server) => (
                    <span key={`server:${server.key}`} className="ui-chip" title={server.url}>
                      MCP · {server.name}
                    </span>
                  ))}
                  {manifestState.manifest.contributions.commands.map((command) => (
                    <span key={`command:${command.id}`} className="ui-chip">
                      命令 · {command.title}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
          </section>

          {/* ── 版本历史 ── */}
          <section aria-label="版本历史" className="mt-3 rounded-lg border border-line-soft p-3">
            <h3 className="ui-body-sm font-bold">版本历史</h3>
            <ul className="mt-1 divide-y divide-line-soft">
              {versions.map((item) => {
                const reason = marketInstallBlockedReason(item, hostVersion);
                const current = installedVersion === item.version;
                const active = item.version === version?.version;
                return (
                  <li key={item.version} className="flex flex-wrap items-center gap-2 py-2">
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedVersion(item.version)}
                      className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${
                        active ? "border-ink bg-[#f7f7f7] font-bold" : "border-line"
                      }`}
                    >
                      v{item.version}
                    </button>
                    {item.channel === "prerelease" && <span className={CHIP}>预发布</span>}
                    {item.status === "deprecated" && <span className={CHIP}>已弃用</span>}
                    {item.status === "deleted" && <span className={CHIP}>已删除</span>}
                    {current && <span className={CHIP}>已安装</span>}
                    <span className={`ml-auto ${HINT}`}>
                      {dateText(item.publishedAt)} · {sizeText(item.size)}
                    </span>
                    {reason ? (
                      <span role="note" className={HINT}>
                        {reason}
                      </span>
                    ) : (
                      <span className={HINT}>兼容</span>
                    )}
                    <button
                      type="button"
                      disabled={Boolean(reason) || installing}
                      onClick={() => void installVersion(item)}
                      title={reason ?? undefined}
                      className="ui-btn ui-btn-sm ui-btn-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {reason
                        ? "不可安装"
                        : installing && active
                          ? "安装中…"
                          : current
                            ? "重新安装"
                            : installedVersion
                              ? "更新到此版本"
                              : "安装"}
                    </button>
                  </li>
                );
              })}
            </ul>
            {deprecatedVersion && (
              <p role="note" className={`mt-1 ${HINT}`}>
                {version?.statusMessage ?? "该版本已弃用，建议安装更新版本。"}
              </p>
            )}
            {installError && (
              <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                {installError}
              </p>
            )}
          </section>

          {/* ── 详细介绍 ── */}
          <section aria-label="详细介绍" className="mt-3 rounded-lg border border-line-soft p-3">
            <h3 className="ui-body-sm font-bold">详细介绍</h3>
            {detail.loading ? (
              <p className={`mt-1 ${HINT}`} role="status">
                正在加载详细介绍…
              </p>
            ) : detail.error ? (
              <div className="mt-1">
                <p role="alert" className={ERROR_TEXT}>
                  详细介绍加载失败：{detail.error}
                </p>
                <button type="button" className="ui-link mt-1" onClick={retry}>
                  重试
                </button>
              </div>
            ) : detail.text ? (
              <div className="mt-1 ui-body-sm leading-6">
                <MarkdownMessage text={detail.text} />
              </div>
            ) : (
              <p className={`mt-1 ${HINT}`}>该版本没有详细介绍。</p>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
