/**
 * 设置字段（Set）：给每条输入数据补字段/改字段，是工作流里最常用的「写数据」节点。
 *
 * 两种模式：
 * - manual：逐条列字段名与值（值可以是 `{{ }}` 表达式，引擎已在参数解析阶段求值）；
 * - raw：直接给一段 JSON，整体替换输出（不再沿用输入）。
 *
 * 为什么默认保留其它输入字段：用户多半只是「加一个字段」，若默认丢弃其余字段，
 * 第一次用就会觉得数据「莫名其妙少了一半」；想只保留设置字段时把开关关掉即可。
 * binary 通道不参与字段合并，但也不会被丢掉（附件类数据在 Set 前后应当可继续传递）。
 */

import type { INodeType, Item } from "../../types.js";
import {
  inputItems,
  isPlainObject,
  normalizeToItems,
  parseJsonParameter,
  readBoolean,
  readJsonArray,
  readOption,
  WorkflowNodeError,
} from "./helpers.js";

type SetMode = "manual" | "raw";

const MODES = ["manual", "raw"] as const;

export const setNode: INodeType = {
  description: {
    type: "set",
    displayName: "设置字段",
    group: "transform",
    description: "给每条数据添加或修改字段；也可以直接给一段 JSON 替换输出。",
    icon: "sliders",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "mode",
        displayName: "模式",
        type: "options",
        default: "manual",
        description: "逐条列字段，还是直接写一段 JSON。",
        options: [
          { name: "逐字段设置", value: "manual" },
          { name: "原始 JSON", value: "raw" },
        ],
      },
      {
        name: "fields",
        displayName: "字段列表",
        type: "json",
        default: [{ name: "field", value: "value" }],
        description:
          '形如 [{"name":"字段名","value":"值"}]；值支持 {{ }} 表达式（例如 {{ $json.title }}）。',
        displayOptions: { show: { mode: ["manual"] } },
      },
      {
        name: "includeOtherFields",
        displayName: "保留其它字段",
        type: "boolean",
        default: true,
        description: "关闭后输出只包含上面设置的字段。",
        displayOptions: { show: { mode: ["manual"] } },
      },
      {
        name: "value",
        displayName: "JSON 内容",
        type: "json",
        default: {},
        description: "一个对象输出一条数据；数组输出多条数据。",
        displayOptions: { show: { mode: ["raw"] } },
      },
    ],
  },

  async execute(context) {
    const mode = readOption<SetMode>(context, "mode", MODES, "manual");
    if (mode === "raw") {
      const parsed = parseJsonParameter(context.getNodeParameter<unknown>("value", {}), "JSON 内容");
      if (parsed === undefined || parsed === null) return { main: [[]] };
      return { main: [normalizeToItems(parsed)] };
    }

    const rawFields = readJsonArray(context, "fields", "字段列表");
    const includeOtherFields = readBoolean(context, "includeOtherFields", true);
    const fields: Array<{ name: string; value: unknown }> = [];
    for (const entry of rawFields) {
      if (!isPlainObject(entry)) continue;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name) continue;
      fields.push({ name, value: entry.value });
    }
    if (fields.length === 0) {
      throw new WorkflowNodeError("设置字段节点没有任何有效字段", {
        description: '字段列表里每一项都需要 "name" 字段，例如 {"name":"status","value":"done"}。',
      });
    }

    const buildJson = (base: Record<string, unknown>): Record<string, unknown> => {
      const json: Record<string, unknown> = includeOtherFields ? { ...base } : {};
      for (const field of fields) json[field.name] = field.value;
      return json;
    };

    const items = inputItems(context);
    if (items.length === 0) {
      // 没有输入时也产出一条数据：Set 常被当作「构造初始数据」的起点。
      return { main: [[{ json: buildJson({}) }]] };
    }
    const output: Item[] = items.map((item) => {
      const next: Item = { json: buildJson(item.json) };
      if (item.binary) next.binary = item.binary;
      if (item.pairedItem !== undefined) next.pairedItem = item.pairedItem;
      return next;
    });
    return { main: [output] };
  },
};
