#!/usr/bin/env node
/**
 * 构建并签名全部 Web 插件包，落到 `module-catalog/<id>/<version>/module.tgz`（d.133）。
 *
 * 该目录随服务端部署包发布；客户端从 `GET /api/modules/<id>/<version>/module.tgz` 下载。
 * 安装包本身不携带任何插件——这里产出的只是云端目录内容。
 *
 * 用法：node scripts/build-modules.mjs [--only staff,infohub]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = join(ROOT, "packages", "modules");
const idsArg = process.argv.indexOf("--only");
const only = idsArg >= 0 ? String(process.argv[idsArg + 1] || "").split(",").filter(Boolean) : null;
const ids = only ?? ["staff", "automations", "infohub", "workflows"];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const id of ids) {
  const manifestPath = join(MODULES, id, "module.json");
  if (!existsSync(manifestPath)) {
    console.error(`[modules] 缺少 ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.id !== id || !manifest.version) {
    console.error(`[modules] ${id} 的 module.json id/version 不合法`);
    process.exit(1);
  }
  console.log(`\n[modules] 构建 ${id}@${manifest.version}`);
  run(["scripts/build-web-module.mjs", "--id", id]);
  const packArgs = [
    "scripts/pack-web-module.mjs",
    "--id",
    id,
    "--out",
    join("module-catalog", id, manifest.version, "module.tgz"),
  ];
  if (id === "infohub") {
    packArgs.push("--engine-app", "packages/infohub", "--engine-lib", ".tmp-engine-lib");
  }
  run(packArgs);
}
console.log(`\n[modules] 完成：${ids.join(", ")}`);
