import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P2 迁移棘轮：**插件/模块业务代码不得再新增进本体**（2026-11-10，d.127）。
 *
 * 用户口径：「所有插件独立化，不和本体程序挂钩，不要占用本体程序代码」。
 * 现状是四个内置模块（幕僚/信息中枢/自动化/工作流）的页面与引擎仍在 web 包里，
 * 迁移（P2–P4）要先有基线：这份 JSON 记录「当前仍欠在身体里的文件」。
 *
 * 规则：
 * - 新增文件 → 红：新代码必须进 plugin-kit（插件包）而不是 packages/web；
 * - 删除文件 → 红：迁移完成就同步删基线条目，只减不增（防止基线悄悄过期）；
 * - 调整目录时改 `COUPLING_ROOTS` 与基线，两边必须同一口径。
 *
 * 这个测试不替代迁移，只保证「不继续变坏」。迁移清单见
 * docs/superpowers/specs/2026-11-10-d127-plugin-independence.md。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, "..", "..");

/** 仍属于模块业务的目录（相对 packages/web/src）。 */
const COUPLING_ROOTS = [
  "lib/modules",
  "lib/infohub",
  "lib/workflow",
  "components/workflow",
  "components/staff",
  "components/infohub",
  "components/automation",
];

/** 顶层模块页面（不在上面目录里的那几个）。 */
const COUPLING_FILES = [
  "components/WorkflowPage.tsx",
];

const BASELINE_FILE = join(HERE, "coupling-baseline.json");

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(WEB_SRC, path).split("\\").join("/"));
  }
}

function isGuardFile(file: string): boolean {
  // 基线/守卫自身、以及**宿主模块运行时**（loader/SDK/回退装配）都在被扫描目录里：
  // 它们是插件系统运行时代码，不属于「插件业务代码」，不能算耦合。
  return (
    file.endsWith("coupling-baseline.json") ||
    file.endsWith("coupling.test.ts") ||
    /^lib\/modules\/(runtime|host-sdk|host-sdk\.generated|webModules|useWebModule)(\.test)?\.[tj]sx?$/.test(file)
  );
}

function currentCouplingFiles(): string[] {
  const set = new Set<string>();
  for (const file of COUPLING_FILES) {
    try {
      statSync(join(WEB_SRC, file));
      set.add(file);
    } catch {
      /* 已迁走 */
    }
  }
  for (const root of COUPLING_ROOTS) {
    try {
      const out: string[] = [];
      walk(join(WEB_SRC, root), out);
      for (const file of out) set.add(file);
    } catch {
      /* 目录已迁走 */
    }
  }
  return [...set].filter((file) => !isGuardFile(file)).sort();
}

function baselineFiles(): string[] {
  const raw = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { files?: unknown };
  return Array.isArray(raw.files) ? (raw.files as string[]) : [];
}

describe("插件独立化：本体耦合基线（只减不增）", () => {
  it("没有新增的模块/插件业务代码混进本体", () => {
    const baseline = new Set(baselineFiles());
    const added = currentCouplingFiles().filter((file) => !baseline.has(file));
    expect(
      added,
      [
        "以下文件属于插件/模块业务代码，不应再进入 packages/web（本体）：",
        ...added,
        "请把实现放进 plugin-kit/plugins/<id>（插件包），或先改 d.127 迁移方案。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("基线不含已迁走/已删除的文件（迁出后同步收紧基线）", () => {
    const current = new Set(currentCouplingFiles());
    const stale = baselineFiles().filter((file) => !current.has(file));
    expect(
      stale,
      [
        "以下文件已不存在，但仍在 coupling-baseline.json 里：",
        ...stale,
        "迁移/删除完成后请同步删除基线条目（棘轮只减不增）。",
      ].join("\n"),
    ).toEqual([]);
  });
});
