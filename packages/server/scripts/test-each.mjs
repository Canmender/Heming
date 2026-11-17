#!/usr/bin/env node
/**
 * 服务端测试逐文件跑（每个测试文件一个独立的 vitest 进程），并对「worker 原生崩溃」做有界重试。
 *
 * 背景（实测记录，别重复踩）：
 *   这台 Windows 机器上（Node 24.15 + vitest 5.0.5 + vite 8 + node:sqlite/FTS5 + 大量 supertest
 *   http server），一把 `vitest run` 会在**随机文件**上让 worker 崩溃：
 *   exit code 3221226505（0xC0000409 STATUS_STACK_BUFFER_OVERRUN），vitest 报
 *   "Worker exited unexpectedly ... during started state"。
 *   试过并复现过的组合：
 *     - 默认 fork 池；
 *     - `--maxWorkers=1 --no-file-parallelism`；
 *     - threads 池 + singleThread；
 *     - fork + singleFork + isolate:false；
 *     - 单 fork + isolate:true；
 *     - `--stack-size=4096`（反而更容易崩：worker 线程栈没法给到那么大）。
 *   单文件跑是**大多数时候**绿的（fts.test.ts 连跑 10 次全绿），但偶尔也会在单个文件里崩
 *   （app.test.ts 约 1/5～1/10 次）——所以它既不是某个断言的问题，也不是「文件太多」的问题，
 *   而是 worker 进程在 Windows 上的原生稳定性问题。
 *
 * 因此这里的策略是：
 *   1. 每个测试文件一个独立进程（短命进程，把不稳定的窗口缩到最小）；
 *   2. **只**对「进程被原生信号/异常码打死，或 vitest 自己报 worker 意外退出」做重试（最多 3 次）；
 *      断言失败一次就算失败——真实的 red 会稳定复现，不会被重试掩盖；
 *   3. 把重试次数打出来：如果哪天要重试的次数变多，说明环境在恶化，应该去看而不是忽略。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestPkgPath = require.resolve("vitest/package.json");
const vitestPkg = require(vitestPkgPath);
const vitestBin = resolve(vitestPkgPath, "..", vitestPkg.bin.vitest);

// Windows 上的原生崩溃码（0xC0000409 / 0xC0000005 / 0xC00000FD / 0xC0000017 等）。
const NATIVE_CRASH_CODES = new Set([3221226505, 3221225477, 3221225725, 3221225620, 3221225495]);
const CRASH_TEXT = /Worker exited unexpectedly|Worker (?:forks|threads) emitted error/;
const MAX_ATTEMPTS = 3;

/** @param {string} dir @param {string[]} out */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collect(full, out);
    } else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(join(serverRoot, "src")).sort((a, b) =>
  relative(serverRoot, a).localeCompare(relative(serverRoot, b)),
);
if (files.length === 0) {
  console.error("没有找到 .test.ts");
  process.exit(1);
}

const env = { ...process.env };
if (!env.NODE_OPTIONS) env.NODE_OPTIONS = "--max-old-space-size=4096";

const failures = [];
let retried = 0;
const startedAt = Date.now();

for (const [index, file] of files.entries()) {
  const rel = relative(serverRoot, file).replace(/\\/g, "/");
  const label = `[${index + 1}/${files.length}]`;
  let attempt = 0;
  let passed = false;
  let lastCode = null;
  let lastOutput = "";

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const at = Date.now();
    const result = spawnSync(process.execPath, [vitestBin, "run", rel, "--reporter=dot", "--no-color"], {
      cwd: serverRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const seconds = ((Date.now() - at) / 1000).toFixed(1);
    const code = result.status;

    if (code === 0) {
      const suffix = attempt > 1 ? `（第 ${attempt} 次；前一次是 worker 原生崩溃，已过）` : "";
      console.log(`${label} ok   ${rel}（${seconds}s）${suffix}`);
      if (attempt > 1) retried += 1;
      passed = true;
      break;
    }

    lastCode = code;
    lastOutput = output;
    const nativeCrash = code === null || NATIVE_CRASH_CODES.has(code) || CRASH_TEXT.test(output);
    if (!nativeCrash) {
      console.error(`${label} FAIL ${rel}（exit ${code}，${seconds}s）`);
      break;
    }
    if (attempt < MAX_ATTEMPTS) {
      console.error(`${label} !!   ${rel} 被 worker 原生崩溃打断（exit ${code ?? "signal"}），重跑第 ${attempt + 1} 次`);
    }
  }

  if (!passed) {
    const tail = lastOutput.trimEnd().split(/\r?\n/).slice(-12).join("\n");
    if (tail) console.error(tail);
    failures.push({ rel, code: lastCode });
  }
}

const total = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\n${failures.length}/${files.length} 个测试文件未通过（共 ${total}s）：`);
  for (const item of failures) console.error(`  - ${item.rel}（exit ${item.code ?? "signal"}）`);
  process.exit(1);
}
const retryNote =
  retried > 0 ? `；其中 ${retried} 个文件被 worker 原生崩溃打断过一次、重跑后通过` : "";
console.log(`\n全部 ${files.length} 个测试文件通过（逐文件独立进程，共 ${total}s）${retryNote}。`);
