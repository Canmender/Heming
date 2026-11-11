/**
 * XML 节点：XML 与 JSON 互转。
 *
 * 转换规则（与常见 XML→JSON 约定一致，够用且可预期）：
 * - 元素 → 对象；属性写成 `@属性名`；纯文本元素改成字符串；
 * - 同名兄弟元素 → 数组；
 * - 根元素直接作为结果的唯一键（`<root><a/></root>` → `{ root: { a: "" } }`）。
 *
 * 为什么用 DOMParser 而不是正则：XML 的实体、命名空间、CDATA 用正则处理迟早出错；
 * 浏览器与 jsdom 都有 DOMParser/XMLSerializer，不需要新依赖。
 */

import type { INodeType } from "../../types";
import { inputItems, readString, withField } from "./helpers";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function elementToJson(element: Element): unknown {
  const children = [...element.children];
  const attributes: Record<string, string> = {};
  for (const attr of [...element.attributes]) {
    attributes[`@${attr.name}`] = attr.value;
  }
  const text = (element.textContent ?? "").trim();

  if (children.length === 0) {
    if (Object.keys(attributes).length === 0) return text;
    return Object.keys(attributes).length > 0 && text
      ? { ...attributes, "#text": text }
      : { ...attributes, ...(text ? { "#text": text } : {}) };
  }

  const result: Record<string, unknown> = { ...attributes };
  for (const child of children) {
    const name = child.tagName;
    const value = elementToJson(child);
    if (result[name] === undefined) {
      result[name] = value;
    } else if (Array.isArray(result[name])) {
      (result[name] as unknown[]).push(value);
    } else {
      result[name] = [result[name], value];
    }
  }
  return result;
}

function jsonToXml(value: unknown, name: string): string {
  if (value === null || value === undefined) return `<${name}/>`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `<${name}>${escapeXml(String(value))}</${name}>`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonToXml(entry, name)).join("");
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    let attributes = "";
    let inner = "";
    for (const [key, entry] of Object.entries(object)) {
      if (key.startsWith("@")) {
        attributes += ` ${key.slice(1)}="${escapeXml(String(entry))}"`;
      } else if (key === "#text") {
        inner += escapeXml(String(entry));
      } else {
        inner += jsonToXml(entry, key);
      }
    }
    return `<${name}${attributes}>${inner}</${name}>`;
  }
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

export const xmlNode: INodeType = {
  description: {
    type: "xml",
    displayName: "XML",
    group: "transform",
    description: "把 XML 解析成 JSON，或把 JSON 生成 XML。",
    icon: "code",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "operation",
        displayName: "操作",
        type: "options",
        default: "parse",
        options: [
          { name: "XML 解析成 JSON", value: "parse" },
          { name: "JSON 生成 XML", value: "build" },
        ],
      },
      {
        name: "xml",
        displayName: "XML 内容",
        type: "multiline",
        default: "",
        description: "留空则用输入数据的 xml 字段（或第一条数据的 json.xml）。",
        displayOptions: { show: { operation: ["parse"] } },
      },
      {
        name: "rootName",
        displayName: "根元素名",
        type: "string",
        default: "root",
        description: "生成 XML 时的根元素名。",
        displayOptions: { show: { operation: ["build"] } },
      },
      {
        name: "outputField",
        displayName: "结果字段",
        type: "string",
        default: "xml",
        description: "把结果写到每条数据的哪个字段。",
      },
    ],
  },

  async execute(context) {
    const operation = readString(context, "operation", "parse");
    const outputField = readString(context, "outputField", "xml") || "xml";
    const items = inputItems(context);

    if (operation === "parse") {
      const raw =
        readString(context, "xml", "") ||
        (typeof items[0]?.json?.xml === "string" ? (items[0].json.xml as string) : "");
      if (!raw.trim()) throw new Error("没有可解析的 XML 内容");
      const parser = new DOMParser();
      const doc = parser.parseFromString(raw, "application/xml");
      const error = doc.querySelector("parsererror");
      if (error) throw new Error(`XML 解析失败：${(error.textContent ?? "").trim().slice(0, 200)}`);
      const root = doc.documentElement;
      if (!root) throw new Error("XML 里没有根元素");
      return withField(items, outputField, { [root.tagName]: elementToJson(root) });
    }

    const rootName = readString(context, "rootName", "root") || "root";
    const payload = items[0]?.json ?? {};
    const serializer = new XMLSerializer();
    const wrapper = document.implementation.createDocument(null, rootName, null);
    const parsed = new DOMParser().parseFromString(jsonToXml(payload, rootName), "application/xml");
    const node = parsed.documentElement;
    if (!node) throw new Error("生成 XML 失败");
    const xmlText = serializer.serializeToString(node);
    // wrapper 只为拿到 `document.implementation` 的存在性保证；实际序列化用解析出的节点。
    void wrapper;
    return withField(items, outputField, `<?xml version="1.0" encoding="UTF-8"?>\n${xmlText}`);
  },
};
