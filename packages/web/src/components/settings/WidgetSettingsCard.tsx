import { useCallback, useEffect, useMemo, useState } from "react";
import type { WidgetRecord, WidgetSettingField, WidgetState } from "../../types/widgets.js";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";
import {
  refreshWidgets,
  runWidgetAction,
  saveWidgetSettings,
  useWidgetsStore,
  widgetsAvailable,
} from "../../lib/widgets/store.js";
import {
  coerceWidgetSettingValue,
  defaultWidgetSettingValue,
  widgetSettingOptions,
  widgetSettingValue,
  type WidgetSettingValue,
} from "../../lib/widgets/fields.js";
import {
  dismissPetMigrationHint,
  shouldShowPetMigrationHint,
} from "../../lib/widgets/legacy.js";

/**
 * 设置区「外观 · 桌面小组件」卡（d.98 · 规格 §4.2）。
 *
 * 两段内容，全部由宿主通用渲染、插件不需要写设置界面：
 * 1. **宿主动作**（规格 §2.3「窗口通用动作」）：显示/隐藏、放大一档/缩小一档、
 *    鼠标穿透、重置位置——即使插件没声明 settings，这些按钮也在；
 * 2. **清单 `settings.fields` 通用表单**：boolean / select / text / number / agent 五种类型。
 *    值由主进程持有（`userData/plugins/<id>/settings.json`），这里经 IPC 读写。
 *
 * ★ 为什么设置卡放在「外观」：它是桌面外观的一部分（原桌宠卡的位置），
 *   用户找「怎么让桌宠回来 / 怎么调大小」时不会想到去插件区深处翻。
 *   未安装时同页给一次性「桌宠已改为插件」提示（与插件区同源，只提示一次）。
 */

/** 无设置字段时也要显示的宿主动作（规格要求「宿主渲染，不用插件声明」）。 */
const HOST_ACTIONS: Array<{ action: Parameters<typeof runWidgetAction>[1]; label: string }> = [
  { action: "scaleUp", label: "放大一档" },
  { action: "scaleDown", label: "缩小一档" },
  { action: "toggleClickThrough", label: "鼠标穿透" },
  { action: "resetPosition", label: "重置位置" },
];

function scaleLabel(scale: number | undefined): string {
  return scale ? `${Math.round(scale * 100)}%` : "—";
}

