#!/usr/bin/env node
/**
 * 桌面安装包打包入口（替代直接跑 electron-builder）。
 *
 * 做三件 electron-builder 自己不知道的事：
 * 1. 把 5 段版本注入 `HEMING_APP_VERSION`，产物名与「应用和功能」里的显示名都用它
 *    （`build.nsis.artifactName` / `uninstallDisplayName` 里写 `${env.HEMING_APP_VERSION}`）；
 * 2. 自动探测 node_modules 里已解包的 electron 并传 `--config.electronDist`——
 *    本机为省 C 盘删掉了 electron 下载 zip，缺这一项时 electron-builder 会去联网重下并失败；
 * 3. 把输出目录指向 `scripts/release-dir.mjs` 解析出的位置（默认 D 盘，不占 C 盘）；
 * 4. 其余参数原样透传，例如 `node scripts/build-desktop.mjs --win nsis`。
 * 5. 内置运行时存在时，先跑 `prepare-runtime.mjs --check` 确认 .pyc 已预编译。
 *    缺了它包照样能启动，只是 MCP 首次连接慢一倍（16.2s vs 7.8s），
 *    装到用户机器上才发现就太晚了——所以在打包这一步拦住。
 *
 * 用法：node scripts/build-desktop.mjs [--win nsis] [--config.xxx=yyy]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isOutsideRepo, resolveReleaseDir } from "./release-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "packages", "desktop");

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const version = pkg.hemingVersion ?? pkg.version;
if (!version) {
  console.error("读不到版本号：packages/desktop/package.json 缺 hemingVersion 与 version");
  process.exit(1);
}

// 内置运行时的字节码校验（见文件头注释第 5 条）。
// 运行时目录不存在时跳过——那是「不内置」的构建方式，不该被拦。
if (existsSync(join(desktopDir, "runtime", "mcp-env"))) {
  const prepared = spawnSync(process.execPath, [join(root, "scripts", "prepare-runtime.mjs"), "--check"], {
    stdio: "inherit",
  });
  if (prepared.status !== 0) {
    console.error("[build-desktop] 内置运行时未预编译，已中止打包（会显著拖慢 MCP 启动）");
    process.exit(1);
  }
}

// web-dist 是打包的**输入**，不是产物：直接跑本脚本时很容易忘了先跑
// build-desktop-web.mjs（r64 就因此把上一版 UI 打进了新版本号里——安装包写 d.75，
// 界面里还显示 d.74）。这里强制先重建一次；dist:desktop 里会重复调用，只多几秒。
const webBuilt = spawnSync(process.execPath, [join(root, "scripts", "build-desktop-web.mjs")], {
  stdio: "inherit",
});
if (webBuilt.status !== 0) {
  console.error("[build-desktop] web-dist 重建失败，已中止打包（旧产物不能当新版本发）");
  process.exit(1);
}

const args = process.argv.slice(2);

/** 找 node_modules/.pnpm 下已解包的 electron 目录（有 electron.exe/electron 才是完整包）。 */
function detectElectronDist() {
  const pnpmDir = join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const candidates = readdirSync(pnpmDir)
    .filter((name) => name.startsWith("electron@"))
    .map((name) => join(pnpmDir, name, "node_modules", "electron", "dist"))
    .filter((dist) => existsSync(dist));
  return candidates[0] ?? null;
}

// 输出目录：调用方显式指定则尊重，否则用统一解析（D 盘优先）
const releaseDir = resolveReleaseDir({ create: true });
if (!args.some((a) => a.startsWith("--config.directories.output"))) {
  args.push(`--config.directories.output=${releaseDir}`);
}
console.log(
  `[build-desktop] 产物输出：${releaseDir}${isOutsideRepo(releaseDir) ? "（仓库外，不占 C 盘）" : ""}`,
);

