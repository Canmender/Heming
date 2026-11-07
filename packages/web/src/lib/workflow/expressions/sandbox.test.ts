import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodeSandboxWorkerSource,
  createUserCodeRunner,
  isWorkerSandboxAvailable,
  normalizeUserCodeResult,
  runUserCode,
  UserCodeError,
  type SandboxWorker,
  type SandboxWorkerFactory,
} from "./sandbox.js";
import type { Item } from "../types.js";

/**
 * 代码沙箱测试。
 *
 * 两个执行路径都要覆盖：
 * - jsdom / SSR 没有 `Worker`，走同步 fallback（这里用 `workerFactory: null` 显式命中）；
 * - 真实运行走 Blob Worker，但 jsdom 起不了 Worker——用 `node:vm` 跑**同一份生成的
 *   Worker 源码**，把「主线程 ↔ Worker 消息协议、超时 terminate、错误回传」也测到，
 *   否则 Worker 分支在 CI 里永远是盲区。
 */

const ITEMS: Item[] = [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }];

/** 显式走同步 fallback 的运行器（jsdom 下即使有兜底也不依赖）. */
const fallbackRunner = createUserCodeRunner({ workerFactory: null });

// ---------------------------------------------------------------------------
// node:vm 里的 Worker 替身
// ---------------------------------------------------------------------------

interface VmWorkerRecord {
  terminated(): boolean;
}

function installVmWorkerFactory(): {
  factory: SandboxWorkerFactory;
  records: VmWorkerRecord[];
} {
  const records: VmWorkerRecord[] = [];
  const factory: SandboxWorkerFactory = (source: string): SandboxWorker => {
    const messageHandlers: Array<(data: unknown) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    let terminated = false;
    const selfObject: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: unknown) => void;
    } = {
      onmessage: null,
      postMessage: (message: unknown): void => {
        if (terminated) return;
        queueMicrotask(() => {
          for (const handler of messageHandlers) handler(message);
        });
      },
    };
    const sandbox: Record<string, unknown> = {
      self: selfObject,
      console,
      setTimeout,
      clearTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: "code-sandbox.worker.js" });

    const worker: SandboxWorker = {
      postMessage(message: unknown): void {
        if (terminated) return;
        queueMicrotask(() => {
          selfObject.onmessage?.({ data: message });
        });
      },
      terminate(): void {
        terminated = true;
      },
      onMessage(handler: (data: unknown) => void): void {
        messageHandlers.push(handler);
      },
      onError(handler: (error: Error) => void): void {
        errorHandlers.push(handler);
      },
    };
    records.push({ terminated: () => terminated });
    return worker;
  };
  return { factory, records };
}

// ---------------------------------------------------------------------------
// 同步 fallback
// ---------------------------------------------------------------------------

