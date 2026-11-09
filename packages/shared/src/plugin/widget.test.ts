import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WIDGET_API_GLOBAL, WIDGET_API_METHODS } from "./widget.js";

/**
 * 界面插件桥的一致性测试（类型 ↔ preload）。
 *
 * 类型文件 `widget.ts` 是给人用的，真正的边界在 `packages/desktop/widget-preload.js`：
 * 宿主给插件窗口挂了哪些方法，只有 preload 说了算。这个测试直接读 preload 源码，
 * 按结构解析 `contextBridge.exposeInMainWorld("__heming_widget", { ... })` 里的
 * 顶层方法名，与 `WIDGET_API_METHODS` 做集合比对——preload 加了方法而类型没跟上
 * （或反过来删了方法）都会红，避免「文档/类型是旧的，插件调了不存在的方法」。
 *
 * 为什么不 `require` preload：它依赖 electron 的 `contextBridge` / `ipcRenderer`，
 * 纯 Node 里跑不起来；这里只做源码解析，不执行宿主代码。
 */

const PRELOAD_SOURCE_PATH = fileURLToPath(new URL("../../../desktop/widget-preload.js", import.meta.url));
const WIDGET_TYPES_PATH = fileURLToPath(new URL("./widget.ts", import.meta.url));

/** 去掉 JS 注释（保留字符串与换行），避免注释里的大括号/冒号干扰结构解析。 */
function stripComments(source: string): string {
  let out = "";
  let quote: '"' | "'" | "`" | null = null;
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (quote) {
      if (char === "\\") {
        out += char;
        if (next !== undefined) out += next;
        i += 2;
        continue;
      }
      out += char;
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      out += "  ";
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      i += 2;
      out += "  ";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

interface Member {
  name: string;
  kind: "property" | "method";
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function readIdentifier(code: string, start: number): string {
  const head = code[start] ?? "";
  if (!/^[A-Za-z_$]$/.test(head)) return "";
  let end = start + 1;
  while (end < code.length && /^[A-Za-z0-9_$]$/.test(code[end]!)) end += 1;
  return code.slice(start, end);
}

function skipSpaces(code: string, start: number): number {
  let i = start;
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  return i;
}

function skipString(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    if (code[i] === "\\") {
      i += 2;
      continue;
    }
    if (code[i] === quote) return i + 1;
    i += 1;
  }
  return code.length;
}

/**
 * 判断名字后面是不是一个方法签名：`name(`，或泛型方法 `name<T = unknown>(`。
 *
 * TS 接口允许方法带类型参数（`dataGet<T = unknown>(key)`），只看紧邻的 `(` 会漏掉它。
 */
function isMethodSignature(code: string, start: number): boolean {
  let i = start;
  if (code[i] === "<") {
    let depth = 0;
    while (i < code.length) {
      const char = code[i];
      if (char === "<") {
        depth += 1;
      } else if (char === ">") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      } else if (char === "{" || char === "}") {
        // 泛型参数里出现花括号说明不是方法签名（解析保守放弃）
        return false;
      }
      i += 1;
    }
    i = skipSpaces(code, i);
  }
  return code[i] === "(";
}

/**
 * 扫描 `openBrace` 指向的对象/接口字面量的**一层成员**。
 *
 * 只认 `{` 深度 1、且前一个有效字符是 `{` / `,` / `;` 的名字：
 * - 后面跟 `:` → 对象字面量的属性（preload 的方法都是 `name: (...) =>`）；
 * - 后面跟 `(` → 接口的方法签名（`state(): Promise<...>`）。
 * 深度 ≥2 的嵌套对象字面量（如 `{ dir: 1 }`）不会混进来。
 */
function scanMembers(code: string, openBrace: number): Member[] {
  const members: Member[] = [];
  let depth = 0;
  let previous = "";
  let i = openBrace;
  while (i < code.length) {
    const char = code[i]!;
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(code, i);
      previous = "string";
      continue;
    }
    if (char === "{") {
      depth += 1;
      previous = "{";
      i += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return members;
      previous = "}";
      continue;
    }
    if (depth === 1 && (previous === "{" || previous === "," || previous === ";")) {
      const name = readIdentifier(code, i);
      if (name) {
        const after = skipSpaces(code, i + name.length);
        const charAfter = code[after] ?? "";
        const kind: Member["kind"] | "" =
          charAfter === ":"
            ? "property"
            : charAfter === "(" || charAfter === "<"
              ? isMethodSignature(code, after)
                ? "method"
                : ""
              : "";
        if (kind) {
          members.push({ name, kind });
          previous = kind === "method" ? "(" : ":";
          i = after;
          continue;
        }
      }
    }
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return members;
}

function readSource(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/** 解析 `contextBridge.exposeInMainWorld(<name>, { ... })`：返回全局名与对象字面量起点。 */
function findExposedObject(code: string): { globalName: string; openBrace: number } {
  const match = /exposeInMainWorld\(\s*(["'`])([^"'`]+)\1\s*,/.exec(code);
  if (!match) throw new Error("widget-preload.js 里找不到 contextBridge.exposeInMainWorld(...) 调用");
  const openBrace = code.indexOf("{", match.index + match[0].length);
  if (openBrace < 0) throw new Error("exposeInMainWorld 的第二个参数不是对象字面量");
  return { globalName: match[2]!, openBrace };
}

/** 解析 `widget.ts` 里 `HemingWidgetApi` 接口的方法名。 */
function readInterfaceMethods(code: string): string[] {
  const match = /export interface HemingWidgetApi\s*\{/.exec(code);
  if (!match) throw new Error("widget.ts 里找不到 export interface HemingWidgetApi");
  const openBrace = code.indexOf("{", match.index);
  return scanMembers(code, openBrace)
    .filter((member) => member.kind === "method")
    .map((member) => member.name);
}

/** 解析 preload 暴露的顶层方法名（保持源码顺序）。 */
function readPreloadMethods(code: string): { globalName: string; methods: string[] } {
  const exposed = findExposedObject(code);
  const methods = scanMembers(code, exposed.openBrace)
    .filter((member) => member.kind === "property")
    .map((member) => member.name);
  return { globalName: exposed.globalName, methods };
}

const preloadCode = readSource(PRELOAD_SOURCE_PATH);
const apiCode = readSource(WIDGET_TYPES_PATH);

describe("界面插件桥：preload 与类型清单一致", () => {
  it("preload 暴露的全局名与 WIDGET_API_GLOBAL 一致", () => {
    const { globalName } = readPreloadMethods(preloadCode);
    expect(globalName).toBe(WIDGET_API_GLOBAL);
  });

  it("preload 的顶层方法集合与 WIDGET_API_METHODS 完全一致（多一个/少一个都红）", () => {
    const { methods } = readPreloadMethods(preloadCode);
    // preload 自身不应出现重复方法名（重复会在对象字面量里覆盖前者，静默丢方法）
    expect(methods.length).toBe(new Set(methods).size);
    expect([...methods].sort()).toEqual([...WIDGET_API_METHODS].sort());
  });

  it("WIDGET_API_METHODS 无重复、无空名，且都是合法标识符", () => {
    expect(WIDGET_API_METHODS.length).toBeGreaterThan(0);
    expect(WIDGET_API_METHODS.length).toBe(new Set(WIDGET_API_METHODS).size);
    for (const name of WIDGET_API_METHODS) {
      expect(name.trim(), `方法名不能为空：${JSON.stringify(name)}`).not.toBe("");
      expect(name, `不是合法方法名：${JSON.stringify(name)}`).toMatch(IDENTIFIER);
    }
  });

  it("HemingWidgetApi 的方法集合与 WIDGET_API_METHODS 一致，且接口里没有重复方法名", () => {
    const interfaceMethods = readInterfaceMethods(apiCode);
    // 类型是可编译的红线：重复方法名会让 tsc 直接报错；这里再钉一次，防止有人注释掉签名
    expect(interfaceMethods.length).toBe(new Set(interfaceMethods).size);
    for (const name of interfaceMethods) {
      expect(name.trim(), `接口方法名不能为空：${JSON.stringify(name)}`).not.toBe("");
    }
    expect([...interfaceMethods].sort()).toEqual([...WIDGET_API_METHODS].sort());
  });
});
