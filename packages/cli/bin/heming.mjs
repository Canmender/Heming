#!/usr/bin/env node
/**
 * 稳定启动入口：给 MCP 客户端（Cursor / Claude Code / Claude Desktop）一个**不需要 pnpm** 的命令。
 *
 * 为什么要这一层：`@heming/cli` 的源码是 TypeScript，且直接 import monorepo 里其它包的 `.ts`
 * 源码（`../../web/src/lib/...js` 这些引用由 tsx 解析）；本包 `build` 只做 `tsc --noEmit`，
 * 不产出 `dist`。所以客户端配置里既不能写 `dist/index.js`（不存在），也不该要求用户 PATH 里
 * 恰好有 `pnpm`。这里用仓库里已经装好的 `tsx` 转译后跑 `src/index.ts`，参数原样透传：
 *
 *   node <repo>/packages/cli/bin/heming.mjs mcp serve --cwd D:/repo
 *
 * 只做三件事：找到 tsx、把参数交出去、把信号与退出码如实传回来。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const entry = path.join(pkgRoot, "src", "index.ts");

/** tsx 的 CLI 位置：先看本包 node_modules（pnpm 会给直接依赖建软链），再看仓库根。 */
function findTsxCli() {
  const candidates = [
    path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.resolve(pkgRoot, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const tsxCli = findTsxCli();
if (!tsxCli) {
  process.stderr.write(
    "[heming] 找不到 tsx：请先在仓库根跑一次 `pnpm install`，或改用 `pnpm cli` 启动。\n",
  );
  process.exit(2);
}
if (!existsSync(entry)) {
  process.stderr.write(`[heming] 找不到入口文件：${entry}\n`);
  process.exit(2);
}

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

// MCP 客户端可能直接杀进程：把信号传下去，让我们自己收尾（关 stdin、写 stderr）。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`[heming] 启动失败：${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  // 被信号杀掉的按 130 报，与 `heming run` 的 Ctrl+C 口径一致。
  process.exit(code ?? (signal ? 130 : 0));
});
