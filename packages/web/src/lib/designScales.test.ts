import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 设计刻度的回归守卫（d.141）。
 *
 * 背景：审计（docs/UIUX-AUDIT-2026-11-13.md）里最难收的是「六维度无刻度」——
 * 字号 `text-[11px]/[12px]/[13px]` 混写到 641 处、动效 100/150/160/200/280/300/500 七值、
 * 图标 10/11/13/15/17/22 散落。d.141 用 codemod 一次性换成刻度类
 * （`text-ui-*` / `text-num-*` / `duration-fast|base|slow` / 图标 12·14·16·18·20·24），
 * 但「换一次」不等于「以后不再写」——这类回归没有任何运行时表现，只有下一个读到
 * 那一行的人才会发现，所以钉成测试。
 *
 * 刻度定义在 `src/index.css` 的 `@theme`；新增刻度请先加 token，再用刻度类。
 */

const SRC = "src";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      // generated/ 是构建产物（changelog 快照），历史文本里允许出现旧类名。
      // 注意：按目录名判断，不要拿拼好的路径去匹配 `generated[\\/]`——
      // 目录自身结尾没有分隔符（Windows 反斜杠），会漏。
      if (ent.name === "generated") continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = sourceFiles(join(process.cwd(), SRC));

describe("设计刻度：字号只用 text-ui-* / text-num-*", () => {
  it("源码里不再出现 text-[Npx] 字面量（除测试与 generated）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/text-\[\d+px\]/g);
      if (matches) offenders.push(`${file}: ${[...new Set(matches)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("index.css 的主题里确实声明了刻度 token（防止类名还在、token 被删）", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    for (const token of [
      "--text-ui-xs",
      "--text-ui-sm",
      "--text-ui-md",
      "--text-ui-base",
      "--text-ui-lg",
      "--text-ui-xl",
      "--text-num-sm",
      "--text-num-md",
      "--text-num-lg",
      "--transition-duration-fast",
      "--transition-duration-base",
      "--transition-duration-slow",
      "--ease-out-soft",
    ]) {
      expect(css, `缺少 @theme token ${token}`).toContain(token);
    }
  });
});

describe("设计刻度：动效只用三档", () => {
  it("源码里不再出现 duration-100/150/160/200/280/300/500", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/\bduration-(?:100|150|160|200|280|300|500)\b/g);
      if (matches) offenders.push(`${file}: ${[...new Set(matches)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("设计刻度：图标尺寸落在 12/14/16/18/20/24", () => {
  it("width/height 成对出现时同值且落在栅格上", () => {
    const grid = new Set([12, 14, 16, 18, 20, 24]);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/width=\{(\d+)\}\s+height=\{(\d+)\}/g)) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (w !== h || !grid.has(w)) offenders.push(`${file}: width={${w}} height={${h}}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});