/**
 * 全局快捷键 Ctrl/⌘+B：显示 / 隐藏导航栏（d.68）。
 *
 * 用真实 App 壳覆盖三条纪律：
 *   1. pinned 下切到 auto（隐藏）→ 再按呼出/收回浮层，并落盘；
 *   2. 有模态弹窗时吞键（与 Alt+N / Ctrl+K 同一套）；
 *   3. 焦点在输入框内不响应（浏览器里 Ctrl+B 是加粗，不能抢）。
 *
 * 导航轨自身的展开/收回/焦点行为在 NavRail.test.tsx 覆盖，这里只测「全局入口接线」。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken } from "./lib/api.js";

vi.mock("./lib/appPresence.js", () => ({ useAppPresence: () => undefined }));
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => {
      onDone();
    }, [onDone]);
    return null;
  },
}));

// ChatPage/命令面板会在挂载时碰网络与 WebSocket；本文件只关心快捷键，桩掉即可。
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
    if (url === "/api/team")
      return Promise.resolve(jsonRes({ members: [], onlineCount: 0 }));
    if (url === "/api/team/activities") return Promise.resolve(jsonRes({ activities: [] }));
    if (url === "/api/agents") return Promise.resolve(jsonRes([]));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  setToken("t1");
  setViewportWidth(1280);
  mockFetch();
  useAuthStore.setState({ token: "t1", user: alice, status: "authed", error: null });
  useUiStore.setState({ page: "home", navMode: "pinned", navOpen: false });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ navMode: "pinned", navOpen: false });
});

describe("Ctrl/⌘+B 切换导航栏显隐", () => {
  it("pinned → auto（隐藏）并落盘；再按呼出、再按收回", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    let s = useUiStore.getState();
    expect(s.navMode).toBe("auto");
    expect(s.navOpen).toBe(false);
    expect(localStorage.getItem("heming.nav.mode.v1")).toBe("auto");

    // auto 下第二次：呼出浮层
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().navOpen).toBe(true);

    // 第三次：收回浮层（但仍是自动隐藏模式）
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    s = useUiStore.getState();
    expect(s.navOpen).toBe(false);
    expect(s.navMode).toBe("auto");
  });

  it("⌘+B 等价（macOS 用 metaKey）", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(useUiStore.getState().navMode).toBe("auto");
  });

  it("有模态弹窗（命令面板）时吞键：导航模式不变", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "全局搜索 Ctrl K" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().navMode).toBe("pinned");
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeInTheDocument();

    // 关掉面板后恢复响应（Esc 由面板自己的 onKeyDown 处理，需派发到面板子树）
    fireEvent.keyDown(screen.getByRole("dialog", { name: "命令面板" }), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument(),
    );
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().navMode).toBe("auto");
  });

  it("焦点在输入框里不响应（不抢浏览器加粗快捷键）", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    const probe = document.createElement("input");
    container.appendChild(probe);
    act(() => probe.focus());
    fireEvent.keyDown(probe, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().navMode).toBe("pinned");
    probe.remove();

    // 焦点回到页面后恢复响应
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().navMode).toBe("auto");
  });

  it("auto 下壳层给热区留 8px 空档（热区不压内容最左侧），pinned 不留", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    const shellRow = () => container.querySelector<HTMLElement>("main")?.parentElement ?? null;
    // pinned：没有额外的左内边距（与 d.67 布局一致）
    expect(shellRow()?.style.paddingLeft ?? "").toBe("");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(shellRow()?.style.paddingLeft).toBe("8px");

    // 回到 pinned 后空档撤销
    useUiStore.getState().setNavMode("pinned");
    await waitFor(() => expect(shellRow()?.style.paddingLeft ?? "").toBe(""));
  });
});
