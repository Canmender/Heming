/**
 * 插件页面（d.124）在真实 App 壳里的接线（精简外壳后入口在顶栏「页面菜单」）：
 *   1. 装一个带 `contributions.page` 的声明式插件 → 页面菜单里出现入口；
 *   2. 点入口 → 路由进入插件页面（渲染宿主按 blocks 渲染的声明式页）；
 *   3. 卸载后入口消失、停在页上时拨回主页。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken } from "./lib/api.js";
import { pluginStore } from "./lib/plugins/store.js";
import { skillPool } from "./lib/skills/index.js";
import { resetWidgetsStore } from "./lib/widgets/store.js";

vi.mock("./lib/appPresence.js", () => ({ useAppPresence: () => undefined }));
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => {
      onDone();
    }, [onDone]);
    return null;
  },
}));
vi.mock("./lib/ws.js", () => ({
  connectWs: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
}));

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/me") return Promise.resolve(jsonRes(alice));
    if (url === "/api/files/usage")
      return Promise.resolve(jsonRes({ used: 0, quota: 200 * 1024 * 1024 }));
    if (url === "/api/files") return Promise.resolve(jsonRes([]));
    if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
    if (url === "/api/team") return Promise.resolve(jsonRes({ members: [], onlineCount: 0 }));
    if (url === "/api/team/activities") return Promise.resolve(jsonRes({ activities: [] }));
    if (url === "/api/agents") return Promise.resolve(jsonRes([]));
    // 默认页是会话：AssistantPage/Sidebar 首载会拉会话列表
    if (url === "/api/conversations" || url.startsWith("/api/conversations?"))
      return Promise.resolve(jsonRes([]));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

const PAGE_PLUGIN_ID = "acme.page-kit";
const PAGE_MANIFEST = {
  schemaVersion: 5,
  id: PAGE_PLUGIN_ID,
  name: "页面示例包",
  version: "1.0.0",
  engines: { heming: "d.0" },
  contributions: {
    skills: [{ name: "页面示例技能", instructions: "做点什么。" }],
    page: {
      title: "采集看板",
      icon: "chart",
      summary: "本机采集状态",
      blocks: [
        { type: "markdown", title: "怎么用", text: "先填来源，再开始同步。" },
        { type: "stats", items: [{ label: "已采集", value: "12 条" }] },
      ],
    },
  },
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  setToken("t1");
  mockFetch();
  // 单例 store / 技能池在测试间复用：清空存储后重新读一遍，避免上一例的插件残留。
  skillPool.reload();
  pluginStore.reload();
  resetWidgetsStore();
  useAuthStore.setState({ token: "t1", user: alice, status: "authed", error: null });
  useUiStore.setState({ page: "home", pageView: null });
});

afterEach(() => {
  cleanup();
  pluginStore.remove(PAGE_PLUGIN_ID);
  useUiStore.setState({ page: "home" });
});

/** 打开顶栏「页面菜单」，返回菜单节点。 */
async function openPageMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "打开页面菜单" }));
  return screen.findByRole("menu", { name: "页面菜单" });
}

describe("插件页面接线（d.124，入口在顶栏页面菜单）", () => {
  it("装好带页面的插件后页面菜单出现入口，点进去渲染声明式页面", async () => {
    render(<App />);
    await screen.findByTestId("topbar");

    // 先确认没装时菜单里没有入口
    const before = await openPageMenu();
    expect(within(before).queryByRole("menuitem", { name: "采集看板" })).toBeNull();
    // Esc 关闭菜单（菜单容器接键，冒泡到 window 的实现同样生效）
    fireEvent.keyDown(before, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "页面菜单" })).toBeNull(),
    );

    pluginStore.install(JSON.stringify(PAGE_MANIFEST));

    const menu = await openPageMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "采集看板" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe(`plugin:${PAGE_PLUGIN_ID}`));
    // 页面内容来自清单 blocks（标题/统计块）
    expect(await screen.findByText("本机采集状态")).toBeTruthy();
    expect(await screen.findByText("已采集")).toBeTruthy();
    expect(screen.getByText("12 条")).toBeTruthy();
  });

  it("卸载后入口消失；正停在该页时回主页，不渲染不存在的页面", async () => {
    pluginStore.install(JSON.stringify(PAGE_MANIFEST));
    render(<App />);
    await screen.findByTestId("topbar");
    const menu = await openPageMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "采集看板" }));
    await waitFor(() => expect(useUiStore.getState().page).toBe(`plugin:${PAGE_PLUGIN_ID}`));

    pluginStore.remove(PAGE_PLUGIN_ID);

    await waitFor(() => expect(useUiStore.getState().page).toBe("home"));
    expect(screen.queryByRole("menuitem", { name: "采集看板" })).toBeNull();
    // 重新打开菜单：入口确实没了
    const after = await openPageMenu();
    expect(within(after).queryByRole("menuitem", { name: "采集看板" })).toBeNull();
  });
});
