#!/usr/bin/env node
/**
 * 安装和鸣的分层 CI 本地钩子（执行计划 T6；层级定义见 ADR-1）。
 *
 * 为什么需要这个脚本：
 *   `.githooks/` 里的脚本会入库，但 git 不会自动启用它——`core.hooksPath`
 *   是**本地**配置（不随 clone 分发）。没有这一步，钩子就只是两个躺着的文件。
 *
 * 它做三件事：
 *   1. `git config core.hooksPath .githooks`（把钩子目录指到仓库内脚本）
 *   2. 给 `.githooks/*` 打可执行位（Windows 上 fs.chmod 只切只读属性，失败忽略）
 *   3. 打印当前配置、层级说明与撤销方式
 *
 * 用法：
 *   node scripts/install-hooks.mjs              # 安装（改本地 git 配置）
 *   node scripts/install-hooks.mjs --check      # 只检查，未安装时 exit 1
 *   node scripts/install-hooks.mjs --uninstall  # 撤销 core.hooksPath
 *
 * 风格与 scripts/design-audit.mjs 对齐：显式 ROOT、永不抛未捕获异常、失败 exit 1。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOOKS_DIR = ".githooks";
const HOOKS = ["pre-commit", "pre-push"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

/**
 * 调 git。默认失败即抛（由 main 的错误处理统一转成人话）；
 * `allowFail: true` 用于「读一个可能不存在的配置」这类场景。
 */
function git(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    const detail = String(e?.stderr ?? "").trim() || String(e?.message ?? e).trim();
    if (!allowFail) throw new Error(`git ${args.join(" ")} 失败：${detail}`);
    return { ok: false, out: "", detail };
  }
}

/** 钩子脚本必须先在盘上（它们随仓库入库，不是本脚本生成的）。 */
function ensureHookFiles() {
  const dir = path.join(ROOT, HOOKS_DIR);
  if (!fs.existsSync(dir)) {
    throw new Error(`找不到 ${HOOKS_DIR}/ 目录——钩子脚本要先入库（T6 的交付物之一）。`);
  }
  const missing = HOOKS.filter((name) => !fs.existsSync(path.join(dir, name)));
  if (missing.length) {
    throw new Error(`缺少钩子脚本：${missing.map((n) => `${HOOKS_DIR}/${n}`).join("、")}`);
  }
}

/**
 * Windows 没有 POSIX 可执行位：fs.chmod 在 NTFS 上基本只切只读属性，
 * 而且 Git for Windows 执行钩子走它自带的 sh，本来就不看可执行位。
 * 所以这里「尽力而为」：成功/失败都只打印一行，绝不因此让安装失败。
 */
function chmodHooks() {
  const rows = [];
  for (const name of HOOKS) {
    const file = path.join(ROOT, HOOKS_DIR, name);
    try {
      fs.chmodSync(file, 0o755);
      rows.push(`${HOOKS_DIR}/${name} → 0755`);
    } catch (e) {
      rows.push(`${HOOKS_DIR}/${name} 设置可执行位失败（Windows 可忽略）：${e?.code ?? e?.message ?? e}`);
    }
  }
  return rows;
}

/** 读当前配置；返回 "文件:行\t值" 形式，便于看清它到底在哪一层配置里。 */
function describeHooksPath() {
  const res = git(["config", "--show-origin", "--get", "core.hooksPath"], { allowFail: true });
  return res.ok && res.out ? res.out : "(未设置)";
}

function main() {
  const checkOnly = flag("check");
  const uninstall = flag("uninstall");

  const version = git(["--version"], { allowFail: true });
  if (!version.ok) {
    throw new Error("找不到可用的 git 命令：请先安装 Git，并确认当前终端里 `git --version` 能跑。");
  }

  ensureHookFiles();

  // ---- 撤销 --------------------------------------------------------------
  if (uninstall) {
    const before = git(["config", "--get", "core.hooksPath"], { allowFail: true });
    git(["config", "--unset", "core.hooksPath"], { allowFail: true });
    const after = git(["config", "--get", "core.hooksPath"], { allowFail: true });
    console.log(`[hooks] ${version.out}`);
    console.log(`[hooks] 已撤销 core.hooksPath（撤销前：${before.ok && before.out ? before.out : "未设置"}；现在：${after.ok && after.out ? after.out : "未设置"}）。`);
    if (after.ok && after.out) {
      console.log("[hooks] 注意：撤销后仍读到值，说明 --global / --system 里也配过；按 --show-origin 的来源逐个撤销。");
    }
    return 0;
  }

  // ---- 只检查（CI / HANDOFF 复核用） --------------------------------------
  if (checkOnly) {
    const now = git(["config", "--get", "core.hooksPath"], { allowFail: true });
    const installed = now.ok && now.out === HOOKS_DIR;
    console.log(`[hooks] ${version.out}`);
    console.log(`[hooks] core.hooksPath = ${now.ok && now.out ? now.out : "(未设置)"}；期望 ${HOOKS_DIR} → ${installed ? "已安装" : "未安装"}`);
    if (!installed) console.log("[hooks] 安装：node scripts/install-hooks.mjs");
    return installed ? 0 : 1;
  }

  // ---- 安装 --------------------------------------------------------------
  const before = describeHooksPath();
  git(["config", "core.hooksPath", HOOKS_DIR]);
  const after = git(["config", "--get", "core.hooksPath"], { allowFail: true });
  const chmodRows = chmodHooks();

  console.log(`[hooks] ${version.out}`);
  console.log("[hooks] 已把本地钩子路径指向仓库内脚本。");
  console.log(`[hooks] 修改前：${before}`);
  console.log(`[hooks] 现在：  ${after.ok && after.out ? after.out : "(空)"}`);
  for (const row of chmodRows) console.log(`[hooks]   · ${row}`);
  console.log("");
  console.log("[hooks] 生效的分层门禁（ADR-1：便宜的在提交前，贵的在夜里跑）：");
  console.log("  · pre-commit  L0  只查受影响包的 lint + typecheck，目标 < 30s");
  console.log("  · pre-push    L1  pnpm typecheck + @heming/web 单测，3–8 分钟");
  console.log("  · PR CI       L2  .github/workflows/verify.yml（构建 + 全量单测 + 确定性 eval）");
  console.log("  · nightly     L3  .github/workflows/eval-nightly.yml（真实模型 eval + design:audit）");
  console.log("");
  console.log("[hooks] 注意：core.hooksPath 是**本地** git 配置，不随 clone 分发；");
  console.log("        每位开发者、每个新克隆都要跑一次 `node scripts/install-hooks.mjs`。");
  console.log("[hooks] 撤销：git config --unset core.hooksPath");
  console.log("[hooks] 查看：git config --get core.hooksPath");
  console.log("[hooks] 单次绕过（仅紧急时）：git commit --no-verify / git push --no-verify");

  // 读回校验：设置成功才返回 0，避免「打印成功但实际没生效」。
  return after.ok && after.out === HOOKS_DIR ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = main();
} catch (e) {
  console.error("[hooks] 失败：" + (e?.message ?? e));
  exitCode = 1;
}
process.exit(exitCode);
