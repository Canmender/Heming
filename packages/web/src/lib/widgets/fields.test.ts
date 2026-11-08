import { describe, expect, it } from "vitest";
import type { WidgetSettingField } from "../../types/widgets.js";
import {
  coerceWidgetSettingValue,
  defaultWidgetSettingValue,
  widgetHasSettingsForm,
  widgetSettingOptions,
  widgetSettingValue,
} from "./fields.js";

/**
 * 通用设置表单的取值口径（d.98）：
 * - 缺省值按类型给（boolean→false / number→0 / select→首项 / text→"" / agent→null）；
 * - settings 里的坏值逐字段回落默认（一个字段坏掉不清空整张表）；
 * - 写回前做类型级校验（select 必须在选项里、number 必须有限、text ≤500）。
 */

const booleanField: WidgetSettingField = { key: "on", type: "boolean", label: "开关" };
const numberField: WidgetSettingField = { key: "n", type: "number", label: "数字", default: 2 };
const textField: WidgetSettingField = { key: "t", type: "text", label: "文本", default: "abc" };
const agentField: WidgetSettingField = { key: "a", type: "agent", label: "智能体" };
const selectField: WidgetSettingField = {
  key: "s",
  type: "select",
  label: "选择",
  default: "normal",
  options: [
    { value: "quiet", label: "安静" },
    { value: "normal", label: "正常" },
  ],
};

describe("defaultWidgetSettingValue", () => {
  it("按类型给缺省值", () => {
    expect(defaultWidgetSettingValue(booleanField)).toBe(false);
    expect(defaultWidgetSettingValue(numberField)).toBe(2);
    expect(defaultWidgetSettingValue(textField)).toBe("abc");
    expect(defaultWidgetSettingValue(agentField)).toBeNull();
    expect(defaultWidgetSettingValue(selectField)).toBe("normal");
  });

  it("清单 default 类型不符时回落类型缺省值", () => {
    expect(defaultWidgetSettingValue({ ...booleanField, default: "yes" })).toBe(false);
    expect(defaultWidgetSettingValue({ ...numberField, default: "2" })).toBe(0);
    expect(defaultWidgetSettingValue({ ...textField, default: 1 })).toBe("");
    expect(defaultWidgetSettingValue({ ...agentField, default: 42 })).toBeNull();
  });
});

describe("widgetSettingValue", () => {
  it("settings 里的值优先于清单默认值", () => {
    expect(widgetSettingValue(booleanField, { on: true })).toBe(true);
    expect(widgetSettingValue(numberField, { n: 8 })).toBe(8);
    expect(widgetSettingValue(textField, { t: "改过" })).toBe("改过");
    expect(widgetSettingValue(selectField, { s: "quiet" })).toBe("quiet");
  });

  it("坏值/未知选项逐字段回落默认，不抛", () => {
    expect(widgetSettingValue(booleanField, { on: "yes" })).toBe(false);
    expect(widgetSettingValue(numberField, { n: Number.NaN })).toBe(2);
    expect(widgetSettingValue(selectField, { s: "不存在" })).toBe("normal");
    expect(widgetSettingValue(textField, { t: 1 })).toBe("abc");
    expect(widgetSettingValue(agentField, { a: 42 })).toBeNull();
  });
});

describe("coerceWidgetSettingValue", () => {
  it("合法值原样通过", () => {
    expect(coerceWidgetSettingValue(booleanField, true)).toEqual({ ok: true, value: true });
    expect(coerceWidgetSettingValue(numberField, 3.5)).toEqual({ ok: true, value: 3.5 });
    expect(coerceWidgetSettingValue(textField, "  x  ")).toEqual({ ok: true, value: "  x  " });
    expect(coerceWidgetSettingValue(selectField, "quiet")).toEqual({ ok: true, value: "quiet" });
    expect(coerceWidgetSettingValue(agentField, " agent-1 ")).toEqual({ ok: true, value: "agent-1" });
    expect(coerceWidgetSettingValue(agentField, null)).toEqual({ ok: true, value: null });
  });

  it("类型不符给中文错误（界面直接展示）", () => {
    expect(coerceWidgetSettingValue(booleanField, "true").ok).toBe(false);
    expect(coerceWidgetSettingValue(numberField, "3").ok).toBe(false);
    expect(coerceWidgetSettingValue(numberField, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(coerceWidgetSettingValue(selectField, "bogus").ok).toBe(false);
    expect(coerceWidgetSettingValue(textField, 1).ok).toBe(false);
    expect(coerceWidgetSettingValue(textField, "x".repeat(501))).toMatchObject({
      ok: false,
      error: "最多 500 字",
    });
    expect(coerceWidgetSettingValue(agentField, 42).ok).toBe(false);
  });
});

describe("小工具", () => {
  it("widgetHasSettingsForm / widgetSettingOptions", () => {
    expect(widgetHasSettingsForm(undefined)).toBe(false);
    expect(widgetHasSettingsForm([])).toBe(false);
    expect(widgetHasSettingsForm([booleanField])).toBe(true);
    expect(widgetSettingOptions(selectField)).toHaveLength(2);
    expect(widgetSettingOptions(booleanField)).toEqual([]);
  });
});
