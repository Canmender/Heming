import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CONTRIBUTION_LABELS,
  UNIT_SOURCE_LABELS,
  blockReasonText,
  type UnitSource,
  type UnitStatus,
} from "@heming/shared";
import { useUnitStatuses } from "../../lib/units/registry.js";
import {
  PLUGIN_HEALTH_LABELS,
  type PluginHealth,
  type PluginHealthLevel,
} from "../../lib/plugins/index.js";
import { SearchIcon } from "../icons.js";
import { BTN_GHOST_SM, CHIP, HINT } from "./shared.js";

/**
 * 插件区「已安装」统一单元列表（d.105 · 阶段 A）。
 *
 * 三类来源（系统 / 声明式插件 / 界面插件）读同一份 `UnitStatus[]`：
 * - 来源徽标 + 名称 + 版本 + 状态（生效 / 停用 / 待依赖 / 不兼容 / 降级）；
 * - 贡献摘要（技能 3 · 服务 1 …；被贡献级停用的类别标「未生效」）；
 * - 搜索（名称 / id / 描述 / 关键词）与来源筛选；
 * - 系统能力置顶只读，不占插件数量上限。
 *
 * ★ 不碰存储：启用/停用/卸载仍由各 store 的既有入口处理；本组件只读投影。
 * ★ `renderUnit`：插件卡与系统卡沿用既有组件（保留详情/开关/卸载入口与既有
 *   可访问名），其余来源用本文件的默认行；阶段 C 再统一卡片样式。
 */

/**
 * 来源筛选（d.133）：用户口径「全部是插件」——不再区分声明式/界面插件，
 * 只保留「系统能力（只读）」和「插件」两档。
 */
type SourceFilter = "all" | "system" | "plugin";
const SOURCE_FILTERS: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "全部插件" },
  { key: "system", label: "系统" },
  { key: "plugin", label: "插件" },
];

const STATUS_FILTERS: { key: "all" | "enabled" | "disabled"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "enabled", label: "已启用" },
  { key: "disabled", label: "已停用" },
];

/** 列表行状态：生效优先；否则按第一条阻断原因给一个可扫读的标签。 */
export function unitStatusLabel(status: UnitStatus): string {
  if (status.effective) return "生效";
  switch (status.reason?.kind) {
    case "notInstalled":
      return "未安装";
    case "disabled":
      return "已停用";
    case "missingRequirement":
      return "待依赖";
    case "incompatible":
    case "invalidEngines":
      return "不兼容";
    case "kindDisabled":
      return "部分停用";
    case "signature":
      return "签名异常";
    case "degraded":
      return "降级";
    default:
      return "未生效";
  }
}

const STATUS_TONE: Record<string, string> = {
  生效: "plugin-tone-ok",
  未安装: "plugin-tone-neutral",
  已停用: "plugin-tone-neutral",
  待依赖: "plugin-tone-warn",
  不兼容: "plugin-tone-danger",
  部分停用: "plugin-tone-warn",
  签名异常: "plugin-tone-danger",
  降级: "plugin-tone-warn",
  未生效: "plugin-tone-neutral",
};

/* ───────────────────── 健康度徽标与修复入口（d.113） ───────────────────── */

const HEALTH_TONE: Record<PluginHealthLevel, string> = {
  ok: "plugin-tone-ok",
  degraded: "plugin-tone-warn",
  broken: "plugin-tone-danger",
};