export function WidgetSettingsCard() {
  const records = useWidgetsStore((state) => state.records);
  const states = useWidgetsStore((state) => state.states);
  const loaded = useWidgetsStore((state) => state.loaded);
  const available = widgetsAvailable();

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [petHint, setPetHint] = useState(false);

  const needsAgents = useMemo(
    () =>
      records.some((record) =>
        (record.widget?.settings?.fields ?? []).some((field) => field.type === "agent"),
      ),
    [records],
  );
  const agentsRoster = useChatStore((state) => state.agentsRoster);
  const loadAgentsRoster = useChatStore((state) => state.loadAgentsRoster);

  useEffect(() => {
    void refreshWidgets();
  }, []);

  useEffect(() => {
    if (!needsAgents) return;
    void loadAgentsRoster().catch(() => {
      /* 名册拉不到时下拉框只显示「不绑定」，不影响其它字段 */
    });
  }, [needsAgents, loadAgentsRoster]);

  useEffect(() => {
    if (!loaded) return;
    if (shouldShowPetMigrationHint(records)) {
      setPetHint(true);
      dismissPetMigrationHint();
    }
  }, [loaded, records]);

  const flashSaved = useCallback(() => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }, []);

  const commit = useCallback(
    async (record: WidgetRecord, field: WidgetSettingField, raw: unknown): Promise<void> => {
      const coerced = coerceWidgetSettingValue(field, raw);
      if (!coerced.ok) {
        setError(`${field.label}：${coerced.error}`);
        return;
      }
      setError(null);
      const result = await saveWidgetSettings(record.id, { [field.key]: coerced.value });
      if (result.ok) flashSaved();
      else setError(result.error ?? "保存失败");
    },
    [flashSaved],
  );

  const onAction = useCallback(async (id: string, action: Parameters<typeof runWidgetAction>[1]) => {
    const result = await runWidgetAction(id, action);
    if (!result.ok) setError(result.error ?? "操作失败");
    else setError(null);
  }, []);

  if (!available) {
    return (
      <section aria-label="桌面小组件" className="rounded-xl border border-line bg-white p-4 shadow-card">
        <p className="ui-body-sm font-medium">桌面小组件</p>
        <p className="mt-1 ui-caption">仅桌面端可用：浏览器里没有桌面窗口能力。</p>
      </section>
    );
  }

  return (
    <section aria-label="桌面小组件" className="rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center gap-2">
        <span className="ui-body-sm font-bold">桌面小组件</span>
        {saved && (
          <span role="status" className="ui-caption">
            已保存
          </span>
        )}
      </div>
      <p className="mt-1 ui-caption">
        桌宠等界面插件装好后在这里调：宿主动作（显示/缩放/穿透/位置）与插件声明的设置项。
      </p>

      {error && (
        <p role="alert" className="mt-2 ui-body-sm text-[#b42318]">
          {error}
        </p>
      )}

      {petHint && (
        <div className="mt-3 rounded-lg border border-line bg-[#fafafa] p-3">
          <p className="ui-body-sm font-medium">桌宠已改为插件</p>
          <p className="mt-1 ui-caption">
            桌宠不再随本体安装，改成可安装的界面插件（`heming.pet`）。装好后设置会出现在这里。
          </p>
          <button
            type="button"
            onClick={() => useUiStore.getState().setPage("plugins")}
            className="ui-btn ui-btn-sm ui-btn-primary mt-2"
          >
            去插件区安装
          </button>
        </div>
      )}

      {!loaded ? (
        <p className="mt-3 ui-caption">正在读取桌面小组件…</p>
      ) : records.length === 0 ? (
        <div className="mt-3 rounded-lg bg-[#f7f7f7] px-3 py-2">
          <p className="ui-caption">
            还没有安装桌面小组件。桌宠已改为插件，装好后这里会出现它的设置。
          </p>
          <button
            type="button"
            onClick={() => useUiStore.getState().setPage("plugins")}
            className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
          >
            去插件区
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          {records.map((record) => (
            <WidgetBlock
              key={record.id}
              record={record}
              state={states[record.id]}
              agents={agentsRoster}
              onAction={onAction}
              onCommit={(field, raw) => void commit(record, field, raw)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WidgetBlock({
  record,
  state,
  agents,
  onAction,
  onCommit,
}: {
  record: WidgetRecord;
  state: WidgetState | undefined;
  agents: Array<{ id: string; name: string }>;
  onAction: (id: string, action: Parameters<typeof runWidgetAction>[1]) => Promise<void>;
  onCommit: (field: WidgetSettingField, raw: unknown) => void;
}) {
  // 页面型界面插件没有浮窗（d.124）：没有窗口设置表单，也不提供窗口动作
  const fields = record.widget?.settings?.fields ?? [];
  const title = record.widget?.settings?.title ?? record.name;
  const disabled = !record.enabled || Boolean(record.error);

  return (
    <div className="rounded-lg border border-line-soft p-3" data-widget-settings-id={record.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-body-sm font-medium">{title}</span>
        <span className="ui-chip">v{record.version}</span>
        <span className="ui-chip">{state?.visible ? "显示中" : "已隐藏"}</span>
        <span className="ui-chip">{scaleLabel(state?.scale)}</span>
        <span className="ui-chip">{state?.clickThrough ? "鼠标穿透" : "可点击"}</span>
        {!record.enabled && <span className="ui-chip">已停用</span>}
      </div>

      {record.error && (
        <p role="alert" className="mt-2 ui-body-sm text-[#b42318]">
          无法运行：{record.error}
        </p>
      )}

      {/* 宿主动作：与插件区列表同一套通道，状态共用主进程真源。
          页面型界面插件没有浮窗，不渲染窗口动作（d.124）。 */}
      {record.widget ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onAction(record.id, "toggle")}
            className="ui-btn ui-btn-sm ui-btn-ghost"
          >
            {state?.visible ? "隐藏" : "显示"}
          </button>
          {HOST_ACTIONS.map((item) => (
            <button
              key={item.action}
              type="button"
              disabled={disabled}
              onClick={() => void onAction(record.id, item.action)}
              className="ui-btn ui-btn-sm ui-btn-ghost"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 ui-caption">这个界面插件只提供插件页面，没有桌面浮窗。</p>
      )}

      {fields.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {fields.map((field) => (
            <SettingRow
              key={field.key}
              field={field}
              record={record}
              agents={agents}
              disabled={disabled}
              onCommit={onCommit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SettingRow({
  field,
  record,
  agents,
  disabled,
  onCommit,
}: {
  field: WidgetSettingField;
  record: WidgetRecord;
  agents: Array<{ id: string; name: string }>;
  disabled: boolean;
  onCommit: (field: WidgetSettingField, raw: unknown) => void;
}) {
  const value = widgetSettingValue(field, record.settings);
  const options = widgetSettingOptions(field);

  if (field.type === "boolean") {
    return (
      <label className="flex items-center justify-between gap-3">
        <span className="ui-body-sm text-ink">{field.label}</span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={value === true}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onCommit(field, event.target.checked)}
          className="h-4 w-4 accent-[var(--accent,#2f5bd7)]"
        />
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label className="flex flex-wrap items-center justify-between gap-2">
        <span className="ui-body-sm text-ink">{field.label}</span>
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onCommit(field, event.target.value)}
          className="ui-input min-w-[160px]"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === "agent") {
    const current = typeof value === "string" ? value : "";
    return (
      <label className="flex flex-wrap items-center justify-between gap-2">
        <span className="ui-body-sm text-ink">{field.label}</span>
        <select
          value={current}
          disabled={disabled}
          onChange={(event) => onCommit(field, event.target.value || null)}
          className="ui-input min-w-[160px]"
        >
          <option value="">不绑定（用默认智能体）</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
          {/* 已绑定但名册里没有（智能体被删/名册没拉到）：保留当前值，不静默清空 */}
          {current && !agents.some((agent) => agent.id === current) && (
            <option value={current}>{current}</option>
          )}
        </select>
      </label>
    );
  }

  const isNumber = field.type === "number";
  return (
    <DraftRow
      label={field.label}
      disabled={disabled}
      initial={value === null || value === undefined ? "" : String(value)}
      numeric={isNumber}
      onCommit={(raw) => onCommit(field, isNumber ? Number(raw) : raw)}
    />
  );
}

/**
 * text / number 字段：本地草稿 + 失焦或回车提交。
 *
 * 为什么不是每次按键都写 IPC：设置是持久数据，逐字写会把 `settingsSet` 打成打字机；
 * 而丢焦点/回车是用户明确的「改完了」信号。Esc 放弃本次编辑（恢复为已保存值）。
 */
function DraftRow({
  label,
  initial,
  numeric,
  disabled,
  onCommit,
}: {
  label: string;
  initial: string;
  numeric: boolean;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const commit = (): void => {
    if (draft === initial) return;
    if (numeric && draft.trim() !== "" && !Number.isFinite(Number(draft))) return;
    onCommit(draft.trim() === "" && !numeric ? "" : draft);
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="ui-body-sm text-ink">{label}</span>
      <input
        type={numeric ? "number" : "text"}
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            setDraft(initial);
            (event.target as HTMLInputElement).blur();
          }
        }}
        className="ui-input"
      />
    </label>
  );
}

/** 供设置页/测试复用的默认值（避免测试自己手算类型默认值）。 */
export function widgetFieldDefaultValue(field: WidgetSettingField): WidgetSettingValue {
  return defaultWidgetSettingValue(field);
}
