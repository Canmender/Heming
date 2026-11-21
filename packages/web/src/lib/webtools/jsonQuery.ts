/**
 * JSON 查询工具（内置只读工具 `json_query`，d.150.4.95.11）。
 *
 * 模型常需要从用户粘贴的 JSON / 接口返回里取一个字段，直接整段塞回上下文又贵又容易看错行。
 * 这里支持很小的路径语法：`a.b[0].c`、`$["key with space"]`，只读不写，坏输入一律中文报错。
 */

export type JsonQueryOutcome = { ok: true; text: string } | { ok: false; error: string };

const MAX_OUTPUT_CHARS = 4_000;

type PathStep = { kind: "key"; key: string } | { kind: "index"; index: number };

/** 解析 `a.b[0]["k"]` 这类路径；失败返回中文原因。 */
export function parseJsonPath(raw: string): { ok: true; steps: PathStep[] } | { ok: false; error: string } {
  const path = String(raw ?? "").trim();
  if (!path || path === "$" || path === ".") return { ok: true, steps: [] };
  const steps: PathStep[] = [];
  let index = 0;
  while (index < path.length) {
    const char = path[index];
    if (char === "$" || char === ".") {
      index += 1;
      continue;
    }
    if (char === "[") {
      const end = path.indexOf("]", index);
      if (end < 0) return { ok: false, error: "路径里的 [ 没有闭合" };
      const inner = path.slice(index + 1, end).trim();
      if (/^\d+$/.test(inner)) {
        steps.push({ kind: "index", index: Number(inner) });
      } else if (/^(['"]).*\1$/.test(inner)) {
        steps.push({ kind: "key", key: inner.slice(1, -1) });
      } else {
        return { ok: false, error: `方括号里只能是数字下标或带引号的键名，收到「${inner}」` };
      }
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end += 1;
    const key = path.slice(index, end).trim();
    if (!key) return { ok: false, error: "路径里有空的字段名（检查多余的 .）" };
    steps.push({ kind: "key", key });
    index = end;
  }
  return { ok: true, steps };
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组（${value.length} 项）`;
  if (typeof value === "object") return `对象（${Object.keys(value as Record<string, unknown>).length} 个键）`;
  return typeof value === "string" ? "字符串" : typeof value;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 从 JSON 文本里按路径取值。
 * `path` 为空/`$` 时返回整个文档（对象只列顶层键，避免一次吐出巨大文本）。
 */
export function queryJson(rawJson: string, rawPath = "$"): JsonQueryOutcome {
  const source = String(rawJson ?? "").trim();
  if (!source) return { ok: false, error: "缺少 JSON 文本" };
  let data: unknown;
  try {
    data = JSON.parse(source) as unknown;
  } catch (error) {
    return { ok: false, error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }

  const parsedPath = parseJsonPath(rawPath);
  if (!parsedPath.ok) return { ok: false, error: parsedPath.error };

  let current: unknown = data;
  for (const step of parsedPath.steps) {
    if (step.kind === "index") {
      if (!Array.isArray(current)) return { ok: false, error: "路径里用了下标，但当前值不是数组" };
      if (step.index >= current.length) {
        return { ok: false, error: `下标越界：${step.index}（数组只有 ${current.length} 项）` };
      }
      current = current[step.index];
      continue;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return { ok: false, error: `路径里的「${step.key}」取不到：当前值不是对象` };
    }
    const record = current as Record<string, unknown>;
    // 只认自有字段：`in` 会沿原型链命中 Object.prototype（toString/constructor/
    // __proto__/valueOf…），把「没有这个字段」误报成查到了一个函数，给模型假答案。
    // JSON.parse 产出的对象继承 Object.prototype，所以这里必须用 hasOwnProperty。
    if (!Object.prototype.hasOwnProperty.call(record, step.key)) {
      const keys = Object.keys(record).slice(0, 20);
      return {
        ok: false,
        error: `没有字段「${step.key}」。可用字段：${keys.length ? keys.join("、") : "（空对象）"}`,
      };
    }
    current = record[step.key];
  }

  if (parsedPath.steps.length === 0) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).slice(0, 40);
      return {
        ok: true,
        text: `顶层是对象，共 ${Object.keys(record).length} 个键：${keys.join("、")}` +
          `${Object.keys(record).length > keys.length ? " …" : ""}\n用 a.b[0].c 这样的路径取具体值。`,
      };
    }
    if (Array.isArray(current) && current.length > 5) {
      return { ok: true, text: `顶层是数组，共 ${current.length} 项；用 [0]、a[1].b 取具体项。` };
    }
  }

  const output = stringify(current);
  const truncated =
    output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n…（内容过长，已截断）` : output;
  return { ok: true, text: `（${describeType(current)}）\n${truncated}` };
}