/** 健康度徽标：正常/降级/损坏；悬停展示全部 issue（诊断区另有明细）。 */
export function HealthBadge({ health }: { health: PluginHealth }) {
  const label = PLUGIN_HEALTH_LABELS[health.level];
  const title =
    health.issues.length > 0
      ? health.issues.map((issue) => issue.message).join("；")
      : "没有发现问题";
  return (
    <span
      aria-label={`健康度 ${label}`}
      title={title}
      className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${HEALTH_TONE[health.level]}`}
    >
      {label}
    </span>
  );
}

/** 「修复记录」按钮（仅 broken 单元显示；只修记录，不删技能/服务）。 */
export function RepairRecordButton({
  pluginName,
  busy,
  onRepair,
}: {
  pluginName: string;
  busy: boolean;
  onRepair: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`修复记录 ${pluginName}`}
      disabled={busy}
      onClick={onRepair}
      className={BTN_GHOST_SM}
    >
      {busy ? "修复中…" : "修复记录"}
    </button>
  );
}

function unitSearchText(status: UnitStatus): string {
  const unit = status.unit;
  return [
    unit.name,
    unit.id,
    unit.description,
    ...(unit.meta?.keywords ?? []),
    ...(unit.meta?.tags ?? []),
    ...unit.contributions.map((item) => CONTRIBUTION_LABELS[item.kind]),
  ]
    .join("\n")
    .toLowerCase();
}

function matchesQuery(status: UnitStatus, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = unitSearchText(status);
  return terms.every((term) => haystack.includes(term));
}

function contributionSummary(status: UnitStatus): string {
  const parts = status.unit.contributions
    .filter((item) => item.count > 0)
    .map((item) => {
      const label = CONTRIBUTION_LABELS[item.kind];
      const active = status.activeKinds.includes(item.kind);
      return `${label} ${item.count}${active ? "" : "（未生效）"}`;
    });
  return parts.length > 0 ? parts.join(" · ") : "无贡献";
}

/** 默认行：来源徽标 / 名称 / 版本 / 状态 / 贡献摘要 / 阻断原因。 */
function UnitRow({
  status,
  health,
  repair,
}: {
  status: UnitStatus;
  health?: PluginHealth;
  repair?: ReactNode;
}) {
  const unit = status.unit;
  const label = unitStatusLabel(status);
  const reason = status.reason ? blockReasonText(status.reason) : "";
  const initial = Array.from(unit.name)[0]?.toUpperCase() ?? "?";
  return (
    <section
      role="region"
      aria-label={`能力单元 ${unit.name}`}
      className="ui-card plugin-card p-4"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="plugin-icon-tile h-9 w-9 text-[13px] font-bold">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={CHIP}>{UNIT_SOURCE_LABELS[unit.source]}</span>
            <span className="truncate text-[13px] font-extrabold">{unit.name}</span>
            <span className={CHIP}>v{unit.version}</span>
            <span
              className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${STATUS_TONE[label] ?? ""}`}
              title={reason || label}
            >
              {label}
            </span>
            {health && <HealthBadge health={health} />}
            {repair}
            {unit.readonly && <span className={CHIP}>只读</span>}
          </div>
          <div className={`mt-0.5 ${HINT}`}>
            {unit.id}
            {unit.source === "builtin" && unit.storageKeys?.length
              ? ` · 本机数据 ${unit.storageKeys.length} 项`
              : ""}
          </div>
          <p className="mt-1 ui-body-sm text-muted">{unit.description || "暂无描述"}</p>
          <p className={`mt-1 ${HINT}`}>贡献：{contributionSummary(status)}</p>
          {reason && (
            <p className={`mt-1 ${HINT}`} role="note">
              {reason}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export interface UnitListViewProps {
  /** 覆盖投影（测试/宿主注入）；缺省读 `useUnitStatuses()`。 */
  statuses?: UnitStatus[];
  /**
   * 自定义单行渲染：返回 `null` 时回落到默认行。
   * 插件页用它复用既有 `PluginCard` / `SystemPluginCard`（保留详情与启停入口）。
   */
  renderUnit?: (status: UnitStatus) => ReactNode | null;
  /**
   * 外部定位某个单元（d.108 命令 `target=unit`）：清空筛选、滚动到该行并短暂高亮。
   * `seq` 由投递方的意图 token 提供——同一条命令连点两次也能重新定位。
   */
  focusUnit?: { id: string; seq: number } | null;
  /** d.113：按单元 id 注入健康度（只对声明式插件单元有值）。 */
  healthByUnitId?: Record<string, PluginHealth>;
  /** d.113：「修复记录」动作（broken 单元显示按钮）。 */
  onRepair?: (pluginId: string) => void;
  /** 正在修复的插件 id（按钮禁用并显示「修复中…」）。 */
  repairingPluginId?: string | null;
}

/** 外部定位后的高亮时长（与设置页卡片高亮同口径）。 */
const UNIT_HIGHLIGHT_MS = 2000;

/** 插件区「已安装」区：统一能力单元列表 + 搜索/来源/状态筛选。 */
export function UnitListView({
  statuses,
  renderUnit,
  focusUnit,
  healthByUnitId,
  onRepair,
  repairingPluginId,
}: UnitListViewProps) {
  const subscribed = useUnitStatuses();
  const all = statuses ?? subscribed;
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  /** 外部定位命中的单元 id：短暂描边，滚动完不会残留。 */
  const [highlightUnitId, setHighlightUnitId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  // 命令面板 target=unit：先清筛选保证目标可见，等这一帧渲染完再滚动 + 高亮。
  useEffect(() => {
    if (!focusUnit) return;
    setQuery("");
    setSource("all");
    setStatusFilter("all");
    let cancelled = false;
    const raf = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-unit-id="${focusUnit.id}"]`);
      // jsdom 没有 scrollIntoView：可选调用，测试里由用例自己打桩断言
      el?.scrollIntoView?.({ block: "center" });
      setHighlightUnitId(focusUnit.id);
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => {
        highlightTimer.current = null;
        setHighlightUnitId(null);
      }, UNIT_HIGHLIGHT_MS);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [focusUnit]);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  /** 当前列表里真实出现的来源：没有的筛选按钮不渲染（例如原生应用没有界面插件）。 */
  const presentSources = useMemo(() => new Set(all.map((item) => item.unit.source)), [all]);
  const sourceFilters = useMemo(
    () =>
      SOURCE_FILTERS.filter(
        (item) =>
          item.key === "all" ||
          (item.key === "plugin"
            ? [...presentSources].some((value) => value !== "system")
            : presentSources.has("system")),
      ),
    [presentSources],
  );
  const sourceUnits = useMemo(() => {
    if (source === "all") return all;
    if (source === "plugin") return all.filter((item) => item.unit.source !== "system");
    return all.filter((item) => item.unit.source === "system");
  }, [all, source]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = useMemo(
    () =>
      sourceUnits.filter((item) => {
        if (statusFilter === "enabled" && !item.unit.enabled) return false;
        if (statusFilter === "disabled" && item.unit.enabled) return false;
        return matchesQuery(item, terms);
      }),
    [sourceUnits, statusFilter, terms],
  );

  const filterActive = query.trim().length > 0 || source !== "all" || statusFilter !== "all";
  // d.138：只有一两个单元时，来源/状态两组筛选是纯噪声（1 个只读项配 6 个控件）。
  // 3 个单元起才展开这两组；搜索框一直保留，因为它同时能过滤描述与贡献。
  const showFilterGroups = sourceUnits.length > 2;
  const clearFilters = () => {
    setQuery("");
    setSource("all");
    setStatusFilter("all");
  };

  return (
    <div aria-label="已安装能力单元">
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] p-2.5">
        <div className="relative min-w-[200px] max-w-[320px] flex-1">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
          >
            <SearchIcon width={13} height={13} />
          </span>
          <input
            aria-label="搜索插件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按名称、id、描述或贡献搜索"
            className="ui-input pl-7"
          />
        </div>
        {showFilterGroups ? (
          <>
            <div
              role="group"
              aria-label="按来源筛选"
              className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-line-soft bg-[var(--subtle-2)] p-0.5"
            >
              {sourceFilters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={source === item.key}
                  onClick={() => setSource(item.key)}
                  className="plugin-segment"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div
              role="group"
              aria-label="按状态筛选"
              className="inline-flex items-center gap-0.5 rounded-lg border border-line-soft bg-[var(--subtle-2)] p-0.5"
            >
              {STATUS_FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={statusFilter === item.key}
                  onClick={() => setStatusFilter(item.key)}
                  className="plugin-segment"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <span aria-live="polite" className="ml-auto ui-caption ui-numeric">
          {filterActive
            ? `匹配 ${visible.length} / 共 ${sourceUnits.length} 个单元`
            : `共 ${sourceUnits.length} 个单元`}
        </span>
      </div>

      {visible.length === 0 ? (
        <section
          role="region"
          aria-label="筛选无结果"
          className="flex flex-col items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] py-10 text-center shadow-card"
        >
          <span aria-hidden="true" className="plugin-icon-tile mb-1 h-10 w-10">
            <SearchIcon width={18} height={18} />
          </span>
          <p className="ui-section-title">没有匹配的能力单元</p>
          <p className="ui-caption">换个关键词或来源，或清除筛选看全部。</p>
          <button type="button" onClick={clearFilters} className={`mt-1 ${BTN_GHOST_SM}`}>
            清除筛选
          </button>
        </section>
      ) : (
        <ul className="grid gap-3">
          {visible.map((status, index) => {
            const custom = renderUnit?.(status) ?? null;
            const label = unitStatusLabel(status);
            const health = healthByUnitId?.[status.unit.id];
            const repair =
              health?.level === "broken" && onRepair ? (
                <RepairRecordButton
                  pluginName={status.unit.name}
                  busy={repairingPluginId === status.unit.id}
                  onRepair={() => onRepair(status.unit.id)}
                />
              ) : null;
            return (
              <li
                key={`${status.unit.source}:${status.unit.id}`}
                data-unit-id={status.unit.id}
                style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
                className={`plugin-rise min-w-0 rounded-xl transition-shadow ${
                  highlightUnitId === status.unit.id
                    ? "outline outline-2 outline-offset-2 outline-ink"
                    : ""
                }`}
              >
                {custom ? (
                  <>
                    {/* 卡片自带的头部不统一（插件卡无来源徽标、系统卡写「内置」），
                        统一列表在卡片上方补一行来源/状态/健康度，扫读时四类来源才一致。 */}
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
                      <span className={CHIP}>{UNIT_SOURCE_LABELS[status.unit.source]}</span>
                      <span
                        className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${STATUS_TONE[label] ?? ""}`}
                        title={status.reason ? blockReasonText(status.reason) : label}
                      >
                        {label}
                      </span>
                      {health && <HealthBadge health={health} />}
                      {repair}
                      {status.unit.readonly && <span className={CHIP}>只读</span>}
                    </div>
                    {custom}
                  </>
                ) : (
                  <UnitRow status={status} health={health} repair={repair} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
