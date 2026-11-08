import type { WidgetSettingField, WidgetSettingOption } from "../../types/widgets.js";

/**
 * 清单 `settings.fields` 的通用表单取值/校验（d.98 · 规格 §2.3）。
 *
 * 值由**主进程**持有：这里只负责「按字段类型把 settings 里的值规成表单能用的形状」，
 * 以及「用户改了之后该写什么回 patch」。字段类型本轮固定 5 种：
 * `boolean` / `select` / `text` / `number` / `agent`。
 *
 * ★ 为什么坏值要逐字段回落默认而不是整份清空：设置是用户自己改过的（也可能老版本写坏的），
 *   一个字段坏掉不该把整张表单恢复成初始值。这与 `loginForm`/`petPrefs` 的既有口径一致。
 */

/** 表单里一个设置字段的合法值。 */
export type WidgetSettingValue = boolean | number | string | null;

/** 字段类型的缺省值（清单没给 `default` 时表单显示它）。 */
export function defaultWidgetSettingValue(field: WidgetSettingField): WidgetSettingValue {
  const raw = field.default;
  switch (field.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : false;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    case "select":
      return typeof raw === "string" ? raw : (field.options?.[0]?.value ?? "");
    case "agent":
      return typeof raw === "string" && raw.trim() ? raw.trim() : null;
    case "text":
    default:
      return typeof raw === "string" ? raw : "";
  }
}

/** 从 settings 读出某字段的当前值；类型不符时回落默认值（不把坏值灌进表单）。 */
export function widgetSettingValue(
  field: WidgetSettingField,
  settings: Record<string, unknown>,
): WidgetSettingValue {
  const raw = settings[field.key];
  if (raw === undefined) return defaultWidgetSettingValue(field);
  switch (field.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : defaultWidgetSettingValue(field);
    case "number":
      return typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : defaultWidgetSettingValue(field);
    case "select":
      return typeof raw === "string" && isSelectValue(field, raw)
        ? raw
        : defaultWidgetSettingValue(field);
    case "agent":
      return typeof raw === "string" && raw.trim()
        ? raw.trim()
        : typeof raw === "string"
          ? null
          : defaultWidgetSettingValue(field);
    case "text":
    default:
      return typeof raw === "string" ? raw : defaultWidgetSettingValue(field);
  }
}

function isSelectValue(field: WidgetSettingField, value: string): boolean {
  return (field.options ?? []).some((option) => option.value === value);
}

export type WidgetSettingCoerceResult =
  | { ok: true; value: WidgetSettingValue }
  | { ok: false; error: string };

/**
 * 把界面上的输入规成可写回主进程的值。
 *
 * 只做类型级校验：`select` 必须在选项里、`number` 必须有限、`text` 限长 500
 * （设置不是文本框，超长值对 widget 也没意义）。业务级校验（如模型路径合法性）留在插件自己。
 */
export function coerceWidgetSettingValue(
  field: WidgetSettingField,
  raw: unknown,
): WidgetSettingCoerceResult {
  switch (field.type) {
    case "boolean":
      return typeof raw === "boolean"
        ? { ok: true, value: raw }
        : { ok: false, error: "值必须是布尔" };
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, error: "请输入数字" };
      }
      return { ok: true, value: raw };
    }
    case "select": {
      if (typeof raw !== "string" || !isSelectValue(field, raw)) {
        return { ok: false, error: "请选择一个有效选项" };
      }
      return { ok: true, value: raw };
    }
    case "agent": {
      if (raw === null || raw === "") return { ok: true, value: null };
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: "请选择智能体" };
      }
      return { ok: true, value: raw.trim() };
    }
    case "text":
    default: {
      if (typeof raw !== "string") return { ok: false, error: "请输入文本" };
      if (raw.length > 500) return { ok: false, error: "最多 500 字" };
      return { ok: true, value: raw };
    }
  }
}

/** `select` 的选项（清单已校验；缺失时给空数组避免界面崩）。 */
export function widgetSettingOptions(field: WidgetSettingField): WidgetSettingOption[] {
  return field.options ?? [];
}

/**
 * 设置表单是否值得渲染：没有 `settings.fields` 的 widget 只显示宿主动作。
 */
export function widgetHasSettingsForm(fields: WidgetSettingField[] | undefined): boolean {
  return Array.isArray(fields) && fields.length > 0;
}
