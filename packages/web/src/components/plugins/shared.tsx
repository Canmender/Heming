import type { PluginInstallPreview, PluginServerDiff } from "../../lib/plugins/index.js";

/**
 * 插件页共用的小组件与样式常量（d.64 · T2）。
 * 只放无业务判断的展示件；任何「贡献/权限」口径都在 `viewModel.ts`。
 */

export const PLUGIN_CARD = "ui-card";
export const HINT = "ui-caption";
export const ERROR_TEXT = "ui-body-sm text-[#b42318]";
export const OK_TEXT = "ui-body-sm text-muted";
export const BTN_GHOST = "ui-btn ui-btn-md ui-btn-ghost";
export const BTN_GHOST_SM = "ui-btn ui-btn-sm ui-btn-ghost";
export const BTN_DANGER_SM = "ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]";
export const BTN_PRIMARY = "ui-btn ui-btn-md ui-btn-primary";
export const CHIP = "ui-chip";

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；缺失或非法返回「—」。 */
export function formatAt(at: string | undefined): string {
  if (!at) return "—";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150 ${
        checked ? "bg-ink" : "bg-[#d8d8d8]"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all duration-150 ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

const diffChipCls = "rounded-sm border px-1.5 py-0.5 text-[10px]";
const diffTone = {
  add: "border-emerald-200 bg-emerald-50 text-emerald-700",
  change: "border-amber-200 bg-amber-50 text-amber-700",
  remove: "border-red-200 bg-red-50 text-red-700",
} as const;

export function DiffChips({
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

export function DiffLine({
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

export function serverDiffLine(diff: PluginServerDiff): {
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

export function hasPreviewChanges(preview: PluginInstallPreview): boolean {
  return (
    preview.skills.added.length > 0 ||
    preview.skills.changed.length > 0 ||
    preview.skills.removed.length > 0 ||
    preview.servers.added.length > 0 ||
    preview.servers.changed.length > 0 ||
    preview.servers.removed.length > 0
  );
}
