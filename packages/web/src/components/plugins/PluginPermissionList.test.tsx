import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { parsePluginManifest, type PluginManifest } from "../../lib/plugins/index.js";
import { permissionViewOf } from "./viewModel.js";
import { PluginPermissionList } from "./PluginPermissionList.js";

/**
 * 权限清单里的两个新域（d.125）：
 * - `permissions.infohub`：允许沙箱插件经桥调用本机归档；
 * - `permissions.notify`：允许沙箱插件经桥发系统通知。
 * 两者默认关闭，未声明时必须明确显示「不允许」——这是安装时用户要看的边界。
 */

function manifest(permissions: Record<string, unknown>): PluginManifest {
  return parsePluginManifest({
    schemaVersion: 4,
    id: "heming.info-hub",
    name: "信息中枢",
    version: "1.0.0",
    permissions: { network: [], tools: "none", ...permissions },
    // 至少一类贡献非空；这里用技能，避免依赖 bundle 包文件。
    contributions: { skills: [{ name: "归档检索", instructions: "检索本机聊天记录。" }] },
  });
}

describe("permissionViewOf · 新权限域", () => {
  it("未声明时两个域都归一为 false（默认可信边界）", () => {
    const view = permissionViewOf(manifest({}));
    expect(view.infohub).toBe(false);
    expect(view.notify).toBe(false);
  });

  it("显式 true 原样投射到视图", () => {
    const view = permissionViewOf(manifest({ infohub: true, notify: true }));
    expect(view.infohub).toBe(true);
    expect(view.notify).toBe(true);
  });

  it("两个域互不影响（只开通知不等于能读归档）", () => {
    const view = permissionViewOf(manifest({ notify: true }));
    expect(view.infohub).toBe(false);
    expect(view.notify).toBe(true);
  });
});

describe("PluginPermissionList · 新权限行", () => {
  it("未声明：本机归档 / 桌面通知都显示不允许", () => {
    const subject = manifest({});
    render(<PluginPermissionList view={permissionViewOf(subject)} schemaVersion={subject.schemaVersion} />);
    expect(screen.getByText("本机归档")).toBeInTheDocument();
    expect(screen.getByText("桌面通知")).toBeInTheDocument();
    // 两个 dd 都是「不允许」：不能只写一个让人误以为另一项默认放行。
    expect(screen.getAllByText("不允许")).toHaveLength(2);
  });

  it("已声明：显示允许文案并点明走插件桥", () => {
    const subject = manifest({ infohub: true, notify: true });
    render(<PluginPermissionList view={permissionViewOf(subject)} schemaVersion={subject.schemaVersion} />);
    expect(screen.getByText("允许（经插件桥调用 infohub）")).toBeInTheDocument();
    expect(screen.getByText("允许（经插件桥发通知）")).toBeInTheDocument();
    expect(screen.queryByText("不允许")).toBeNull();
  });
});
