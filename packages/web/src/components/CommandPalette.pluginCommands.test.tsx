import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette.js";
import type { PluginCommandInfo } from "../lib/plugins/index.js";
import { useUiStore } from "../store/ui.js";
import { useInfohubStore } from "../lib/infohub/store.js";

/**
 * d.64 T3b：命令面板的「插件命令」分组与三种 target 的分发。
 *
 * 这里把两个上游换成可控桩：
 * - `pluginStore.commands()`：命令列表由用例给（含「停用后列表为空」的场景）；
 * - `skillPool.list()`：给一条固定技能，验证 target=skill 时能把技能 id 投进意图。
 * 面板每次打开都现读 store，所以「停用后命令消失」用「桩返回空」等价表达。
 */

const commandsStub = vi.hoisted(() => ({ current: [] as PluginCommandInfo[] }));
vi.mock("../lib/plugins/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plugins/index.js")>();
  return {
    ...actual,
    pluginStore: { commands: () => commandsStub.current },
  };
});

const skillsStub = vi.hoisted(() => ({
  current: [{ id: "skill-1", name: "出行建议" }] as { id: string; name: string }[],
}));
vi.mock("../lib/skills/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/skills/index.js")>();
  return {
    ...actual,
    skillPool: { list: () => skillsStub.current },
  };
});

// 名册请求给桩，避免打真实网络。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchTeam: vi.fn(async () => ({ members: [], onlineCount: 0 })) };
});

const searchBox = () => screen.getByLabelText("搜索页面、动作与成员");

function cmd(over: Partial<PluginCommandInfo> = {}): PluginCommandInfo {
  return {
    id: "plugin:acme.weather:export-week",
    pluginId: "acme.weather",
    pluginName: "天气能力包",
    title: "导出本周天气",
    description: "把本周天气导出为 Markdown",
    keywords: ["导出", "周报"],
    target: { kind: "page", page: "home" },
    ...over,
  };
}

function resetStores() {
  localStorage.clear();
  useUiStore.setState({ page: "home", paletteIntent: null });
  useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
}

beforeEach(() => {
  resetStores();
  commandsStub.current = [cmd()];
});

afterEach(() => {
  cleanup();
  commandsStub.current = [];
});

describe("命令面板 · 插件命令分组", () => {
  it("输入命中后出现「插件命令」组，标签是标题、副标题带插件名", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });

    expect(screen.getByText("插件命令")).toBeInTheDocument();
    const item = screen.getByRole("option", { name: "选择 导出本周天气" });
    expect(item.textContent).toContain("天气能力包");
    expect(item.textContent).toContain("Markdown");
  });

  it("按描述命中（标题里没有该词）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "Markdown" } });
    expect(screen.getByRole("option", { name: "选择 导出本周天气" })).toBeInTheDocument();
  });

  it("按关键词命中", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "周报" } });
    expect(screen.getByRole("option", { name: "选择 导出本周天气" })).toBeInTheDocument();
  });

  it("插件停用后（store 不再返回命令）该组消失", () => {
    commandsStub.current = [];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    expect(screen.queryByText("插件命令")).not.toBeInTheDocument();
  });
});

describe("命令面板 · 插件命令的三种 target 分发", () => {
  it("page → 切到目标页并关闭面板", () => {
    const onClose = vi.fn();
    commandsStub.current = [cmd({ target: { kind: "page", page: "memory" } })];
    render(<CommandPalette onClose={onClose} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));

    expect(useUiStore.getState().page).toBe("memory");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("page id 非法时忽略切页（不把任意字符串塞进 store）", () => {
    commandsStub.current = [cmd({ target: { kind: "page", page: "not-a-page" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));
    expect(useUiStore.getState().page).toBe("home");
  });

  it("skill → 查 id 成功则投 focus-skill 意图并切技能区", async () => {
    commandsStub.current = [cmd({ target: { kind: "skill", name: "出行建议" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));

    // 技能区已并入插件区：页面落到插件区，并投递「技能」视图意图
    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().pageView).toBe("skills");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "focus-skill",
      data: { id: "skill-1" },
    });
  });

  it("skill 查不到 id 时只切技能区、不投意图", async () => {
    commandsStub.current = [cmd({ target: { kind: "skill", name: "不存在的技能" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().pageView).toBe("skills");
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("plugin → 投 open-plugin 意图并切插件区", async () => {
    commandsStub.current = [cmd({ target: { kind: "plugin" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "acme.weather" },
    });
  });

  it("键盘 Enter 也能执行当前选中的插件命令（键盘导航没回退）", () => {
    commandsStub.current = [cmd({ target: { kind: "page", page: "settings" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    // 只剩这一条结果，光标默认在第一项
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(useUiStore.getState().page).toBe("settings");
  });
});

describe("命令面板 · d.108 新增 target（settings / unit）", () => {
  it("settings → 切设置页并投「定位设置卡」意图", async () => {
    commandsStub.current = [cmd({ target: { kind: "settings", card: "theme-mode" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe("settings"));
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "focus-settings",
      data: { card: "theme-mode" },
    });
  });

  it("unit → 切插件区并复用 open-plugin 意图携带单元 id", async () => {
    commandsStub.current = [cmd({ target: { kind: "unit", unitId: "heming.pet" } })];
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "导出" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 导出本周天气" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "heming.pet" },
    });
  });
});
