import { beforeEach, describe, expect, it } from "vitest";
import {
  buildExpressionContext,
  clearExpressionCache,
  evaluateExpression,
  ExpressionError,
  getExpressionCacheSize,
  hasExpression,
  isSingleExpression,
  resolveParameters,
  resolveValue,
  type BuildExpressionContextInput,
} from "./index.js";
import type { ExpressionContext } from "../types.js";

/**
 * 表达式求值的契约测试。
 *
 * 钉住四类容易回归的语义：
 * 1. 整段 `{{ }}` 保留原始类型（尤其数组/对象不当字符串）；
 * 2. 文本拼接规则与嵌套参数递归；
 * 3. `$now`/`$node`/`$items` 等作用域变量可用；
 * 4. 错误信息必须能让人定位（带表达式片段、说清哪个变量不存在）。
 */

const NOW = new Date(2026, 10, 7, 9, 30, 5, 42);

function makeContext(overrides: Partial<BuildExpressionContextInput> = {}): ExpressionContext {
  return buildExpressionContext({
    json: { name: "张三", token: "abc", n: 2 },
    items: [{ json: { n: 1 } }, { json: { n: 2 } }],
    itemIndex: 0,
    runIndex: 0,
    nodeOutputs: {},
    workflow: { id: "wf-1", name: "测试工作流", active: true },
    execution: { id: "exec-1", mode: "manual" },
    vars: { 环境: "本机" },
    parameter: { url: "https://example.com/api" },
    now: NOW,
    ...overrides,
  });
}

function expectExpressionError(fn: () => unknown): ExpressionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpressionError);
    return error as ExpressionError;
  }
  throw new Error("预期抛出 ExpressionError，但表达式正常返回了");
}

beforeEach(() => {
  clearExpressionCache();
});

describe("hasExpression", () => {
  it("识别字符串里的表达式", () => {
    expect(hasExpression("{{ $json.name }}")).toBe(true);
    expect(hasExpression("Bearer {{ $json.token }}")).toBe(true);
    expect(hasExpression("普通文本")).toBe(false);
  });

  it("递归检查数组与嵌套对象", () => {
    expect(hasExpression({ a: { b: ["x", "{{ $json.n }}"] } })).toBe(true);
    expect(hasExpression({ a: { b: ["x", "y"] } })).toBe(false);
    expect(hasExpression([1, 2, { c: ["{{ 1 + 1 }}"] }])).toBe(true);
  });

  it("未闭合与空表达式按普通文本处理", () => {
    expect(hasExpression("{{ $json.name")).toBe(false);
    expect(hasExpression("{{ }}")).toBe(false);
  });
});

describe("evaluateExpression", () => {
  it("访问 $json 与做算术", () => {
    const ctx = makeContext();
    expect(evaluateExpression("$json.name", ctx)).toBe("张三");
    expect(evaluateExpression("$json.n + 1", ctx)).toBe(3);
    expect(evaluateExpression("$json.name + '先生'", ctx)).toBe("张三先生");
  });

  it("暴露全部约定的作用域变量", () => {
    const ctx = makeContext();
    expect(evaluateExpression("$items.length", ctx)).toBe(2);
    expect(evaluateExpression("$items[$itemIndex].json.n", ctx)).toBe(1);
    expect(evaluateExpression("$item(1).json.n", ctx)).toBe(2);
    expect(evaluateExpression("$vars.环境", ctx)).toBe("本机");
    expect(evaluateExpression("$parameter.url", ctx)).toBe("https://example.com/api");
    expect(evaluateExpression("$workflow.name", ctx)).toBe("测试工作流");
    expect(evaluateExpression("$execution.mode", ctx)).toBe("manual");
    expect(evaluateExpression("$runIndex", ctx)).toBe(0);
  });

  it("$now / $today / $timestamp 指向注入的时间", () => {
    const ctx = makeContext();
    expect(evaluateExpression("$now.format('yyyy-MM-dd HH:mm:ss')", ctx)).toBe(
      "2026-11-07 09:30:05",
    );
    expect(evaluateExpression("$now.plus(1, 'day').format('yyyy-MM-dd')", ctx)).toBe("2026-11-08");
    expect(evaluateExpression("$now.minus(1, 'week').format('yyyy-MM-dd')", ctx)).toBe(
      "2026-10-31",
    );
    expect(evaluateExpression("$today.format('yyyy-MM-dd HH:mm:ss')", ctx)).toBe(
      "2026-11-07 00:00:00",
    );
    expect(evaluateExpression("$timestamp", ctx)).toBe(NOW.getTime());
  });

  it("空表达式体返回空串", () => {
    expect(evaluateExpression("   ", makeContext())).toBe("");
  });

  it("支持多行表达式与模板字符串", () => {
    const ctx = makeContext();
    expect(evaluateExpression("$json.n +\n  1", ctx)).toBe(3);
    expect(evaluateExpression("`结果 ${$json.n}`", ctx)).toBe("结果 2");
    // 模板字符串的文本部分只是文本，不该触发危险全局判定
    expect(evaluateExpression("`window ${$json.n}`", ctx)).toBe("window 2");
  });
});

