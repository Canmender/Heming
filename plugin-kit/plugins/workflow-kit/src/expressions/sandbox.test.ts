import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_CODE_TIMEOUT_MS,
  createUserCodeRunner,
  isWorkerSandboxAvailable,
  normalizeUserCodeResult,
  runUserCode,
  UserCodeError,
} from "./sandbox.js";
import type { Item } from "../types.js";

/**
 * 代码沙箱测试（Node 服务版，node:vm）。
 *
 * 与旧浏览器版的区别：这里不需要模拟 Worker，`runUserCode` 默认就走真实的
 * `node:vm` 隔离。测试重点从「Worker 消息协议」换成三件事：
 * 1. 作用域只注入约定的那几项、宿主能力（process/require/fetch/fs）确实不存在；
 * 2. vm 的**同步超时**真的能打断 `while (true)`；
 * 3. 返回值经 structuredClone 回到宿主 realm（对象原型/数组判断与宿主一致）。
 */

const ITEMS: Item[] = [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }];

function itemsOf(...numbers: number[]): Item[] {
  return numbers.map((n) => ({ json: { n } }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runUserCode · 同步沙箱（node:vm）", () => {
  it("all-items：注入 items / $input / $json / $item / $itemIndex / $runIndex", async () => {
    const result = await runUserCode({
      code: [
        "return {",
        "  all: $input.all().length,",
        "  first: $input.first().json.n,",
        "  last: $input.last().json.n,",
        "  current: $input.item.json.n,",
        "  json: $json.n,",
        "  index: $itemIndex,",
        "  runIndex: $runIndex,",
        "  itemsLength: items.length,",
        "};",
      ].join("\n"),
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(result).toEqual({
      all: 3,
      first: 1,
      last: 3,
      current: 1,
      json: 1,
      index: 0,
      runIndex: 0,
      itemsLength: 3,
    });
  });

  it("all-items 可以指定 itemIndex 从某一项开始看", async () => {
    const result = await runUserCode({
      code: "return $json.n;",
      mode: "runOnceForAllItems",
      items: ITEMS,
      itemIndex: 1,
    });
    expect(result).toBe(2);
  });

  it("runOnceForEachItem：逐项执行并按顺序收集结果", async () => {
    const result = await runUserCode({
      code: "return { n: $json.n, doubled: $json.n * 2, index: $itemIndex };",
      mode: "runOnceForEachItem",
      items: ITEMS,
    });
    expect(result).toEqual([
      { n: 1, doubled: 2, index: 0 },
      { n: 2, doubled: 4, index: 1 },
      { n: 3, doubled: 6, index: 2 },
    ]);
  });

  it("runOnceForEachItem + itemIndex：只跑该项并返回单值", async () => {
    const result = await runUserCode({
      code: "return { n: $json.n, index: $itemIndex };",
      mode: "runOnceForEachItem",
      items: ITEMS,
      itemIndex: 2,
    });
    expect(result).toEqual({ n: 3, index: 2 });
  });

  it("空代码视为原样透传", async () => {
    await expect(
      runUserCode({ code: "   ", mode: "runOnceForAllItems", items: ITEMS }),
    ).resolves.toBe(ITEMS);
    await expect(
      runUserCode({ code: "", mode: "runOnceForEachItem", items: ITEMS }),
    ).resolves.toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await expect(
      runUserCode({ code: "", mode: "runOnceForEachItem", items: ITEMS, itemIndex: 1 }),
    ).resolves.toEqual({ n: 2 });
  });

  it("没有输入 items 时 all-items / per-item 都不炸", async () => {
    await expect(
      runUserCode({ code: "return { json: $json, item: $item, count: items.length };", mode: "runOnceForAllItems", items: [] }),
    ).resolves.toEqual({ json: {}, item: null, count: 0 });
    await expect(
      runUserCode({ code: "return $json.n;", mode: "runOnceForEachItem", items: [] }),
    ).resolves.toEqual([]);
  });

  it("返回值被克隆回宿主 realm（原型/数组判断与宿主一致）", async () => {
    const result = (await runUserCode({
      code: "return { nested: { list: [1, 2, 3] }, when: new Date(0) };",
      mode: "runOnceForAllItems",
      items: ITEMS,
    })) as { nested: { list: number[] }; when: Date };
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
    expect(Array.isArray(result.nested.list)).toBe(true);
    expect(result.nested.list).toEqual([1, 2, 3]);
    expect(result.when).toBeInstanceOf(Date);
    expect(result.when.getTime()).toBe(0);
  });

  it("items 数据进沙箱前是副本：用户代码改 items 不影响调用方", async () => {
    const source = itemsOf(1);
    const result = await runUserCode({
      code: "items[0].json.n = 99; return items[0].json.n;",
      mode: "runOnceForAllItems",
      items: source,
    });
    expect(result).toBe(99);
    expect(source[0]?.json.n).toBe(1);
  });

  it("用户数据里的引号/换行/中文不会破坏沙箱源码", async () => {
    const text = '他说："你好"\n第二行\\反斜杠';
    const result = await runUserCode({
      code: "return $json.text;",
      mode: "runOnceForAllItems",
      items: [{ json: { text } }],
    });
    expect(result).toBe(text);
  });

  it("console 输出被收集后由宿主打印（带级别前缀）", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runUserCode({
      code: 'console.log("hi", { a: 1 }); console.warn("注意"); console.error("错了"); return 1;',
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      '[log] hi {"a":1}',
      "[warn] 注意",
      "[error] 错了",
    ]);
  });

  it("运行报错前打印过的日志也会被刷出", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      runUserCode({
        code: 'console.log("before"); throw new Error("炸了");',
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/炸了/);
    expect(log.mock.calls.map((call) => call[0])).toContain("[log] before");
  });
});

describe("沙箱能力边界", () => {
  it("宿主全局不存在：process/require/fetch/fs/Buffer/定时器/__dirname/module", async () => {
    const result = await runUserCode({
      code: [
        "return [",
        "  typeof process, typeof require, typeof fetch, typeof fs,",
        "  typeof Buffer, typeof setTimeout, typeof __dirname, typeof module,",
        '].join(",");',
      ].join("\n"),
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(result).toBe(
      "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined",
    );
  });

  it("从沙箱里摸不到宿主 realm 的 process（原型链逃逸被 vm 挡住）", async () => {
    const result = await runUserCode({
      code: [
        "const viaLiteral = ({}).constructor.constructor('return typeof process')();",
        "const viaGlobal = globalThis.constructor.constructor('return typeof process')();",
        "const viaItems = items.constructor.constructor('return typeof require')();",
        "return [viaLiteral, viaGlobal, viaItems].join(',');",
      ].join("\n"),
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(result).toBe("undefined,undefined,undefined");
  });

  it("沙箱里只有约定的作用域与内建对象", async () => {
    const result = await runUserCode({
      code: "return [typeof items, typeof $input, typeof $json, typeof $item, typeof console, typeof Math, typeof JSON].join(',');",
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(result).toBe("object,object,object,object,object,object,object");
  });
});

describe("超时与错误", () => {
  it("同步死循环会被 vm timeout 打断", async () => {
    const startedAt = Date.now();
    await expect(
      runUserCode({
        code: "while (true) {}",
        mode: "runOnceForAllItems",
        items: ITEMS,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/代码执行超时（超过 100 毫秒/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("默认超时是 10 秒，并且可以由 createUserCodeRunner 覆盖", async () => {
    expect(DEFAULT_USER_CODE_TIMEOUT_MS).toBe(10_000);
    const runner = createUserCodeRunner({ timeoutMs: 100 });
    await expect(
      runner({ code: "for (;;) {}", mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码执行超时（超过 100 毫秒/);
  });

  it("语法错误在编译期拦下", async () => {
    await expect(
      runUserCode({ code: "return (", mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码语法有误/);
  });

  it("按同步定位：await / 返回 Promise 给中文错误", async () => {
    await expect(
      runUserCode({
        code: "const value = await Promise.resolve(1); return value;",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/代码语法有误/);

    await expect(
      runUserCode({
        code: "return Promise.resolve(1);",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/同步执行/);
  });

  it("用户运行时错误转成中文 UserCodeError", async () => {
    const error = await runUserCode({
      code: 'throw new Error("炸了");',
      mode: "runOnceForAllItems",
      items: ITEMS,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserCodeError);
    expect((error as UserCodeError).message).toBe("代码执行出错：炸了");

    await expect(
      runUserCode({ code: 'throw "坏了";', mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码执行出错：坏了/);
  });

  it("返回值含函数等不可克隆值时给可读错误", async () => {
    await expect(
      runUserCode({
        code: "return { fn: function () { return 1; } };",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/无法从沙箱传回宿主/);
  });

  it("输入数据无法序列化时给可读错误", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(
      runUserCode({
        code: "return 1;",
        mode: "runOnceForAllItems",
        items: [{ json: circular }],
      }),
    ).rejects.toThrow(/输入数据无法序列化/);
  });

  it("已取消的 signal 直接拒绝且不执行代码", async () => {
    const controller = new AbortController();
    controller.abort();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      runUserCode({
        code: 'console.log("不该执行"); return 1;',
        mode: "runOnceForAllItems",
        items: ITEMS,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/代码执行已取消/);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("兼容旧 API", () => {
  it("Node 版没有 Worker，isWorkerSandboxAvailable() 恒为 false", () => {
    expect(isWorkerSandboxAvailable()).toBe(false);
  });

  it("runUserCode 返回 Promise（错误以 reject 形式出现）", async () => {
    const promise = runUserCode({
      code: "return 1;",
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toBe(1);
  });
});

describe("normalizeUserCodeResult", () => {
  it("把常见返回值收敛成 Item[]", () => {
    expect(normalizeUserCodeResult(undefined)).toEqual([]);
    expect(normalizeUserCodeResult(null)).toEqual([]);
    expect(normalizeUserCodeResult({ a: 1 })).toEqual([{ json: { a: 1 } }]);
    expect(normalizeUserCodeResult([{ a: 1 }, { b: 2 }])).toEqual([
      { json: { a: 1 } },
      { json: { b: 2 } },
    ]);
    expect(normalizeUserCodeResult([{ json: { a: 1 } }, { json: { b: 2 } }])).toEqual([
      { json: { a: 1 } },
      { json: { b: 2 } },
    ]);
    expect(normalizeUserCodeResult(42)).toEqual([{ json: { value: 42 } }]);
  });

  it("保留 item 的 binary / pairedItem 字段", () => {
    const binary = { file: { data: "aGVsbG8=", mimeType: "text/plain" } };
    const result = normalizeUserCodeResult([{ json: { a: 1 }, binary, pairedItem: 2 }]);
    expect(result).toEqual([{ json: { a: 1 }, binary, pairedItem: 2 }]);
  });
});

describe("与代码节点的组合语义", () => {
  it("all-items 返回值可以被 normalizeUserCodeResult 直接收敛", async () => {
    const raw = await runUserCode({
      code: "return $input.all().map(function (item) { return { json: { n: item.json.n * 10 } }; });",
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(normalizeUserCodeResult(raw)).toEqual([
      { json: { n: 10 } },
      { json: { n: 20 } },
      { json: { n: 30 } },
    ]);
  });

  it("per-item + itemIndex 的单值可以被 normalizeUserCodeResult 收敛成一条 item", async () => {
    const raw = await runUserCode({
      code: "return { n: $json.n * 10 };",
      mode: "runOnceForEachItem",
      items: ITEMS,
      itemIndex: 1,
    });
    expect(normalizeUserCodeResult(raw)).toEqual([{ json: { n: 20 } }]);
  });
});

describe("沙箱 · 构造器逃逸拿不到宿主能力（自检口径）", () => {
  it("vm-realm 的 constructor.constructor 造出的 Function 仍在沙箱里", async () => {
    const result = await runUserCode({
      mode: "runOnceForAllItems",
      items: [],
      code: [
        "const make = globalThis.constructor.constructor;",
        "const viaGlobal = make('return typeof process')();",
        "const viaLiteral = ({}).constructor.constructor('return typeof require')();",
        "return [{ json: { viaGlobal, viaLiteral } }];",
      ].join("\n"),
    });
    const json = (result as Array<{ json: Record<string, unknown> }>)[0]?.json;
    expect(json.viaGlobal).toBe("undefined");
    expect(json.viaLiteral).toBe("undefined");
  });
});
