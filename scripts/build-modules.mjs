#!/usr/bin/env node
/**
 * 构建并签名全部 Web 插件包，落到 `module-catalog/<id>/<version>/module.tgz`（d.133）。
 *
 * 该目录随服务端部署包发布；客户端从 `GET /api/modules/<id>/<version>/module.tgz` 下载。
 * 安装包本身不携带任何插件——这里产出的只是云端目录内容。
 *
 * 首方内置模块的**包 id 带 `heming.` 前缀**（`heming.infohub` / `heming.automations`），
 * 而 `packages/modules/` 下的源目录保持短名——两者在 TARGETS 里显式对应，构建/打包脚本
 * 用 `--id`（包 id）+ `--dir`（源目录）两个参数区分，产物与目录条目都按包 id 落盘。
 *
 * 用法：node scripts/build-modules.mjs [--only heming.infohub,automations]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = join(ROOT, "packages", "modules");

/** 源目录 → 包 id（顺序即构建顺序）；`engine` 与 server `DEFAULT_MODULES` 口径一致。 */
const TARGETS = [
  { dir: "automations", id: "heming.automations", engine: null },
  { dir: "infohub", id: "heming.infohub", engine: "heming.infohub" },
];

const onlyArg = process.argv.indexOf("--only");
const only =
  onlyArg >= 0
    ? String(process.argv[onlyArg + 1] || "")
        .split(",")
        .filter(Boolean)
    : null;
// `--only` 同时接受源目录名与包 id（兼容旧命令与服务端目录名）。
const targets = only
  ? TARGETS.filter((target) => only.includes(target.dir) || only.includes(target.id))
  : TARGETS;
if (targets.length === 0) {
  console.error(`[modules] --only 里没有可构建的模块：${only.join(",")}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const { dir, id, engine } of targets) {
  const manifestPath = join(MODULES, dir, "module.json");
  if (!existsSync(manifestPath)) {
    console.error(`[modules] 缺少 ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.id !== id || !manifest.version) {
    console.error(`[modules] ${dir}/module.json 的 id 应为 ${id}（实际 ${manifest.id}）或缺少 version`);
    process.exit(1);
  }
  console.log(`\n[modules] 构建 ${id}@${manifest.version}（源目录 ${dir}）`);
  run(["scripts/build-web-module.mjs", "--id", id, "--dir", dir]);
  const packArgs = [
    "scripts/pack-web-module.mjs",
    "--id",
    id,
    "--dir",
    dir,
    "--out",
    join("module-catalog", id, manifest.version, "module.tgz"),
  ];
  if (dir === "infohub") {
    packArgs.push("--engine-app", "packages/infohub", "--engine-lib", ".tmp-engine-lib");
  }
  run(packArgs);

  // d.137：目录条目随包一起产出。
  // 服务端 `moduleCatalog.list()` 只认 `<id>/<version>/module.json`，没有它时回落到
  // 编译进 server 的 DEFAULT_MODULES——版本号/描述会停在发服务器那一刻，云端已经
  // 换了新包、接口却还报旧版本。把条目写进构建产物，部署时随 module-catalog 一起上，
  // 接口读到的就是真实产物本身。
  const outDir = join(ROOT, "module-catalog", id, manifest.version);
  mkdirSync(outDir, { recursive: true });
  const entry = {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? "",
    author: manifest.author ?? "",
    // 与 DEFAULT_MODULES 保持一致：目前只有信息中枢带独立引擎（业已并入同一个包）。
    engine,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "module.json"), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  console.log(`[modules] 目录条目 ${join("module-catalog", id, manifest.version, "module.json")}`);
}
console.log(`\n[modules] 完成：${targets.map((target) => target.id).join(", ")}`);