describe("resolveValue 的类型保留与拼接", () => {
  it("整段表达式保留原始类型", () => {
    const ctx = makeContext();
    expect(resolveValue("{{ $json.n }}", ctx)).toBe(2);
    expect(resolveValue("{{ $json.n > 1 }}", ctx)).toBe(true);
    expect(resolveValue("{{ null }}", ctx)).toBeNull();
    expect(resolveValue("{{ [1, 2, 3] }}", ctx)).toEqual([1, 2, 3]);
    expect(resolveValue("{{ { a: 1, b: { c: 2 } } }}", ctx)).toEqual({ a: 1, b: { c: 2 } });
    // 前后空白不影响「整段就是一个表达式」的判断
    expect(resolveValue("  {{ $json.n }}  ", ctx)).toBe(2);
  });

  it("文本里拼接时字符串化", () => {
    const ctx = makeContext();
    expect(resolveValue("Bearer {{ $json.token }}", ctx)).toBe("Bearer abc");
    expect(resolveValue("{{ $json.n }} 个", ctx)).toBe("2 个");
    expect(resolveValue("{{ $json.n }}-{{ $json.token }}", ctx)).toBe("2-abc");
    expect(resolveValue("数据：{{ { a: 1 } }}", ctx)).toBe('数据：{"a":1}');
    expect(resolveValue("空值：{{ undefined }}", ctx)).toBe("空值：");
    // 表达式里的字符串可以包含 `}}`，扫描器不能提前截断
    expect(resolveValue('{{ "}}" }}', ctx)).toBe("}}");
  });

  it("嵌套对象/数组递归解析，且不修改原始参数", () => {
    const ctx = makeContext();
    const source = {
      title: "{{ $json.name }}",
      nested: { list: ["{{ $json.n }}", "x"], keep: 3 },
      flags: ["{{ $json.n === 2 }}"],
    };
    const snapshot = JSON.parse(JSON.stringify(source)) as unknown;
    expect(resolveValue(source, ctx)).toEqual({
      title: "张三",
      nested: { list: [2, "x"], keep: 3 },
      flags: [true],
    });
    expect(source).toEqual(snapshot);
  });

  it("resolveParameters 解析全部参数并返回新对象", () => {
    const ctx = makeContext();
    const params = { url: "{{ $parameter.url }}", body: { who: "{{ $json.name }}" } };
    const resolved = resolveParameters(params, ctx);
    expect(resolved).toEqual({ url: "https://example.com/api", body: { who: "张三" } });
    expect(resolved).not.toBe(params);
    expect(params.body).toEqual({ who: "{{ $json.name }}" });
  });

  it("非字符串/非 plain object 原样保留", () => {
    const ctx = makeContext();
    expect(resolveValue(5, ctx)).toBe(5);
    expect(resolveValue(null, ctx)).toBeNull();
    const date = new Date(0);
    expect(resolveValue(date, ctx)).toBe(date);
  });
});