// —— 旧产物让位 ——
//
// electron-builder 打包前会**清空**上一版的 `win-unpacked`。而我们的
// `win-unpacked/resources/runtime` 里有 7000+ 个小文件（5026 个 .py），
// 逐个 unlink 在本机实测只有 ~1.6 文件/秒（带会话 shim）/ 72 文件/秒（不带），
// 清空一次要 **1 小时以上**——打包时间全耗在这，而且没有任何产出。
//
// 实测数据（300 个小文件）：
//   创建：C 盘 56ms / D 盘 108ms   → 很快
//   删除：C 盘 89168ms（带 shim）  → 极慢
//
// 解法：把旧目录**改名**移开。同盘改名是元数据操作，瞬时完成，
// 让 electron-builder 面对一个不存在的目录，从根上跳过删除。
// 移走的内容在打包成功后清理（那时已经不再需要它的完整性）。
const unpackedDir = join(releaseDir, "win-unpacked");
if (existsSync(unpackedDir)) {
  const parked = `${unpackedDir}.stale-${Date.now()}`;
  try {
    renameSync(unpackedDir, parked);
    console.log("[build-desktop] 旧 win-unpacked 已改名让位（避免逐文件删除，耗时可达 1 小时）");
    // 记下路径，打包结束后再清理
    globalThis.__staleUnpacked = parked;
  } catch (err) {
    // 让位失败不致命：electron-builder 会自己清，只是慢
    console.warn(`[build-desktop] 旧 win-unpacked 改名失败，将由 electron-builder 自行清理（会慢）：${err.message}`);
  }
}

const alreadyPointed = args.some((a) => a.startsWith("--config.electronDist"));
if (!alreadyPointed) {
  const dist = detectElectronDist();
  if (dist) {
    args.push(`--config.electronDist=${dist}`);
    console.log(`[build-desktop] 使用本地已解包的 electron：${dist.replace(root, ".")}`);
  } else {
    console.warn("[build-desktop] 未找到本地 electron 解包目录，将尝试联网下载（可能很慢或失败）");
  }
}

// 更新元数据：electron-builder **默认不生成** latest.yml / .blockmap 之外的
// 更新清单，客户端就拿不到「有没有新版本」的依据——表现是永远提示「已是最新」，
// 界面上与正常无差别，极难排查。
//
// `always` 而不是 `never`：本机出包也不真去上传（provider 配的是 generic，
// electron-builder 不会主动 PUT），但会把 latest.yml 落到产物目录，
// 之后由 scripts/publish-update.sh 传到云服务器的 /opt/heming/updates。
if (!args.some((a) => a === "--publish" || a.startsWith("--publish="))) {
  args.push("--publish", "always");
}

const bin = join(desktopDir, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.CMD" : "electron-builder");
if (!existsSync(bin)) {
  console.error(`找不到 electron-builder 可执行文件：${bin}`);
  process.exit(1);
}

console.log(`[build-desktop] 版本 ${version}（semver ${pkg.version}）`);
const child = spawn(bin, args, {
  cwd: desktopDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, HEMING_APP_VERSION: version },
});
child.on("exit", (code) => {
  // 清理移走的旧产物。
  //
  // **必须异步**：删 7000+ 个小文件在本机实测要 1 小时以上（~1.6 文件/秒），
  // 同步等它等于把「打包慢」的问题从打包阶段挪到收尾阶段——没解决任何事。
  // 这里 fire-and-forget：删不完也不影响本次产出，下一轮打包会再把它移开一次。
  //
  // 删不掉也没关系：那是旧版本残留，不是当前产物。
  const stale = globalThis.__staleUnpacked;
  if (stale && existsSync(stale)) {
    const rm = spawn(process.execPath, [
      "-e",
      `require("fs").rmSync(${JSON.stringify(stale)}, {recursive:true, force:true})`,
    ], { stdio: "ignore", detached: true });
    rm.unref();
    console.log(`[build-desktop] 旧产物在后台清理（可能较慢，不影响本次产物）：${stale}`);
  }
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  console.error(`[build-desktop] 启动失败：${err.message}`);
  process.exit(1);
});