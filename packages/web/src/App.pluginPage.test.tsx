/**
 * 插件页面（d.124）在真实 App 壳里的接线：
 *   1. 装一个带 `contributions.page` 的声明式插件 → 导航轨末位出现入口；
 *   2. 点入口 → 路由进入插件页面（渲染宿主按 blocks 渲染的声明式页）；
 *   3. 卸载后入口消失、停在页上时拨回主页。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  useUiStore.setState({ page: "home", navMode: "pinned", navOpen: false, pageView: null });
});

afterEach(() => {
  cleanup();
  pluginStore.remove(PAGE_PLUGIN_ID);
  useUiStore.setState({ navMode: "pinned", navOpen: false, page: "home" });
});

describe("插件页面接线（d.124）", () => {
  it("装好带页面的插件后导航出现入口，点进去渲染声明式页面", async () => {
    render(<App />);
    // 先确认没装时没有入口
    await screen.findByRole("button", { name: "主页 Alt1" });
    expect(screen.queryByRole("button", { name: "采集看板" })).toBeNull();

    pluginStore.install(JSON.stringify(PAGE_MANIFEST));

    const entry = await screen.findByRole("button", { name: "采集看板" });
    fireEvent.click(entry);

    await waitFor(() => expect(useUiStore.getState().page).toBe(`plugin:${PAGE_PLUGIN_ID}`));
    // 页面内容来自清单 blocks（标题/统计块）
    expect(await screen.findByText("本机采集状态")).toBeTruthy();
    expect(await screen.findByText("已采集")).toBeTruthy();
    expect(screen.getByText("12 条")).toBeTruthy();
  });

  it("卸载后入口消失；正停在该页时回主页，不渲染不存在的页面", async () => {
    pluginStore.install(JSON.stringify(PAGE_MANIFEST));
    render(<App />);
    const entry = await screen.findByRole("button", { name: "采集看板" });
    fireEvent.click(entry);
    await waitFor(() => expect(useUiStore.getState().page).toBe(`plugin:${PAGE_PLUGIN_ID}`));

    pluginStore.remove(PAGE_PLUGIN_ID);

    await waitFor(() => expect(useUiStore.getState().page).toBe("home"));
    expect(screen.queryByRole("button", { name: "采集看板" })).toBeNull();
  });
});
