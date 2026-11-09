/**
 * XML 节点（Node 版）：XML ↔ JSON。
 *
 * Node 没有 DOMParser/XMLSerializer，这里用一个**够用的手写解析器**：
 * 元素、属性、文本、自闭合、注释、CDATA、常见实体；不处理命名空间前缀语义
 * （`ns:tag` 原样当元素名），也不做 DTD 展开——这个节点的定位是「转换常见配置/接口数据」，
 * 不是完整的 XML 工具链。
 *
 * 转换规则：
 * - 元素 → 对象；属性写成 `@属性名`；纯文本元素变成字符串；
 * - 同名兄弟元素 → 数组；
 * - 根元素作为结果的唯一键（`<root><a/></root>` → `{ root: { a: "" } }`）。
 */

import type { INodeType } from "../../types.js";
import { inputItems, readString, withField } from "./helpers.js";

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** XML 实体 → 字符（未知实体原样保留，避免把用户数据吃掉）。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 解析属性串（`a="1" b='2'`）；属性值里的 `>` 已在切标签时处理掉，不存在截断问题。 */
function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    attributes[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/** 从 `open` 位置找下一个 `>`（跳过引号里的 `>`）。 */
function findTagEnd(input: string, open: number): number {
  let quote = "";
  for (let index = open + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

/** 解析 XML 文本，返回根元素；格式错误抛中文错误。 */
export function parseXml(input: string): XmlElement {
  const source = String(input ?? "");
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let position = 0;

  const appendText = (raw: string) => {
    const text = decodeEntities(raw).trim();
    if (!text) return;
    const current = stack[stack.length - 1];
    if (!current) {
      throw new Error("XML 文本不在任何元素内");
    }
    current.text += text;
  };

  while (position < source.length) {
    const lt = source.indexOf("<", position);
    if (lt < 0) {
      appendText(source.slice(position));
      break;
    }
    if (lt > position) appendText(source.slice(position, lt));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end < 0) throw new Error("XML 注释没有闭合");
      position = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end < 0) throw new Error("XML CDATA 没有闭合");
      const current = stack[stack.length - 1];
      if (!current) throw new Error("XML CDATA 不在任何元素内");
      current.text += source.slice(lt + 9, end);
      position = end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end < 0) throw new Error("XML 处理指令没有闭合");
      position = end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      // DOCTYPE 之类：跳到对应的 '>'（方括号内部可能有 '>'，按深度跳过）
      let depth = 0;
      let index = lt + 2;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === "[") depth += 1;
        else if (char === "]") depth = Math.max(0, depth - 1);
        else if (char === ">" && depth === 0) break;
      }
      if (index >= source.length) throw new Error("XML 声明没有闭合");
      position = index + 1;
      continue;
    }

    const tagEnd = findTagEnd(source, lt);
    if (tagEnd < 0) throw new Error("XML 标签没有闭合");
    const inner = source.slice(lt + 1, tagEnd).trim();
    position = tagEnd + 1;

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw new Error(`XML 结束标签不匹配：</${name}>`);
      }
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error("XML 标签缺少元素名");
    const element: XmlElement = {
      name: nameMatch[1],
      attributes: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    if (stack.length > 0) stack[stack.length - 1].children.push(element);
    else if (!root) root = element;
    else throw new Error("XML 只能有一个根元素");
    if (!selfClosing) stack.push(element);
  }

  if (stack.length > 0) throw new Error(`XML 有未闭合的标签：<${stack[stack.length - 1].name}>`);
  if (!root) throw new Error("XML 里没有根元素");
  return root;
}

/** 元素 → JSON（属性 @name、文本 #text、同名子元素聚合成数组）。 */
function elementToJson(element: XmlElement): unknown {
  const attributes: Record<string, string> = { ...element.attributes };
  const text = element.text.trim();
  if (element.children.length === 0) {
    if (Object.keys(attributes).length === 0) return text;
    return text ? { ...attributes, "#text": text } : attributes;
  }
  const result: Record<string, unknown> = { ...attributes };
  for (const child of element.children) {
    const value = elementToJson(child);
    const existing = result[child.name];
    if (existing === undefined) result[child.name] = value;
    else if (Array.isArray(existing)) (existing as unknown[]).push(value);
    else result[child.name] = [existing, value];
  }
  if (text) result["#text"] = text;
  return result;
}

/** JSON → XML 字符串（`@attr` 当属性、`#text` 当文本）。 */
function jsonToXml(value: unknown, name: string): string {
  if (value === null || value === undefined) return `<${name}/>`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `<${name}>${escapeXml(String(value))}</${name}>`;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonToXml(entry, name)).join("");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    let attributes = "";
    let inner = "";
    for (const [key, entry] of Object.entries(object)) {
      if (key.startsWith("@")) attributes += ` ${key.slice(1)}="${escapeXml(String(entry))}"`;
      else if (key === "#text") inner += escapeXml(String(entry));
      else inner += jsonToXml(entry, key);
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
        description: "留空则用输入数据的 xml 字段。",
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
      const root = parseXml(raw);
      return withField(items, outputField, { [root.name]: elementToJson(root) });
    }

    const rootName = readString(context, "rootName", "root") || "root";
    const firstJson = items[0]?.json;
    const payload: Record<string, unknown> =
      firstJson && typeof firstJson === "object" && !Array.isArray(firstJson)
        ? (firstJson as Record<string, unknown>)
        : {};
    const xmlText = jsonToXml(payload, rootName);
    return withField(items, outputField, `<?xml version="1.0" encoding="UTF-8"?>\n${xmlText}`);
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