describe("$node 访问", () => {
  const ctx = () =>
    makeContext({
      nodeOutputs: {
        "HTTP 请求": [{ json: { ok: true, n: 1 } }, { json: { ok: false, n: 2 } }],
        "空节点": [],
      },
    });

  it("取最近一次运行的第一条与全部 items", () => {
    expect(evaluateExpression('$node["HTTP 请求"].json.ok', ctx())).toBe(true);
    expect(evaluateExpression('$node["HTTP 请求"].all().length', ctx())).toBe(2);
    expect(evaluateExpression('$node["空节点"].json', ctx())).toEqual({});
  });

  it("$toJson($node[...]) 不会被访问器误伤", () => {
    expect(evaluateExpression('$toJson($node["HTTP 请求"].json)', ctx())).toBe('{"ok":true,"n":1}');
  });

  it("节点不存在时给出可读中文错误", () => {
    const error = expectExpressionError(() => evaluateExpression('$node["不存在"].json', ctx()));
    expect(error.message).toContain("不存在");
    expect(error.message).toContain("$node");
  });
});

describe("内置 helper", () => {
  const ctx = () => makeContext();

  it("$if / $isEmpty / $length", () => {
    expect(evaluateExpression("$if($json.n > 1, 'big', 'small')", ctx())).toBe("big");
    expect(evaluateExpression("$isEmpty($json.name)", ctx())).toBe(false);
    expect(evaluateExpression("$isEmpty([])", ctx())).toBe(true);
    expect(evaluateExpression("$isEmpty({})", ctx())).toBe(true);
    expect(evaluateExpression("$isEmpty('   ')", ctx())).toBe(true);
    expect(evaluateExpression("$length('abc')", ctx())).toBe(3);
    expect(evaluateExpression("$length({ a: 1, b: 2 })", ctx())).toBe(2);
  });

  it("$toJson / $fromJson / $number / $string / $boolean", () => {
    expect(evaluateExpression("$toJson({ a: 1 })", ctx())).toBe('{"a":1}');
    expect(evaluateExpression("$fromJson('{\"a\":1}').a", ctx())).toBe(1);
    expect(evaluateExpression("$fromJson('不是 JSON')", ctx())).toBeNull();
    expect(evaluateExpression("$number('12.5')", ctx())).toBe(12.5);
    expect(evaluateExpression("$number('abc')", ctx())).toBe(0);
    expect(evaluateExpression("$string(1)", ctx())).toBe("1");
    expect(evaluateExpression("$boolean('false')", ctx())).toBe(false);
    expect(evaluateExpression("$boolean('是')", ctx())).toBe(true);
  });

  it("$uuid / $random", () => {
    const first = evaluateExpression("$uuid()", ctx());
    const second = evaluateExpression("$uuid()", ctx());
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    const random = evaluateExpression("$random()", ctx());
    expect(typeof random).toBe("number");
    expect(random as number).toBeGreaterThanOrEqual(0);
    expect(random as number).toBeLessThan(1);
  });

  it("列表/字符串 helper", () => {
    const c = ctx();
    expect(evaluateExpression("$sum([1, 2, 3])", c)).toBe(6);
    expect(evaluateExpression('$sum($items, "n")', c)).toBe(3);
    expect(evaluateExpression('$max($items, "n")', c)).toBe(2);
    expect(evaluateExpression('$min($items, "n")', c)).toBe(1);
    expect(evaluateExpression("$max([])", c)).toBeNull();
    expect(evaluateExpression("$keys({ a: 1, b: 2 })", c)).toEqual(["a", "b"]);
    expect(evaluateExpression("$merge({ a: 1 }, { b: 2, a: 3 })", c)).toEqual({ a: 3, b: 2 });
    expect(evaluateExpression("$split('a,b,c')", c)).toEqual(["a", "b", "c"]);
    expect(evaluateExpression("$split('a|b', '|')", c)).toEqual(["a", "b"]);
    expect(evaluateExpression("$trim('  hi  ')", c)).toBe("hi");
    expect(evaluateExpression("$lower('ABC')", c)).toBe("abc");
    expect(evaluateExpression("$upper('abc')", c)).toBe("ABC");
    expect(evaluateExpression("$match('abc', '^a')", c)).toBe(true);
    expect(evaluateExpression("$match('abc', '^b')", c)).toBe(false);
    expect(evaluateExpression("$replace('a-b', '-', '_')", c)).toBe("a_b");
    expect(evaluateExpression("$replace('a-b', /-/, '_')", c)).toBe("a_b");
  });
});

