#!/usr/bin/env node
/**
 * `pnpm eval:agent` 的 CLI 外壳。
 *
 * 为什么需要这层壳：runner 是 TypeScript（要 import `packages/web/src/lib/**` 的真实源码），
 * 而仓库根脚本都是纯 `.mjs`。这里用 tsx 的 ESM 注册钩子把 `.ts` 接上，
 * 再动态 import `evals/runner/cli.ts`——好处是 `node --check scripts/eval-agent.mjs` 仍然成立，
 * 且两种启动方式都支持：
 *   - `node scripts/eval-agent.mjs`（脚本内部注册 tsx）
 *   - `node --import tsx scripts/eval-agent.mjs`（由 Node 提前注册，脚本内注册失败也不影响）
 *
 * 退出码由 runner 决定（0 绿 / 1 红 / 2 配置或环境错误）。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * 给 Node 装上最小的浏览器垫片。
 *
 * 为什么要垫：评测要 import `packages/web/src/lib/**` 的**真实源码**，其中
 * `hitl/policy.ts`、`fileEdit/roots.ts`、`rollout/log.ts` 这些模块在取值时会摸
 * `window.localStorage`（浏览器里本来就该有）。Node 里没有 `window`，模块加载期
 * 直接 ReferenceError 会把评测器打死在一个与用例无关的地方。
 *
 * 垫的是「内存版 localStorage + 空 document」，不是假装有 UI：
 * 评测用例不会走到导出文件/桌面通知这些分支，垫片只保证模块能加载、读写不崩。
 * 必须在 import runner 之前调用——静态 import 会被提升，所以这一层贴在动态 import 前面。
 */
function installBrowserShims() {
  const g = globalThis;
  if (typeof g.window === "undefined") {
    const store = new Map();
    /** @type {Storage} */
    const memory = {
      getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
      setItem: (key, value) => {
        store.set(String(key), String(value));
      },
      removeItem: (key) => {
        store.delete(String(key));
      },
      clear: () => store.clear(),
      key: (index) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    };
    g.window = g;
    g.localStorage = memory;
    g.sessionStorage = memory;
    g.window.localStorage = memory;
    g.window.sessionStorage = memory;
  }
  if (typeof g.document === "undefined") {
    g.document = {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, click() {} }),
      body: { appendChild() {}, removeChild() {} },
      hasFocus: () => false,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };
  }
}

async function main() {
  installBrowserShims();
  try {
    const { register } = await import("tsx/esm/api");
    register();
  } catch {
    /* 走 `node --import tsx` 启动时不需要这里注册；真缺 tsx 会在下面 import runner 时报错 */
  }

  const runnerPath = path.join(ROOT, "evals", "runner", "cli.ts");
  let runCli;
  try {
    ({ runCli } = await import(pathToFileURL(runnerPath).href));
  } catch (e) {
    console.error("eval:agent 无法加载 runner（请确认已 pnpm install，tsx 在根 devDependencies 里）");
    throw e;
  }
  return runCli(process.argv.slice(2), ROOT);
}

let code = 2;
try {
  code = await main();
} catch (e) {
  console.error("eval:agent 启动失败：", e instanceof Error ? (e.stack ?? e.message) : e);
  code = 2;
}
process.exit(code);
