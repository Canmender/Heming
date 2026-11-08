import { useMemo, useState, type ReactNode } from "react";
import {
  CONTRIBUTION_LABELS,
  UNIT_SOURCE_LABELS,
  blockReasonText,
  type UnitSource,
  type UnitStatus,
} from "@heming/shared";
import { useUnitStatuses } from "../../lib/units/registry.js";
import { BTN_GHOST_SM, CHIP, HINT } from "./shared.js";

/**
 * 插件区「已安装」统一单元列表（d.105 · 阶段 A）。
 *
 * 四类来源（系统 / 内置模块 / 声明式插件 / 界面插件）读同一份 `UnitStatus[]`：
 * - 来源徽标 + 名称 + 版本 + 状态（生效 / 停用 / 待依赖 / 不兼容 / 降级）；
 * - 贡献摘要（技能 3 · 服务 1 …；被贡献级停用的类别标「未生效」）；
 * - 搜索（名称 / id / 描述 / 关键词）与来源筛选；
 * - 系统能力置顶只读，不占插件数量上限。
 *
 * ★ 不碰存储：启用/停用/卸载仍由各 store 的既有入口处理；本组件只读投影。
 * ★ `renderUnit`：插件卡与系统卡沿用既有组件（保留详情/开关/卸载入口与既有
 *   可访问名），其余来源用本文件的默认行；阶段 C 再统一卡片样式。
 */

const SOURCE_FILTERS: { key: UnitSource | "all"; label: string }[] = [
  { key: "all", label: "全部来源" },
  { key: "system", label: "系统" },
  { key: "builtin", label: "内置模块" },
  { key: "package", label: "插件" },
  { key: "bundle", label: "界面插件" },
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
  生效: "border-emerald-200 bg-emerald-50 text-emerald-700",
  已停用: "border-line bg-[#f7f7f7] text-muted",
  待依赖: "border-amber-200 bg-amber-50 text-amber-700",
  不兼容: "border-red-200 bg-red-50 text-red-700",
  部分停用: "border-amber-200 bg-amber-50 text-amber-700",
  签名异常: "border-red-200 bg-red-50 text-red-700",
  降级: "border-amber-200 bg-amber-50 text-amber-700",
  未生效: "border-line bg-[#f7f7f7] text-muted",
};

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
function UnitRow({ status }: { status: UnitStatus }) {
  const unit = status.unit;
  const label = unitStatusLabel(status);
  const reason = status.reason ? blockReasonText(status.reason) : "";
  return (
    <section
      role="region"
      aria-label={`能力单元 ${unit.name}`}
      data-unit-id={unit.id}
      className="ui-card"
    >
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
}

/** 插件区「已安装」区：统一能力单元列表 + 搜索/来源/状态筛选。 */
export function UnitListView({ statuses, renderUnit }: UnitListViewProps) {
  const subscribed = useUnitStatuses();
  const all = statuses ?? subscribed;
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<UnitSource | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");

  const sourceUnits = useMemo(
    () => (source === "all" ? all : all.filter((item) => item.unit.source === source)),
    [all, source],
  );
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
  const clearFilters = () => {
    setQuery("");
    setSource("all");
    setStatusFilter("all");
  };

  return (
    <div aria-label="已安装能力单元">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="搜索插件"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称、id、描述或贡献搜索"
          className="ui-input min-w-[200px] max-w-[320px] flex-1"
        />
        <div role="group" aria-label="按来源筛选" className="flex flex-wrap items-center gap-1">
          {SOURCE_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={source === item.key}
              onClick={() => setSource(item.key)}
              className={`ui-btn ui-btn-sm ${
                source === item.key ? "ui-btn-primary" : "ui-btn-ghost text-muted"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="按状态筛选" className="flex items-center gap-1">
          {STATUS_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={statusFilter === item.key}
              onClick={() => setStatusFilter(item.key)}
              className={`ui-btn ui-btn-sm ${
                statusFilter === item.key ? "ui-btn-primary" : "ui-btn-ghost text-muted"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="ui-caption">
          {filterActive
            ? `匹配 ${visible.length} / 共 ${sourceUnits.length} 个单元`
            : `共 ${sourceUnits.length} 个单元`}
        </span>
      </div>

      {visible.length === 0 ? (
        <section
          role="region"
          aria-label="筛选无结果"
          className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white py-10 text-center shadow-card"
        >
          <p className="ui-section-title">没有匹配的能力单元</p>
          <p className="ui-caption">换个关键词或来源，或清除筛选看全部。</p>
          <button type="button" onClick={clearFilters} className={`mt-1 ${BTN_GHOST_SM}`}>
            清除筛选
          </button>
        </section>
      ) : (
        <ul className="grid gap-3">
          {visible.map((status) => {
            const custom = renderUnit?.(status) ?? null;
            const label = unitStatusLabel(status);
            return (
              <li key={`${status.unit.source}:${status.unit.id}`} className="min-w-0">
                {custom ? (
                  <>
                    {/* 卡片自带的头部不统一（插件卡无来源徽标、系统卡写「内置」），
                        统一列表在卡片上方补一行来源/状态，扫读时四类来源才一致。 */}
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className={CHIP}>{UNIT_SOURCE_LABELS[status.unit.source]}</span>
                      <span
                        className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${STATUS_TONE[label] ?? ""}`}
                        title={status.reason ? blockReasonText(status.reason) : label}
                      >
                        {label}
                      </span>
                      {status.unit.readonly && <span className={CHIP}>只读</span>}
                    </div>
                    {custom}
                  </>
                ) : (
                  <UnitRow status={status} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
