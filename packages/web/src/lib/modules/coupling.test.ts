import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 插件独立化**最终守卫**（d.131 M6，2026-11-11）。
 *
 * 迁移前的棘轮（coupling-baseline.json 记录 143 个仍在本体的模块文件）已随四个模块迁出而清零。
 * 现在改为不变量守卫：
 * 1. 本体里不得再出现任何模块实现目录/页面（staff / infohub / automation / workflow）；
 * 2. 模块实现只允许存在于 `packages/modules/<id>`，并带 `module.json` 的 web 入口；
 * 3. 本体的 web 源码不得直接 import 模块包（只能由 loader 在运行时 `import()`）。
 *
 * 背景与迁移表：docs/superpowers/specs/2026-11-10-d131-module-packages.md。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, "..", "..");
const REPO = resolve(WEB_SRC, "..", "..", "..");
const MODULES_DIR = join(REPO, "packages", "modules");

/** 已迁出的本体实现路径（相对 packages/web/src）。 */
const MIGRATED_PATHS = [
  "lib/staff",
  "lib/automation",
  "lib/workflow",
  "components/StaffPage.tsx",
  "components/StaffHomeCard.tsx",
  "components/AutomationPage.tsx",
  "components/InfohubPage.tsx",
  "components/InfohubHomeCard.tsx",
  "components/workflow",
  "components/WorkflowPage.tsx",
];

const MODULE_IDS = ["staff", "automations", "infohub", "workflows"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("插件独立化：模块实现不得再进本体（基线已归零）", () => {
  it("已迁出的模块目录/页面在本体里不存在", () => {
    for (const rel of MIGRATED_PATHS) {
      expect(existsSync(join(WEB_SRC, rel)), `本体不应再有模块实现：${rel}`).toBe(false);
    }
  });

  it("耦合基线已归零（保留空文件作为历史锚点）", () => {
    const raw = JSON.parse(readFileSync(join(HERE, "coupling-baseline.json"), "utf8"));
    expect(Array.isArray(raw.files)).toBe(true);
    expect(raw.files).toEqual([]);
  });

  it("四个模块包都在 packages/modules，且声明 web 入口", () => {
    for (const id of MODULE_IDS) {
      const manifest = JSON.parse(readFileSync(join(MODULES_DIR, id, "module.json"), "utf8"));
      expect(manifest.id).toBe(id);
      expect(manifest.distribution).toBe("module");
      expect(manifest.web?.entry).toMatch(/^files\/web\/.+\.js$/);
      expect(Array.isArray(manifest.web.contributions)).toBe(true);
    }
  });

  it("本体 web 源码不得直接 import 模块包（只能运行时加载）", () => {
    const offenders = [];
    for (const file of walk(WEB_SRC)) {
      const rel = relative(WEB_SRC, file).split("\\").join("/");
      if (rel.startsWith("test-setup")) continue;
      const text = readFileSync(file, "utf8");
      if (/from\s+["'](@heming\/sdk|packages\/modules)/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
