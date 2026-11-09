#!/usr/bin/env node
/**
 * 打发布包：为「云端发布 + 用户自行安装」准备全部静态产物。
 *
 * 产物（release/）：
 *   index.html                        落地页（安装步骤 / 下载 / 校验）
 *   plugin.json                       和鸣插件清单（原样，供下载与目录目录）
 *   heming-workflow-kit-<ver>.zip     服务包（解压即用：dist + public + 启动脚本）
 *   latest.json                       机器可读的最新版本信息（版本/大小/sha256/URL）
 *   SHA256SUMS                        文件校验清单
 *
 * 为什么要把 dist 一起打进去：用户机器上不该再要求 `pnpm install && pnpm build`——
 * 解压后 `node dist/server/main.js` 就能跑；运行期零第三方依赖，所以 zip 很小。
 *
 * 用法：
 *   node scripts/build-release.mjs            # 构建 + 打包
 *   node scripts/build-release.mjs --skip-build
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "release");
const STAGE = join(RELEASE, "stage");
const DIST_URL = "http://47.92.39.184/updates/plugins/heming.workflow-kit";

const skipBuild = process.argv.includes("--skip-build");

function log(message = "") {
  console.log(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: false, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败（exit ${result.status}）`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sizeOf(path) {
  return statSync(path).size;
}

function copy(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      // 服务包不需要测试产物与 sourcemap；也不带任何本机数据。
      const base = path.split(/[\\/]/).pop() ?? "";
      if (base.endsWith(".test.js") || base.endsWith(".test.d.ts") || base.endsWith(".map")) return false;
      if (base === "node_modules" || base === "data" || base === ".git") return false;
      return true;
    },
  });
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function writeZip(sourceDir, folderName, zipPath) {
  // Windows 10+ 自带 bsdtar，支持 -a 按扩展名生成 zip；其他平台退回 python zipfile。
  const tar = spawnSync("tar", ["-a", "-c", "-f", zipPath, "-C", sourceDir, folderName], {
    cwd: ROOT,
    stdio: "pipe",
    shell: false,
  });
  if (tar.status === 0 && existsSync(zipPath)) return;
  const python = ["C:/Users/ADMIN/.workbuddy/binaries/python/envs/default/Scripts/python.exe", "python3", "python"].find(
    (candidate) => {
      const probe = spawnSync(candidate, ["-c", "import sys, zipfile; print(sys.version)"], { stdio: "pipe" });
      return probe.status === 0;
    },
  );
  if (!python) throw new Error("生成 zip 失败：找不到 tar 或 python");
  const script = [
    "import sys, zipfile, os",
    "src, folder, out = sys.argv[1], sys.argv[2], sys.argv[3]",
    "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
    "    base = os.path.join(src, folder)",
    "    for root, dirs, files in os.walk(base):",
    "        for name in sorted(files):",
    "            full = os.path.join(root, name)",
    "            z.write(full, os.path.relpath(full, src))",
    "",
  ].join("\n");
  const zipped = spawnSync(python, ["-c", script, sourceDir, folderName, zipPath], { stdio: "pipe" });
  if (zipped.status !== 0) throw new Error(`生成 zip 失败：${zipped.stderr?.toString().slice(0, 500)}`);
}

function landingHtml(info) {
  const fmt = (n) => Number(n).toLocaleString("zh-CN");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>工作流引擎（独立插件） v${info.version}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f7f7f4; color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.6; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 64px; }
  .badge { display: inline-block; font-size: 12px; color: #666; border: 1px solid #ddd; border-radius: 999px;
    padding: 2px 10px; margin-bottom: 14px; background: #fff; }
  h1 { font-size: 26px; margin: 0 0 8px; letter-spacing: 0.2px; }
  .sub { color: #666; font-size: 14px; margin: 0 0 26px; }
  .card { background: #fff; border: 1px solid #e5e5e0; border-radius: 12px; padding: 20px 22px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  p { margin: 0 0 10px; font-size: 14px; }
  ol { margin: 8px 0 0 20px; padding: 0; font-size: 14px; }
  li { margin: 6px 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; }
  code { background: #f1f1ee; border-radius: 4px; padding: 1px 5px; }
  pre { background: #f6f6f3; border: 1px solid #e8e8e3; border-radius: 8px; padding: 12px 14px; overflow: auto; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0 4px; }
  a.btn { display: inline-block; text-decoration: none; background: #1a1a1a; color: #fff; border-radius: 8px;
    padding: 9px 16px; font-size: 14px; }
  a.btn.ghost { background: #fff; color: #1a1a1a; border: 1px solid #d9d9d3; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; border-bottom: 1px solid #eee; padding: 7px 4px; vertical-align: top; }
  th { color: #666; font-weight: 500; }
  .muted { color: #888; font-size: 12.5px; }
  .sha { word-break: break-all; }
  ul.plain { margin: 6px 0 0 18px; padding: 0; font-size: 13.5px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="badge">独立插件 · v${info.version} · 不随和鸣安装包分发</div>
  <h1>工作流引擎</h1>
  <p class="sub">节点式自动化。在本机独立运行一个工作流服务（自带 Web 编辑器），和鸣通过 MCP 工具创建、运行与查看工作流。所有数据只在本机。</p>

  <div class="card">
    <h2>下载</h2>
    <table>
      <tr><th style="width:34%">服务包（含 Web 编辑器）</th><td><a href="${info.zipName}">${info.zipName}</a> · ${fmtSize(info.zipSize)}</td></tr>
      <tr><th>和鸣插件清单</th><td><a href="plugin.json">plugin.json</a> · ${fmtSize(info.pluginSize)}</td></tr>
      <tr><th>SHA256</th><td class="sha muted">${info.zipSha256}</td></tr>
    </table>
    <div class="actions">
      <a class="btn" href="${info.zipName}">下载服务包</a>
      <a class="btn ghost" href="plugin.json">下载 plugin.json</a>
      <a class="btn ghost" href="latest.json">latest.json</a>
    </div>
    <p class="muted">需要 Node.js 24 或更高版本。服务包运行期零第三方依赖，解压即用。</p>
  </div>

  <div class="card">
    <h2>安装步骤</h2>
    <ol>
      <li><b>启动本机服务</b>：解压服务包；Windows 双击 <code>start.cmd</code>，macOS/Linux 执行 <code>./start.sh</code>。
        看到「工作流引擎（独立插件）已启动 · http://127.0.0.1:8777」即就绪。关闭窗口即停止服务。</li>
      <li><b>安装和鸣插件</b>：和鸣 → 插件区 → 安装 → 导入刚下载的 <code>plugin.json</code>（或粘贴其内容）。</li>
      <li><b>连接并授权</b>：接口区找到「工作流引擎」→ 连接（首次会列出 26 个工具，默认全部关闭）→ 按需打开
        <code>workflow_*</code> / <code>node_types</code> 等工具（写类操作仍会走人工确认）。</li>
      <li><b>开始使用</b>：可直接打开编辑器 <a href="http://127.0.0.1:8777/">http://127.0.0.1:8777/</a> 手动搭流程，
        也可以让智能体用「工作流设计 / 运行工作流 / 从 n8n 迁移工作流」三个技能操作。</li>
    </ol>
    <p class="muted">不想用智能体：第 2、3 步可以跳过，编辑器本身就能建流程、点运行、看逐节点数据。</p>
  </div>

  <div class="card">
    <h2>能做什么</h2>
    <ul class="plain">
      <li>支持自然语言生成工作流（本机模型连接）与 Webhook 本机触发。</li>
      <li>智能体可自主闭环：发现凭据与节点参数 → 用 pinData 试跑 → 启用/发布 → 看执行状态（均通过 MCP 工具）。</li>
      <li>29 个节点：手动/定时（含 Cron）/Webhook/错误/子流程触发；条件、分支、合并、循环、等待；数据变换与过滤；
        HTTP、代码（node:vm 沙箱）、日期、加密、XML；大模型、任意 MCP 工具、本机通知。</li>
      <li>画布搭流程、拖线、参数表单、逐节点输入输出、执行记录、凭据（AES-256-GCM 加密）、导入导出（兼容 n8n 导出形状）、4 个起手模板。</li>
      <li>定时调度 15 秒轮询、串行执行、启动错过不补跑；执行记录 60 条 / 1MB 双淘汰。</li>
    </ul>
  </div>

  <div class="card">
    <h2>安全与数据</h2>
    <ul class="plain">
      <li>服务只监听 <code>127.0.0.1</code>，无鉴权（回环即边界）；不要把端口转发到公网。</li>
      <li>工作流、执行记录、凭据、通知都只在本机 <code>data/</code> 目录；不联网上报。</li>
      <li>出网只发生在 HTTP / 大模型 / MCP 工具节点（用户自己配置的地址）；代码节点没有网络、文件、进程入口。</li>
      <li>凭据是文件级加密（密钥 <code>data/secret.key</code>，与数据同目录）——能读整个目录的人仍可解密，如实说明。</li>
      <li>CORS 只放行和鸣客户端（app://heming）与本机页面；其它网页来源一律 403，云端网页版不能驱动本机插件。</li>
      <li>执行记录有体积上限：单条超过 64KB 截断、整条超过 1MB 丢最早数据并标记（状态/耗时/错误保留）。</li>
    </ul>
  </div>

  <div class="card">
    <h2>版本与校验</h2>
    <table>
      <tr><th style="width:34%">版本</th><td>${info.version}</td></tr>
      <tr><th>发布文件</th><td class="sha muted">${info.zipName} · ${fmt(info.zipSize)} B · sha256 ${info.zipSha256}</td></tr>
      <tr><th>插件清单</th><td class="sha muted">plugin.json · ${fmt(info.pluginSize)} B · sha256 ${info.pluginSha256}</td></tr>
      <tr><th>来源与许可</th><td>独立实现，未使用 n8n 源代码（n8n 为 Sustainable Use License 1.0，非开源许可）。</td></tr>
    </table>
  </div>
</div>
</body>
</html>
`;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version);
  const plugin = JSON.parse(readFileSync(join(ROOT, "plugin", "plugin.json"), "utf8"));
  if (plugin.version !== version) {
    throw new Error(`版本不一致：package.json=${version}，plugin.json=${plugin.version}`);
  }

  if (!skipBuild) {
    log("[1/5] 构建 dist…");
    // 直接用本地 tsc：不依赖 pnpm 在 PATH 上（Windows 上 spawnSync("pnpm") 解析不到 .cmd）。
    run(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);
  } else {
    log("[1/5] 跳过构建");
  }

  log("[2/5] 准备发布目录…");
  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  const folderName = `heming-workflow-kit-${version}`;
  const stageDir = join(STAGE, folderName);
  mkdirSync(stageDir, { recursive: true });

  copy(join(ROOT, "dist"), join(stageDir, "dist"));
  copy(join(ROOT, "public"), join(stageDir, "public"));
  copy(join(ROOT, "plugin"), join(stageDir, "plugin"));
  copy(join(ROOT, "docs"), join(stageDir, "docs"));
  copy(join(ROOT, "scripts"), join(stageDir, "scripts"));
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE.md", "start.cmd", "start.sh", "package.json"]) {
    cpSync(join(ROOT, file), join(stageDir, file));
  }

  log("[3/5] 生成服务 zip…");
  const zipName = `${folderName}.zip`;
  const zipPath = join(RELEASE, zipName);
  writeZip(STAGE, folderName, zipPath);

  log("[4/5] 生成插件清单与 latest.json…");
  cpSync(join(ROOT, "plugin", "plugin.json"), join(RELEASE, "plugin.json"));
  const zipSha256 = sha256(zipPath);
  const zipSize = sizeOf(zipPath);
  const pluginSha256 = sha256(join(RELEASE, "plugin.json"));
  const pluginSize = sizeOf(join(RELEASE, "plugin.json"));
  const info = {
    id: plugin.id,
    name: plugin.name,
    version,
    publishedAt: new Date().toISOString(),
    zipName,
    zipSize,
    zipSha256,
    pluginSize,
    pluginSha256,
    serviceZipUrl: `${DIST_URL}/${zipName}`,
    manifestUrl: `${DIST_URL}/plugin.json`,
    landingUrl: `${DIST_URL}/index.html`,
  };
  writeFileSync(
    join(RELEASE, "latest.json"),
    `${JSON.stringify(
      {
        id: info.id,
        name: info.name,
        version: info.version,
        publishedAt: info.publishedAt,
        files: {
          service: { name: zipName, size: zipSize, sha256: zipSha256, url: info.serviceZipUrl },
          manifest: { name: "plugin.json", size: pluginSize, sha256: pluginSha256, url: info.manifestUrl },
        },
        landing: info.landingUrl,
        minNode: "24",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(RELEASE, "SHA256SUMS"),
    `${zipSha256}  ${zipName}\n${pluginSha256}  plugin.json\n`,
    "utf8",
  );
  writeFileSync(join(RELEASE, "index.html"), landingHtml(info), "utf8");

  log("[5/5] 完成");
  log("");
  log(`  版本      ${version}`);
  log(`  服务包    ${zipName}  ${fmtSize(zipSize)}  sha256=${zipSha256.slice(0, 16)}…`);
  log(`  插件清单  plugin.json  ${fmtSize(pluginSize)}`);
  log(`  发布目录  ${RELEASE}`);
  log("");
  log("下一步：node scripts/publish-cloud.mjs（上传到云端并校验）");
  void readdirSync;
}

main();
