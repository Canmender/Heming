import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_PLUGINS,
  pluginStore,
  type InstalledPlugin,
  type PluginInstallPreview,
  type PluginManifest,
  type PluginServerDiff,
  type PluginSkillDiff,
  type PluginStore,
} from "../lib/plugins/index.js";
import { PackageIcon, PlusIcon, XIcon } from "./icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useModalA11y } from "./useModalA11y.js";
import { useUiStore } from "../store/ui.js";
import { PageShell } from "./layout/PageShell.js";

/**
 * 插件区：系统能力包（`plugin.json`）的安装、更新、启停与卸载。
 *
 * 一个包可以带入技能（物化进技能池）与远程 MCP 服务（登记进接口区）；
 * 本页只做本机登记，不连接服务、不上传，所有数据只在本机 localStorage。
 */

const cardCls = "rounded-xl border border-line bg-white p-4 shadow-card";
const badgeCls =
  "rounded-sm border border-line-soft bg-[#fafafa] px-1.5 py-0.5 text-[10px] text-muted";
const chipCls = "rounded-sm bg-[#f4f4f4] px-1.5 py-0.5 text-[10px] text-[#666]";
const hintCls = "text-[11px] text-muted";
const errorCls = "text-[12px] text-red-600";
const okCls = "text-[12px] text-muted";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa] disabled:opacity-40";
const btnGhostSm =
  "rounded-lg border border-line px-2 py-1 text-[11px] text-[#555] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";
const btnDangerSm =
  "rounded-lg border border-line px-2 py-1 text-[11px] text-[#b42318] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";