describe("runUserCode · 同步 fallback（无 Worker 环境）", () => {
  it("runOnceForAllItems：注入 items / $input / $json / $item", async () => {
    const result = await fallbackRunner({
      code: [
        "return {",
        "  all: $input.all().length,",
        "  first: $input.first().json.n,",
        "  last: $input.last().json.n,",
        "  current: $input.item.json.n,",
        "  json: $json.n,",
        "  index: $itemIndex,",
        "  runIndex: $runIndex,",
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
    });
  });

  it("runOnceForEachItem：逐项执行并按顺序收集结果", async () => {
    const result = await fallbackRunner({
      code: "return { json: { doubled: $json.n * 2, index: $itemIndex } };",
      mode: "runOnceForEachItem",
      items: ITEMS,
    });
    expect(result).toEqual([
      { json: { doubled: 2, index: 0 } },
      { json: { doubled: 4, index: 1 } },
      { json: { doubled: 6, index: 2 } },
    ]);
  });

  it("itemIndex 只跑指定的一项", async () => {
    const all = await fallbackRunner({
      code: "return $json.n;",
      mode: "runOnceForAllItems",
      items: ITEMS,
      itemIndex: 1,
    });
    expect(all).toBe(2);

    const one = await fallbackRunner({
      code: "return { json: { n: $json.n, index: $itemIndex } };",
      mode: "runOnceForEachItem",
      items: ITEMS,
      itemIndex: 2,
    });
    // 给了 itemIndex 就是「只跑这一项」，返回单值（代码节点逐条调用依赖这个形状）
    expect(one).toEqual({ json: { n: 3, index: 2 } });
  });

  it("空代码视为原样透传", async () => {
    await expect(
      fallbackRunner({ code: "   ", mode: "runOnceForAllItems", items: ITEMS }),
    ).resolves.toBe(ITEMS);
    await expect(
      fallbackRunner({ code: "", mode: "runOnceForEachItem", items: ITEMS }),
    ).resolves.toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await expect(
      fallbackRunner({ code: "", mode: "runOnceForEachItem", items: ITEMS, itemIndex: 1 }),
    ).resolves.toEqual({ n: 2 });
  });

  it("支持 async 用户代码", async () => {
    const result = await fallbackRunner({
      code: "const value = await Promise.resolve($json.n * 10); return value + 1;",
      mode: "runOnceForAllItems",
      items: ITEMS,
      itemIndex: 1,
    });
    expect(result).toBe(21);
  });

  it("运行时异常转成中文 UserCodeError", async () => {
    await expect(
      fallbackRunner({ code: 'throw new Error("炸了");', mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码执行出错：炸了/);
  });

  it("语法错误在编译期拦下", async () => {
    await expect(
      fallbackRunner({ code: "return (", mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码语法有误/);
  });

  it("超时（异步未返回）会拒绝并说明已终止", async () => {
    const startedAt = Date.now();
    await expect(
      fallbackRunner({
        code: "return new Promise(function () {});",
        mode: "runOnceForAllItems",
        items: ITEMS,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/代码执行超时/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("AbortSignal 可以取消执行", async () => {
    const controller = new AbortController();
    const promise = fallbackRunner({
      code: "return new Promise(function () {});",
      mode: "runOnceForAllItems",
      items: ITEMS,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow(/代码执行已取消/);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      fallbackRunner({
        code: "return 1;",
        mode: "runOnceForAllItems",
        items: ITEMS,
        signal: aborted.signal,
      }),
    ).rejects.toThrow(/代码执行已取消/);
  });
});

// ---------------------------------------------------------------------------
// 安全硬化（两条执行路径共用前置扫描）
// ---------------------------------------------------------------------------

describe("runUserCode · 安全硬化", () => {
  it("拒绝网络入口，且不会真的调用 fetch", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("沙箱不该真的发请求");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const error = await fallbackRunner({
        code: 'return fetch("http://example.com");',
        mode: "runOnceForAllItems",
        items: ITEMS,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UserCodeError);
      expect((error as UserCodeError).message).toContain("fetch");
      expect((error as UserCodeError).message).toContain("HTTP 请求节点");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("拒绝页面/存储/宿主入口", async () => {
    await expect(
      fallbackRunner({
        code: "return window.location.href;",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/window/);

    await expect(
      fallbackRunner({
        code: "return localStorage.getItem('token');",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/localStorage/);

    await expect(
      fallbackRunner({
        code: "return process.env.HOME;",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/process/);
  });

  it("拒绝原型链逃逸与动态 import", async () => {
    await expect(
      fallbackRunner({
        code: 'return ({}).constructor.constructor("return this")();',
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/constructor/);

    await expect(
      fallbackRunner({
        code: "return item.__proto__;",
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/__proto__/);

    await expect(
      fallbackRunner({
        code: 'return import("node:fs");',
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/import/);
  });

  it("字符串与注释里的敏感词不误伤", async () => {
    const result = await fallbackRunner({
      code: [
        "// 这里只是注释：window / fetch",
        'const note = "window.fetch 只是文本";',
        "return { note: note, value: items.length };",
      ].join("\n"),
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(result).toEqual({ note: "window.fetch 只是文本", value: 3 });
  });
});

// ---------------------------------------------------------------------------
// Worker 协议（node:vm 执行生成的 Worker 源码）
// ---------------------------------------------------------------------------

describe("runUserCode · Worker 路径", () => {
  it("生成的 Worker 源码注入了遮蔽名单与作用域名", () => {
    const source = buildCodeSandboxWorkerSource();
    expect(source).toContain('"fetch"');
    expect(source).toContain('"$json"');
    expect(source).not.toContain("__SHADOWED_GLOBALS__");
    expect(source).not.toContain("__CODE_SCOPE_KEYS__");
  });

  it("all-items 模式返回 Worker 的结果并 terminate", async () => {
    const { factory, records } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    const result = await runner({
      code: "return { json: { total: items.length, first: $json.n } };",
      mode: "runOnceForAllItems",
      items: ITEMS,
    });
    expect(result).toEqual({ json: { total: 3, first: 1 } });
    expect(records).toHaveLength(1);
    expect(records[0]?.terminated()).toBe(true);
  });

  it("per-item 模式逐项返回", async () => {
    const { factory } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    const result = await runner({
      code: "return { json: { n: $json.n, index: $itemIndex } };",
      mode: "runOnceForEachItem",
      items: ITEMS,
    });
    expect(result).toEqual([
      { json: { n: 1, index: 0 } },
      { json: { n: 2, index: 1 } },
      { json: { n: 3, index: 2 } },
    ]);
  });

  it("per-item + itemIndex 返回该项单值", async () => {
    const { factory } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    const result = await runner({
      code: "return $json.n * 100;",
      mode: "runOnceForEachItem",
      items: ITEMS,
      itemIndex: 1,
    });
    expect(result).toBe(200);
  });

  it("Worker 内抛错会带回中文错误", async () => {
    const { factory, records } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    await expect(
      runner({ code: 'throw new Error("炸了");', mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码执行出错：炸了/);
    expect(records[0]?.terminated()).toBe(true);
  });

  it("Worker 超时会 terminate 并拒绝", async () => {
    const { factory, records } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    await expect(
      runner({
        code: "return new Promise(function () {});",
        mode: "runOnceForAllItems",
        items: ITEMS,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/代码执行超时/);
    expect(records[0]?.terminated()).toBe(true);
  });

  it("Worker 运行中 AbortSignal 会 terminate", async () => {
    const { factory, records } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    const controller = new AbortController();
    const promise = runner({
      code: "return new Promise(function () {});",
      mode: "runOnceForAllItems",
      items: ITEMS,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow(/代码执行已取消/);
    expect(records[0]?.terminated()).toBe(true);
  });

  it("危险代码在启动 Worker 之前就被拒绝", async () => {
    const { factory, records } = installVmWorkerFactory();
    const runner = createUserCodeRunner({ workerFactory: factory });
    await expect(
      runner({
        code: 'return fetch("http://example.com");',
        mode: "runOnceForAllItems",
        items: ITEMS,
      }),
    ).rejects.toThrow(/fetch/);
    expect(records).toHaveLength(0);
  });

  it("Worker 工厂启动失败给可读错误", async () => {
    const runner = createUserCodeRunner({
      workerFactory: () => {
        throw new Error("没有 Worker");
      },
    });
    await expect(
      runner({ code: "return 1;", mode: "runOnceForAllItems", items: ITEMS }),
    ).rejects.toThrow(/代码沙箱启动失败：没有 Worker/);
  });

  it("jsdom 下没有 Worker 时自动走 fallback", () => {
    expect(isWorkerSandboxAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 结果归一化（代码节点消费）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 默认导出（runUserCode）在当前环境也可用
// ---------------------------------------------------------------------------

describe("runUserCode 默认运行器", () => {
  it("jsdom 下自动降级后仍能正常执行", async () => {
    const result = await runUserCode({
      code: "return $json.n * 2;",
      mode: "runOnceForAllItems",
      items: ITEMS,
      itemIndex: 1,
    });
    expect(result).toBe(4);
  });
});
