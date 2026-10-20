#!/usr/bin/env node
/**
 * 安装包产物目录解析：**打包输出与版本查看共用同一处判断**，避免两处各写一份。
 *
 * 优先级：
 * 1. 环境变量 `HEMING_RELEASE_DIR`（临时换目录用）；
 * 2. `D:\Heming\packages\desktop\release`（D 盘存在时用这里，不占 C 盘）；
 * 3. 仓库内 `packages/desktop/release`（没有 D 盘时的兜底，仍在 gitignore 内）。
 *
 * 约定：`packages/desktop/package.json` 里的 `build.directories.output` 保持 `release`
 * （保证仓库可移植），实际输出目录由 `scripts/build-desktop.mjs` 在打包时用
 * `--config.directories.output=<解析结果>` 注入——**打包必须走这个脚本**。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** D 盘默认产物目录（用户要求：安装包不占 C 盘）。 */
export const D_RELEASE_DIR = "D:/Heming/packages/desktop/release";

/** 仓库内兜底目录。 */
export const REPO_RELEASE_DIR = join(root, "packages", "desktop", "release");

function ensure(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就交给调用方报错 */
  }
  return dir;
}

/**
 * 解析当前该用哪个目录，并确保它存在。
 * @param {{ create?: boolean }} opts create=false 时不创建目录（仅查看时用）
 */
export function resolveReleaseDir(opts = {}) {
  const create = opts.create !== false;

  const env = process.env.HEMING_RELEASE_DIR?.trim();
  if (env) {
    const dir = resolve(env);
    return create ? ensure(dir) : dir;
  }

  // "D:" 存在即认为有 D 盘（Windows）；不存在则回落到仓库内
  if (existsSync("D:")) {
    return create ? ensure(D_RELEASE_DIR) : D_RELEASE_DIR;
  }

  return create ? ensure(REPO_RELEASE_DIR) : REPO_RELEASE_DIR;
}

/** 产物是否落在仓库外（用于提示「不再占 C 盘」）。 */
export function isOutsideRepo(dir) {
  return !dir.startsWith(root);
}