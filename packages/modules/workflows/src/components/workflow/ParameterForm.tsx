/**
 * 参数表单：按节点描述（`NodePropertyDescription[]`）渲染，不做通用表单引擎。
 *
 * 为什么坚持「描述驱动」：节点的参数是节点作者定义的——加一个参数只改
 * 节点自己的 description，UI 不用跟着改，也不会出现「描述里有、界面没有」。
 * 这里只负责把 10 种控件类型映射成原生控件 + 中文标签 + 必填/错误提示，
 * 外加 displayOptions 的显示条件。
 *
 * 所有字符串类字段（string/multiline/json/code/dateTime）都过表达式输入组件：
 * 工作流的价值一半在「把上一步的字段填到下一步」，不支持 `{{ }}` 等于让用户
 * 手动复制粘贴。
 */

import { useMemo } from "react";
import { getNodeType } from "../../lib/workflow/registry";
import type {
  NodePropertyDescription,
  NodePropertyOption,
  WorkflowNode,
} from "../../lib/workflow/types";
import { Switch } from "@heming/sdk";
import { ExpressionInput } from "./ExpressionInput";

export interface ParameterFormProps {
  node: WorkflowNode;
  /** 当前参数（草稿态；父组件持有，避免表单自己造一份状态导致撤销/保存不同步）。 */
  parameters: Record<string, unknown>;
  onChange: (parameters: Record<string, unknown>) => void;
  disabled?: boolean;
  /** 外部错误（键是参数名）；目前主要是必填缺失。 */
  errors?: Record<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** displayOptions.show 是否满足：每个条件字段的当前值落在允许集合里。 */
export function isPropertyVisible(
  property: NodePropertyDescription,
  parameters: Record<string, unknown>,
): boolean {
  const show = property.displayOptions?.show;
  if (!show) return true;
  for (const [key, allowed] of Object.entries(show)) {
    const current = parameters[key];
    if (!allowed.some((candidate) => String(candidate) === String(current))) return false;
  }
  return true;
}

/** 必填校验（供面板/编辑器展示与运行前提示共用）。 */
export function parameterErrors(node: WorkflowNode): Record<string, string> {
  const description = getNodeType(node.type)?.description;
  if (!description) return {};
  const errors: Record<string, string> = {};
  for (const property of description.properties) {
    if (!property.required) continue;
    if (!isPropertyVisible(property, node.parameters ?? {})) continue;
    const value = node.parameters?.[property.name];
    if (value === undefined || value === null || value === "") {
      errors[property.name] = `请填写${property.displayName}`;
    }
  }
  return errors;
}

/** JSON 字段校验：空值合法；含表达式时不解析（表达式在运行时才知道结果）。 */
export function validateJsonField(value: string, allowExpression: boolean): string | undefined {
  if (!value.trim()) return undefined;
  if (allowExpression && value.includes("{{")) return undefined;
  try {
    JSON.parse(value);
    return undefined;
  } catch {
    return "JSON 格式有误，请检查括号、引号与逗号";
  }
}

function optionValue(option: NodePropertyOption): string {
  return String(option.value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

function fieldId(node: WorkflowNode, name: string): string {
  return `wf-param-${node.id}-${name}`;
}

export function ParameterForm({ node, parameters, onChange, disabled = false, errors = {} }: ParameterFormProps) {
  const description = getNodeType(node.type)?.description;
  const properties = useMemo(() => description?.properties ?? [], [description]);

  if (!description) {
    return (
      <p className="ui-alert ui-alert-muted">
        未知节点类型「{node.type}」，无法编辑参数（可能是从别的版本导入的）。
      </p>
    );
  }

  function update(name: string, value: unknown): void {
    const next = { ...parameters };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      {properties.length === 0 ? <p className="ui-caption">这个节点没有可调参数。</p> : null}
      {properties
        .filter((property) => isPropertyVisible(property, parameters))
        .map((property) => {
          const value = parameters[property.name];
          const error = errors[property.name];
          const id = fieldId(node, property.name);
          switch (property.type) {
            case "notice":
              return (
                <div
                  key={property.name}
                  className="rounded-lg border border-line-soft bg-[color:var(--panel)] px-3 py-2"
                >
                  <p className="text-[12px] font-medium">{property.displayName}</p>
                  {property.description ? <p className="ui-caption mt-0.5">{property.description}</p> : null}
                </div>
              );

            case "boolean":
              return (
                <div key={property.name} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="ui-caption block font-medium text-ink">{property.displayName}</span>
                    {property.description ? (
                      <span className="ui-caption block">{property.description}</span>
                    ) : null}
                  </div>
                  <Switch
                    label={property.displayName}
                    checked={value === true}
                    disabled={disabled}
                    onChange={(next) => update(property.name, next)}
                  />
                </div>
              );

            case "number": {
              const numberValue =
                typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
              return (
                <div key={property.name}>
                  <label htmlFor={id} className="ui-caption mb-1 block font-medium text-ink">
                    {property.displayName}
                    {property.required ? (
                      <span className="ml-0.5 text-[#b42318]" aria-hidden="true">
                        *
                      </span>
                    ) : null}
                  </label>
                  <input
                    id={id}
                    type="number"
                    value={numberValue}
                    placeholder={property.placeholder}
                    disabled={disabled}
                    onChange={(event) => {
                      const raw = event.target.value;
                      if (raw === "") {
                        update(property.name, undefined);
                        return;
                      }
                      const parsed = Number(raw);
                      update(property.name, Number.isFinite(parsed) ? parsed : raw);
                    }}
                    className="ui-input w-full"
                  />
                  {property.description ? (
                    <p className="ui-caption mt-1">{property.description}</p>
                  ) : null}
                  {error ? (
                    <p role="alert" className="mt-1 ui-body-sm text-[#b42318]">
                      {error}
                    </p>
                  ) : null}
                </div>
              );
            }

            case "options": {
              const options = property.options ?? [];
              return (
                <div key={property.name}>
                  <label htmlFor={id} className="ui-caption mb-1 block font-medium text-ink">
                    {property.displayName}
                    {property.required ? (
                      <span className="ml-0.5 text-[#b42318]" aria-hidden="true">
                        *
                      </span>
                    ) : null}
                  </label>
                  <select
                    id={id}
                    value={value === undefined || value === null ? "" : String(value)}
                    disabled={disabled}
                    onChange={(event) => {
                      const selected = options.find(
                        (option) => optionValue(option) === event.target.value,
                      );
                      update(property.name, selected ? selected.value : event.target.value);
                    }}
                    className="ui-input w-full"
                  >
                    <option value="">请选择</option>
                    {options.map((option) => (
                      <option key={optionValue(option)} value={optionValue(option)}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  {property.description ? (
                    <p className="ui-caption mt-1">{property.description}</p>
                  ) : null}
                  {error ? (
                    <p role="alert" className="mt-1 ui-body-sm text-[#b42318]">
                      {error}
                    </p>
                  ) : null}
                </div>
              );
            }

            case "multiOptions": {
              const selected = new Set(asStringArray(value));
              const options = property.options ?? [];
              return (
                <fieldset key={property.name}>
                  <legend className="ui-caption mb-1 font-medium text-ink">
                    {property.displayName}
                  </legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {options.map((option) => {
                      const key = optionValue(option);
                      return (
                        <label key={key} className="flex items-center gap-1.5 text-[12px]">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            disabled={disabled}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(key);
                              else next.delete(key);
                              update(
                                property.name,
                                options.filter((entry) => next.has(optionValue(entry))).map((entry) => entry.value),
                              );
                            }}
                          />
                          <span>{option.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  {property.description ? (
                    <p className="ui-caption mt-1">{property.description}</p>
                  ) : null}
                </fieldset>
              );
            }

            case "json": {
              const text = typeof value === "string" ? value : isPlainObject(value) ? JSON.stringify(value, null, 2) : "";
              const jsonError = validateJsonField(text, true) ?? error;
              return (
                <ExpressionInput
                  key={property.name}
                  id={id}
                  label={property.displayName}
                  required={property.required}
                  value={text}
                  multiline
                  rows={property.rows ?? 4}
                  placeholder={property.placeholder ?? '{ "字段": "值" }'}
                  disabled={disabled}
                  hint={property.description}
                  error={jsonError}
                  onChange={(next) => update(property.name, next)}
                />
              );
            }

            case "code": {
              const text = typeof value === "string" ? value : "";
              return (
                <ExpressionInput
                  key={property.name}
                  id={id}
                  label={property.displayName}
                  required={property.required}
                  value={text}
                  multiline
                  rows={property.rows ?? 8}
                  placeholder={property.placeholder ?? "// 在这里写 JavaScript"}
                  disabled={disabled}
                  hint={property.description}
                  error={error}
                  onChange={(next) => update(property.name, next)}
                />
              );
            }

            case "dateTime": {
              const text = typeof value === "string" ? value : "";
              return (
                <div key={property.name}>
                  <label htmlFor={id} className="ui-caption mb-1 block font-medium text-ink">
                    {property.displayName}
                  </label>
                  <input
                    id={id}
                    type="datetime-local"
                    value={text}
                    disabled={disabled}
                    onChange={(event) => update(property.name, event.target.value)}
                    className="ui-input w-full"
                  />
                  {property.description ? (
                    <p className="ui-caption mt-1">{property.description}</p>
                  ) : null}
                </div>
              );
            }

            case "multiline":
            case "string":
            default: {
              const text =
                typeof value === "string"
                  ? value
                  : value === undefined || value === null
                    ? ""
                    : String(value);
              return (
                <ExpressionInput
                  key={property.name}
                  id={id}
                  label={property.displayName}
                  required={property.required}
                  value={text}
                  multiline={property.type === "multiline"}
                  rows={property.rows ?? 3}
                  placeholder={property.placeholder}
                  disabled={disabled}
                  hint={property.description}
                  error={error}
                  onChange={(next) => update(property.name, next)}
                />
              );
            }
          }
        })}
    </div>
  );
}