describe("错误信息", () => {
  it("语法错误带表达式片段", () => {
    const error = expectExpressionError(() => evaluateExpression("$json.name +", makeContext()));
    expect(error.message).toContain("表达式语法有误");
    expect(error.message).toContain("$json.name +");
    expect(error.expression).toBe("$json.name +");
  });

  it("变量不存在时说清是哪个变量", () => {
    const error = expectExpressionError(() =>
      evaluateExpression("$json.name + $不存在的变量", makeContext()),
    );
    expect(error.message).toContain("不存在的变量");
    expect(error.message).toContain("$不存在的变量");
  });

  it("访问空值属性时给出定位提示", () => {
    const error = expectExpressionError(() =>
      evaluateExpression("$json.missing.deep", makeContext()),
    );
    expect(error.message).toContain("空值");
    expect(error.message).toContain("deep");
  });

  it("拒绝网络/页面/存储全局", () => {
    expect(expectExpressionError(() => evaluateExpression('fetch("http://x")', makeContext())).message).toContain(
      "fetch",
    );
    expect(expectExpressionError(() => evaluateExpression("window.location.href", makeContext())).message).toContain(
      "window",
    );
    expect(expectExpressionError(() => evaluateExpression("localStorage.getItem('a')", makeContext())).message).toContain(
      "localStorage",
    );
    expect(expectExpressionError(() => evaluateExpression("process.env.HOME", makeContext())).message).toContain(
      "process",
    );
  });

  it("拒绝原型链逃逸与动态 import", () => {
    expect(
      expectExpressionError(() =>
        evaluateExpression('({}).constructor.constructor("return 1")()', makeContext()),
      ).message,
    ).toContain("constructor");
    expect(
      expectExpressionError(() => evaluateExpression('$json["constructor"]', makeContext())).message,
    ).toContain("constructor");
    expect(expectExpressionError(() => evaluateExpression("$json.__proto__", makeContext())).message).toContain(
      "__proto__",
    );
    expect(expectExpressionError(() => evaluateExpression('import("node:fs")', makeContext())).message).toContain(
      "import",
    );
  });

  it("字符串里出现敏感词不算越界", () => {
    const ctx = makeContext({ json: { text: "这是 window 和 fetch 的说明" } });
    expect(evaluateExpression("$json.text", ctx)).toBe("这是 window 和 fetch 的说明");
    expect(evaluateExpression("'constructor'", ctx)).toBe("constructor");
  });

  it("模板字符串的 ${} 里仍是代码，照常拦截", () => {
    expect(
      expectExpressionError(() => evaluateExpression("`x ${fetch('http://x')}`", makeContext())).message,
    ).toContain("fetch");
  });
});

describe("编译缓存", () => {
  it("同一表达式只编译一次，清空后归零", () => {
    const ctx = makeContext();
    expect(getExpressionCacheSize()).toBe(0);
    evaluateExpression("$json.n + 1", ctx);
    evaluateExpression("$json.n + 1", ctx);
    expect(getExpressionCacheSize()).toBe(1);
    evaluateExpression("$json.n + 2", ctx);
    expect(getExpressionCacheSize()).toBe(2);
    clearExpressionCache();
    expect(getExpressionCacheSize()).toBe(0);
  });

  it("循环里反复求值不会越算越慢/越算越错", () => {
    const ctx = makeContext();
    for (let index = 0; index < 200; index += 1) {
      expect(evaluateExpression("$json.n * 2", ctx)).toBe(4);
    }
    expect(getExpressionCacheSize()).toBe(1);
  });

  it("被拒绝的表达式也缓存扫描结论", () => {
    const ctx = makeContext();
    expect(() => evaluateExpression("fetch('http://x')", ctx)).toThrow(/fetch/);
    expect(() => evaluateExpression("fetch('http://x')", ctx)).toThrow(/fetch/);
    expect(getExpressionCacheSize()).toBe(1);
  });
});

describe("isSingleExpression", () => {
  it("区分整段表达式与拼接文本", () => {
    expect(isSingleExpression("{{ $json.n }}")).toBe(true);
    expect(isSingleExpression("  {{ $json.n }}  ")).toBe(true);
    expect(isSingleExpression("x {{ $json.n }}")).toBe(false);
    expect(isSingleExpression("{{ $json.n }}{{ $json.token }}")).toBe(false);
    expect(isSingleExpression("普通文本")).toBe(false);
  });
});
