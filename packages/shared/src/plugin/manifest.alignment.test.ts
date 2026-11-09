import { describe, expect, it } from "vitest";
import { parsePluginManifestV5, PluginManifestInvalidError } from "./manifest.js";

/**
 * 清单 schema 与宿主实现的能力对齐（d.119 / d.122）。
 *
 * 背景：清单声明面比运行时宽，作者会写出「能过校验但永远不生效」的值。
 * 这里钉住已经对齐的边界：
 * 1. `position.anchor`：宿主目前只实现右下（`plugin-window.js`），清单层按实现收紧；
 * 2. `tray.items`：运行时支持 6 项，清单层补齐 `scaleUp` / `scaleDown`；
 * 3. `permissions.files`：预留字段、没有执行点——非空必须**明确警告不生效**；
 * 4. `meta.detail` 的路径形态（内联文本 vs 包内 .md 相对路径）。
 */

function bundleManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "heming.demo-widget",
    name: "示例小组件",
    version: "1.0.0",
    engines: { heming: "d.119" },
    distribution: "bundle",
    packageSha256: "0".repeat(64),
    permissions: { network: [], tools: "none", files: [], events: [], graphics: [], eval: false, chat: false },
    contributions: {
      desktopWidgets: [
        {
          id: "demo",
          name: "示例",
          entry: "files/index.html",
          width: 300,
          height: 420,
          ...overrides,
        },
      ],
    },
  };
}

function parse(list: Record<string, unknown>): ReturnType<typeof parsePluginManifestV5> {
  return parsePluginManifestV5({
    ...bundleManifest(),
    contributions: {
      desktopWidgets: [{ id: "demo", name: "示例", entry: "files/index.html", width: 300, height: 420, ...list }],
    },
  });
}

describe("清单能力对齐 · 桌面小组件", () => {
  it("tray.items 接受运行时就支持的 scaleUp / scaleDown", () => {
    const parsed = parse({ tray: { icon: "files/tray.png", items: ["toggle", "scaleUp", "scaleDown"] } });
    expect(parsed.manifest.contributions.desktopWidgets[0].tray?.items).toEqual([
      "toggle",
      "scaleUp",
      "scaleDown",
    ]);
  });

  it("tray.items 仍拒绝未知项", () => {
    expect(() => parse({ tray: { icon: "files/tray.png", items: ["explode"] } })).toThrow(
      PluginManifestInvalidError,
    );
  });

  it("position.anchor 只接受宿主实现的 bottom-right（其余值明确报错，不静默忽略）", () => {
    expect(
      parse({ position: { anchor: "bottom-right" } }).manifest.contributions.desktopWidgets[0].position?.anchor,
    ).toBe("bottom-right");
    for (const anchor of ["bottom-left", "top-right", "top-left", "center"]) {
      expect(() => parse({ position: { anchor } })).toThrow(/只支持 "bottom-right"/);
    }
  });
});

describe("清单能力对齐 · permissions.files 的诚实口径", () => {
  it("声明了 files 会明确警告「不生效」（避免用户误以为限制了文件访问）", () => {
    const parsed = parsePluginManifestV5({
      ...bundleManifest(),
      permissions: {
        network: [],
        tools: "none",
        files: ["notes"],
        events: [],
        graphics: [],
        eval: false,
        chat: false,
      },
    });
    expect(parsed.warnings.join("；")).toMatch(/permissions\.files.*不生效/);
  });

  it("空数组或省略不告警（兼容旧清单：files: [] 是历史默认写法）", () => {
    for (const files of [[], undefined]) {
      const parsed = parsePluginManifestV5({
        ...bundleManifest(),
        permissions: {
          network: [],
          tools: "none",
          ...(files === undefined ? {} : { files }),
          events: [],
          graphics: [],
          eval: false,
          chat: false,
        },
      });
      expect(parsed.warnings.join("；")).not.toMatch(/permissions\.files/);
    }
  });
});

describe("清单能力对齐 · meta.detail", () => {
  it("内联 Markdown 文本合法", () => {
    const parsed = parsePluginManifestV5({
      ...bundleManifest(),
      meta: { detail: "## 概述\n\n这是一段内联详情。" },
    });
    expect(parsed.manifest.meta.detail).toContain("概述");
  });

  it("包内 .md 相对路径合法", () => {
    const parsed = parsePluginManifestV5({ ...bundleManifest(), meta: { detail: "docs/detail.md" } });
    expect(parsed.manifest.meta.detail).toBe("docs/detail.md");
  });

  it("路径形态不得穿越包目录", () => {
    for (const detail of ["../secret.md", "docs/../../x.md", "/abs/detail.md"]) {
      expect(() => parsePluginManifestV5({ ...bundleManifest(), meta: { detail } })).toThrow(
        PluginManifestInvalidError,
      );
    }
  });
});