const btnPrimary =
  "rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40";

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150 ${
        checked ? "bg-ink" : "bg-[#d8d8d8]"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all duration-150 ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；缺失或非法返回「—」。 */
function formatAt(at: string | undefined): string {
  if (!at) return "—";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function skillNames(manifest: PluginManifest): string[] {
  return manifest.skills.map((skill) => skill.name);
}

/** 主机名（含端口）；清单已校验合法，这里只用于展示。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const diffChipCls = "rounded-sm border px-1.5 py-0.5 text-[10px]";
const diffTone = {
  add: "border-emerald-200 bg-emerald-50 text-emerald-700",
  change: "border-amber-200 bg-amber-50 text-amber-700",
  remove: "border-red-200 bg-red-50 text-red-700",
} as const;

function DiffChips({
  items,
  tone,
  label,
}: {
  items: string[];
  tone: keyof typeof diffTone;
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((name) => (
        <span
          key={`${label}:${name}`}
          className={`${diffChipCls} ${diffTone[tone]}`}
          title={`${label}：${name}`}
        >
          {tone === "add" ? "+" : tone === "change" ? "~" : "-"} {name}
        </span>
      ))}
    </>
  );
}

function DiffLine({
  label,
  diff,
}: {
  label: string;
  diff: { added: string[]; changed: string[]; removed: string[]; unchanged: unknown[] };
}) {
  const total = diff.added.length + diff.changed.length + diff.removed.length + diff.unchanged.length;
  return (
    <div>
      <div className="text-[11px] text-[#555]">
        <span className="font-bold">{label}</span>
        {total === 0 ? (
          <span className="ml-1">无</span>
        ) : (
          <span className="ml-1">
            新增 {diff.added.length} · 变更 {diff.changed.length} · 移除 {diff.removed.length} · 不变{" "}
            {diff.unchanged.length}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <DiffChips items={diff.added} tone="add" label={`新增${label}`} />
        <DiffChips items={diff.changed} tone="change" label={`变更${label}`} />
        <DiffChips items={diff.removed} tone="remove" label={`移除${label}`} />
      </div>
    </div>
  );
}

function serverDiffLine(diff: PluginServerDiff): {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
} {
  return {
    added: diff.added.map((item) => item.name),
    changed: diff.changed.map((item) => item.name),
    removed: diff.removed.map((item) => item.name),
    unchanged: diff.unchanged.map((item) => item.name),
  };
}

function hasPreviewChanges(preview: PluginInstallPreview): boolean {
  return (
    preview.skills.added.length > 0 ||
    preview.skills.changed.length > 0 ||
    preview.skills.removed.length > 0 ||
    preview.servers.added.length > 0 ||
    preview.servers.changed.length > 0 ||
    preview.servers.removed.length > 0
  );
}

export interface PluginsPageProps {
  plugins?: PluginStore;
}

export function PluginsPage({ plugins = pluginStore }: PluginsPageProps = {}) {
  const [tick, setTick] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstalledPlugin | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // d.61：命令面板「插件」结果跳转 —— 打开该插件详情并短暂高亮卡片。
  // 意图消费即清空；token 变化才触发，不会反复打开。插件页是懒加载页，
  // 钩子放在组件里，挂载晚一帧也能消费到。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  const [highlightPluginId, setHighlightPluginId] = useState<string | null>(null);
  useEffect(() => {
    if (paletteIntent?.kind !== "open-plugin") return;
    const id = paletteIntent.data?.id;
    if (id) {
      setDetailId(id); // 直接开详情：比只高亮卡片更接近「打开插件」的语义
      setHighlightPluginId(id);
    }
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent]);

  // 高亮 2 秒后淡出，并把卡片滚进视野。
  useEffect(() => {
    if (!highlightPluginId) return;
    const el = document.querySelector(`[data-plugin-id="${highlightPluginId}"]`);
    el?.scrollIntoView?.({ block: "center" });
    const timer = window.setTimeout(() => setHighlightPluginId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [highlightPluginId]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeInstall = () => setInstallOpen(false);
  useModalA11y(dialogRef, closeInstall, { active: installOpen });

  const detailRef = useRef<HTMLDivElement>(null);
  const closeDetail = () => setDetailId(null);
  useModalA11y(detailRef, closeDetail, { active: Boolean(detailId && plugins.get(detailId)) });

  const bump = () => setTick((n) => n + 1);
  const list = useMemo(() => plugins.list(), [plugins, tick]);
  const enabledCount = list.filter((plugin) => plugin.enabled).length;

  const previewState = useMemo((): {
    data: PluginInstallPreview | null;
    error: string | null;
  } => {
    if (!text.trim()) return { data: null, error: null };
    try {
      return { data: plugins.preview(text), error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [plugins, text, tick]);

  const preview = previewState.data;
  const updating = Boolean(preview?.existing);
  const blocked = Boolean(preview && (preview.conflicts.length > 0 || preview.limitReached));
  const detail = detailId ? plugins.get(detailId) : undefined;
  const detailSkills = useMemo(
    () => (detailId ? plugins.skillsOf(detailId) : []),
    [plugins, detailId, tick],
  );
  const detailServers = useMemo(
    () => (detailId ? plugins.serversOf(detailId) : []),
    [plugins, detailId, tick],
  );

  const openInstall = () => {
    setText("");
    setMsg(null);
    setInstallOpen(true);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许再次选择同一个文件
    if (!file) return;
    try {
      setText(await file.text());
      setMsg(null);
    } catch {
      setMsg({ kind: "error", text: "读取文件失败：无法读取所选文件" });
    }
  };

  const onInstall = () => {
    if (!preview || blocked) return;
    const before = preview;
    try {
      const result = plugins.install(text);
      const name = result.plugin.manifest.name;
      bump();
      setText("");
      setInstallOpen(false);
      if (result.created) {
        setMsg({
          kind: "ok",
          text: `已安装插件「${name}」：新增 ${result.added} 个技能、${result.serversAdded} 台 MCP 服务`,
        });
      } else if (!hasPreviewChanges(before)) {
        setMsg({ kind: "ok", text: `已更新插件「${name}」：清单与已装内容一致，仅刷新更新时间` });
      } else {
        setMsg({
          kind: "ok",
          text: `已更新插件「${name}」：技能 +${before.skills.added.length}/改${before.skills.changed.length}/删${before.skills.removed.length}，服务 +${before.servers.added.length}/改${before.servers.changed.length}/删${before.servers.removed.length}`,
        });
      }
    } catch (err) {
      setMsg({
        kind: "error",
        text: `安装失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const onToggle = (plugin: InstalledPlugin, next: boolean) => {
    try {
      plugins.setEnabled(plugin.manifest.id, next);
      bump();
      setMsg({
        kind: "ok",
        text: next
          ? `已启用插件「${plugin.manifest.name}」`
          : `已停用插件「${plugin.manifest.name}」，其技能不参与路由，MCP 服务也不再连接`,
      });
    } catch (err) {
      setMsg({
        kind: "error",
        text: `切换失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const plugin = removeTarget;
    plugins.remove(plugin.manifest.id);
    setRemoveTarget(null);
    bump();
    setMsg({
      kind: "ok",
      text: `已卸载插件「${plugin.manifest.name}」，其 ${plugin.skillIds.length} 个技能与 ${plugin.serverIds.length} 台 MCP 服务一并删除`,
    });
  };

  return (
    <PageShell
      title="插件区"
      subtitle="插件是系统能力包（plugin.json）：可带入技能与远程 MCP 服务。安装后技能进入技能池、服务登记到接口区；启用状态与删除范围按插件统一管理，全部数据只在本机。"
      width="wide"
      actions={
        <button type="button" onClick={openInstall} className={`flex items-center gap-1 ${btnGhost}`}>
          <PlusIcon width={12} height={12} aria-hidden="true" />
          安装插件
        </button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={badgeCls}>已装 {list.length}</span>
        <span className={badgeCls}>已启用 {enabledCount}</span>
        <span className="ui-caption">
          同一 id 再次安装 = 覆盖更新；停用不会删除技能或服务配置。
        </span>
      </div>

      {msg && (
        <div role="status" className={`mb-4 ${msg.kind === "error" ? errorCls : okCls}`}>
          {msg.text}
        </div>
      )}

      {list.length === 0 ? (
        <section
          className={`${cardCls} flex flex-col items-center gap-2 py-10 text-center`}
          aria-label="暂无插件"
        >
          <span className="text-muted" aria-hidden="true">
            <PackageIcon width={28} height={28} />
          </span>
          <p className="ui-section-title">还没有安装插件</p>
          <p className="ui-caption">
            一个 plugin.json 可以一次带入一组技能与远程 MCP 服务。点右上角「安装插件」粘贴清单或选择文件。
          </p>
        </section>
      ) : (
        <div className="grid gap-4">
          {list.map((plugin) => {
            const manifest = plugin.manifest;
            return (
              <section
                key={manifest.id}
                data-plugin-id={manifest.id}
                role="region"
                aria-label={`插件 ${manifest.name}`}
                className={`${cardCls} ${
                  highlightPluginId === manifest.id ? "ring-2 ring-[#1a1a1a]/25" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-extrabold">{manifest.name}</span>
                      <span className={badgeCls}>v{manifest.version}</span>
                      <span className={badgeCls}>
                        {plugin.enabled ? "已启用" : "已停用"}
                      </span>
                    </div>
                    <div className={`mt-0.5 ${hintCls}`}>
                      {manifest.id}
                      {manifest.author ? ` · ${manifest.author}` : ""} ·{" "}
                      {plugin.skillIds.length} 个技能 · {plugin.serverIds.length} 台 MCP 服务
                    </div>
                  </div>
                  <Switch
                    label={`启用插件 ${manifest.name}`}
                    checked={plugin.enabled}
                    onChange={(next) => onToggle(plugin, next)}
                  />
                </div>

                <p className="mt-2 break-words text-[12px] text-muted">
                  {manifest.description || "暂无描述"}
                </p>

                <div className="mt-2 flex flex-wrap gap-1">
                  {skillNames(manifest).map((name) => (
                    <span key={`skill:${name}`} className={chipCls}>
                      {name}
                    </span>
                  ))}
                  {manifest.mcpServers.map((server) => (
                    <span key={`server:${server.key}`} className={chipCls} title={server.url}>
                      MCP · {server.name}
                    </span>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2 text-[11px] text-muted">
                  <span>安装于 {formatAt(plugin.installedAt)}</span>
                  <span>· 更新于 {formatAt(plugin.updatedAt)}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={`查看插件详情 ${manifest.name}`}
                      onClick={() => setDetailId(manifest.id)}
                      className={btnGhostSm}
                    >
                      详情
                    </button>
                    {manifest.mcpServers.length > 0 && (
                      <button
                        type="button"
                        aria-label={`查看插件接口 ${manifest.name}`}
                        onClick={() => useUiStore.getState().setPage("interfaces")}
                        className={btnGhostSm}
                      >
                        查看接口
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`查看插件技能 ${manifest.name}`}
                      onClick={() => useUiStore.getState().setPage("skills")}
                      className={btnGhostSm}
                    >
                      查看技能
                    </button>
                    <button
                      type="button"
                      aria-label={`卸载插件 ${manifest.name}`}
                      onClick={() => setRemoveTarget(plugin)}
                      className={btnDangerSm}
                    >
                      卸载
                    </button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className={`mt-3 ${hintCls}`}>
        插件只声明技能与远程 MCP 服务，不含可执行代码、不携带密钥；安装不会启动进程，
        也不会主动联网——服务连接与工具启用由你在接口区发起，工具调用仍走人工确认。
      </p>

      {installOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
          onClick={closeInstall}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="安装插件"
            className="flex max-h-[88vh] w-[min(620px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
              <span className="text-[13px] font-bold">安装 / 更新插件</span>
              <button
                type="button"
                aria-label="关闭安装面板"
                onClick={closeInstall}
                className="rounded-sm p-1 text-muted hover:bg-[#f3f3f3] hover:text-ink"
              >
                <XIcon width={14} height={14} aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <label className="block text-[12px] text-muted">
                插件清单 JSON
                <textarea
                  aria-label="插件清单 JSON"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={`{\n  "schemaVersion": 2,\n  "id": "acme.finance",\n  "name": "财务助手包",\n  "version": "1.0.0",\n  "skills": [ ... ],\n  "mcpServers": [ { "key": "weather", "name": "天气服务", "url": "https://..." } ]\n}`}
                  className="mt-1 block min-h-[160px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 font-mono text-[11px] outline-hidden focus:border-ink"
                />
              </label>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  id="plugin-file-input"
                  type="file"
                  accept=".json,application/json"
                  aria-label="选择插件文件"
                  onChange={(e) => void onFile(e)}
                  className="hidden"
                />
                <label htmlFor="plugin-file-input" className={`cursor-pointer ${btnGhostSm}`}>
                  选择 plugin.json 文件
                </label>
                <span className={hintCls}>
                  只读取本地 JSON；不会上传，也不会执行其中的内容。
                </span>
              </div>

              {previewState.error && (
                <p role="alert" className={`mt-3 ${errorCls}`}>
                  清单不合法：{previewState.error}
                </p>
              )}

              {preview && (
                <div className="mt-3 rounded-lg border border-line bg-[#fafafa] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-bold">{preview.manifest.name}</span>
                    <span className={badgeCls}>v{preview.manifest.version}</span>
                    <span className={badgeCls}>{updating ? "将覆盖更新" : "新插件"}</span>
                  </div>
                  <div className={`mt-0.5 ${hintCls}`}>{preview.manifest.id}</div>
                  <p className="mt-1 break-words text-[12px] text-[#555]">
                    {preview.manifest.description || "暂无描述"}
                  </p>

                  {updating ? (
                    <div className="mt-2 space-y-2">
                      <DiffLine label="技能" diff={preview.skills} />
                      <DiffLine label="MCP 服务" diff={serverDiffLine(preview.servers)} />
                      <p className={hintCls}>
                        {hasPreviewChanges(preview)
                          ? "确认后将保留：接口区补的请求头、已授权工具、插件启停状态与安装时间。"
                          : "清单与已装内容一致，确认后只刷新更新时间。"}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {skillNames(preview.manifest).map((name) => (
                          <span key={`skill:${name}`} className={chipCls}>
                            {name}
                          </span>
                        ))}
                        {preview.manifest.mcpServers.map((server) => (
                          <span
                            key={`server:${server.key}`}
                            className={chipCls}
                            title={server.url}
                          >
                            MCP · {server.name}
                          </span>
                        ))}
                      </div>
                      <div className={`mt-2 ${hintCls}`}>
                        新增 {preview.skills.added.length} 个技能、
                        {preview.servers.added.length} 台 MCP 服务
                      </div>
                    </>
                  )}

                  {preview.manifest.mcpServers.length > 0 && (
                    <div className={`mt-2 ${hintCls}`}>
                      网络访问：{preview.hosts.join("、") || "—"}
                      <br />
                      安装后需到接口区连接并逐个启用工具；调用仍走人工确认。
                    </div>
                  )}

                  {preview.conflicts.length > 0 && (
                    <p role="alert" className={`mt-2 ${errorCls}`}>
                      MCP 服务 id 冲突：
                      {preview.conflicts.map((item) => `${item.name}（${item.id}）`).join("、")}
                      ；请先到接口区删除或改名，再安装。
                    </p>
                  )}
                  {preview.limitReached && (
                    <p role="alert" className={`mt-2 ${errorCls}`}>
                      插件数量已达上限（{MAX_PLUGINS} 个），请先卸载不用的插件。
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
              <button type="button" onClick={closeInstall} className={btnGhost}>
                取消
              </button>
              <button
                type="button"
                onClick={onInstall}
                disabled={!preview || blocked}
                className={btnPrimary}
              >
                {updating ? "确认更新" : "确认安装"}
              </button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
          onClick={closeDetail}
        >
          <div
            ref={detailRef}
            role="dialog"
            aria-modal="true"
            aria-label={`插件详情 ${detail.manifest.name}`}
            className="flex max-h-[88vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
              <span className="text-[13px] font-bold">插件详情</span>
              <button
                type="button"
                aria-label="关闭插件详情"
                onClick={closeDetail}
                className="rounded-sm p-1 text-muted hover:bg-[#f3f3f3] hover:text-ink"
              >
                <XIcon width={14} height={14} aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-extrabold">{detail.manifest.name}</span>
                <span className={badgeCls}>v{detail.manifest.version}</span>
                <span className={badgeCls}>{detail.enabled ? "已启用" : "已停用"}</span>
              </div>
              <div className={`mt-0.5 ${hintCls}`}>
                {detail.manifest.id}
                {detail.manifest.author ? ` · ${detail.manifest.author}` : ""}
              </div>
              <p className="mt-2 break-words text-[12px] text-[#555]">
                {detail.manifest.description || "暂无描述"}
              </p>
              <div className={`mt-2 ${hintCls}`}>
                安装于 {formatAt(detail.installedAt)} · 更新于 {formatAt(detail.updatedAt)}
                <br />
                停用插件会同时关闭其技能与 MCP 服务；数据与配置保留。
              </div>

              <section className="mt-4" aria-label="插件技能">
                <h3 className="text-[12px] font-bold">技能（{detailSkills.length}）</h3>
                {detailSkills.length === 0 ? (
                  <p className={`mt-1 ${hintCls}`}>本包未声明技能</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {detailSkills.map((skill) => (
                      <li
                        key={skill.id}
                        className="rounded-lg border border-line-soft px-2.5 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-medium">{skill.name}</span>
                          <span className={badgeCls}>{skill.enabled ? "启用" : "已停用"}</span>
                        </div>
                        {skill.description && (
                          <p className="mt-0.5 text-[11px] text-muted">{skill.description}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="mt-4" aria-label="插件 MCP 服务">
                <h3 className="text-[12px] font-bold">MCP 服务（{detailServers.length}）</h3>
                {detailServers.length === 0 ? (
                  <p className={`mt-1 ${hintCls}`}>本包未声明 MCP 服务</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {detailServers.map((server) => (
                      <li
                        key={server.id}
                        className="rounded-lg border border-line-soft px-2.5 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-medium">{server.name}</span>
                          <span className={badgeCls}>
                            {server.enabled ? "已启用" : "已停用"}
                          </span>
                          <span className={badgeCls}>{hostOf(server.url)}</span>
                        </div>
                        <code className="mt-0.5 block break-all text-[10px] text-muted">
                          {server.url}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={`mt-1 ${hintCls}`}>
                  连接与工具授权在接口区进行；本页只读，不发起网络请求。
                </p>
              </section>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
              <button
                type="button"
                onClick={() => {
                  setDetailId(null);
                  useUiStore.getState().setPage("skills");
                }}
                className={btnGhostSm}
              >
                查看技能
              </button>
              {detailServers.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setDetailId(null);
                    useUiStore.getState().setPage("interfaces");
                  }}
                  className={btnGhostSm}
                >
                  查看接口
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const target = detail;
                  setDetailId(null);
                  setRemoveTarget(target);
                }}
                className={btnDangerSm}
              >
                卸载插件
              </button>
              <button type="button" onClick={closeDetail} className={btnGhost}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="卸载插件"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmRemove}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                卸载
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            卸载插件「{removeTarget.manifest.name}」？它的{" "}
            {removeTarget.skillIds.length} 个技能（含使用统计与智能体分配）与{" "}
            {removeTarget.serverIds.length} 台 MCP 服务（含工具清单与工具启用状态）
            都会一并删除，此操作不可恢复。
          </p>
        </ConfirmDialog>
      )}
    </PageShell>
  );
}
