#!/usr/bin/env node
/**
 * 内置运行时的预处理（打包前必跑）。
 *
 * ## 为什么需要这一步
 *
 * Python 第一次导入模块时会把源码编译成字节码（`.pyc`）缓存在 `__pycache__/`。
 * 如果包里**没有**这些缓存，每次启动都要重新编译——实测 Windows-MCP 的
 * `tools` 包因此多花 **2.9 秒**，两个 MCP 服务串行启动从 7.8 秒劣化到 **16.2 秒**。
 *
 * 上一版打包时为了减体积，filter 里排除了 `__pycache__` / `*.pyc`，
 * 结果就是这个性能回归。而代价算下来完全不成比例：
 *
 * | 方案 | 增量体积 | 启动耗时 |
 * |---|---|---|
 * | 无 .pyc | 0 | 16.2 秒 |
 * | 只编译两个 MCP 包 | **0.5MB** | **7.8 秒** |
 * | 全量编译 site-packages | 64MB | 7.8 秒 |
 *
 * 全量编译和只编译两个包**耗时完全相同**——瓶颈就是这两个包自己。
 * 所以这里只编译它们，多出来 63.5MB 一分不花。
 *
 * ## 用法
 *
 *   node scripts/prepare-runtime.mjs            # 预编译 + 校验
 *   node scripts/prepare-runtime.mjs --check    # 只校验，不编译（打包前守门用）
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = join(ROOT, "packages", "desktop", "runtime");
const ENV_DIR = join(RUNTIME, "mcp-env");
const PYTHON = join(ENV_DIR, "Scripts", "python.exe");

/**
 * 必须预编译的包。
 *
 * 判定依据是「导入时有重活」——windows_mcp.tools 会连带导入 UI Automation
 * 相关的一整片依赖，scrapling 有大量解析器注册。其余依赖加起来影响很小，
 * 编译它们只是白白增大安装包。
 */
const CRITICAL_PACKAGES = ["windows_mcp", "scrapling"];

const checkOnly = process.argv.includes("--check");

/** 递归统计某目录下 .pyc 的数量与字节数。 */
function countPyc(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".pyc")) {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* 单个文件读不到不影响整体判断 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

if (!existsSync(PYTHON)) {
  fail(
    `找不到内置 Python：${PYTHON}`,
    "先构建运行时（见 docs/VERSION-MANAGEMENT.md 的内置运行时章节），或跳过内置打包。",
  );
}

const sitePackages = join(ENV_DIR, "Lib", "site-packages");
const targets = CRITICAL_PACKAGES.map((name) => join(sitePackages, name)).filter((p) => existsSync(p));

if (targets.length === 0) {
  fail(`在 site-packages 里找不到需要预编译的包：${CRITICAL_PACKAGES.join(", ")}`);
}

if (checkOnly) {
  // 守门模式：打包前确认 .pyc 在，缺了就直接失败——
  // 少了它的包能正常启动，只是慢一倍，装到用户机器上才发现就晚了。
  let missing = [];
  for (const target of targets) {
    const { files } = countPyc(target);
    if (files === 0) missing.push(target.replace(sitePackages + "\\", "").replace(sitePackages + "/", ""));
  }
  if (missing.length > 0) {
    fail(
      `这些包缺少 .pyc，启动会慢一倍：${missing.join(", ")}`,
      "运行 node scripts/prepare-runtime.mjs 预编译后再打包。",
    );
  }
  console.log("✓ 内置运行时已预编译，可以打包");
  process.exit(0);
}

console.log("[prepare-runtime] 预编译关键包（减少启动时的字节码编译）");
for (const target of targets) {
  const name = target.replace(sitePackages + "\\", "").replace(sitePackages + "/", "");
  const before = countPyc(target);
  const started = Date.now();
  try {
    // -q 静音逐文件输出；编译失败不抛（个别文件语法不兼容旧解释器是正常的），
    // 后面的数量校验才是判据。
    execFileSync(PYTHON, ["-m", "compileall", "-q", target], {
      stdio: "pipe",
      // 宿主环境可能注入 PYTHONDONTWRITEBYTECODE（本机 WorkBuddy 就会），
      // 那会让 compileall 静默地什么都不写——必须清掉。
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "", PYTHONPATH: "" },
    });
  } catch {
    /* 部分文件编译失败不影响可用的那部分 */
  }
  const after = countPyc(target);
  const delta = after.files - before.files;
  console.log(
    `  ${name}: ${delta} 个 .pyc（${(after.bytes / 1048576).toFixed(1)}MB，${Date.now() - started}ms）`,
  );
}

const total = targets.reduce((sum, t) => sum + countPyc(t).bytes, 0);
const all = countPyc(sitePackages);
console.log(
  `[prepare-runtime] 完成：关键包 ${(total / 1048576).toFixed(1)}MB / 全量 ${(all.bytes / 1048576).toFixed(1)}MB`,
);

// 自检：编译完必须真的有 .pyc，否则说明编译被环境变量挡住了。
for (const target of targets) {
  if (countPyc(target).files === 0) {
    fail(`预编译后 ${target} 仍没有 .pyc`, "检查 PYTHONDONTWRITEBYTECODE 是否被强制设置。");
  }
}