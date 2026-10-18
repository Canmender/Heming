import { useEffect, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";

// 启动动画集成用例独立成文件：此处把 BootWave 换成可控桩（不自动完成），
// 并把下游页面桩成纯文本，专注验证「动画完成前只显示 BootWave，完成后才路由到登录页/主界面」。
vi.mock("./components/LoginPage.js", () => ({ LoginPage: () => <div>LoginPage</div> }));
vi.mock("./components/NavRail.js", () => ({
  NavRail: () => <div>NavRail</div>, NavPeek: () => <div>NavPeek</div>,
}));
vi.mock("./components/HomePage.js", () => ({ HomePage: () => <div>HomePage</div> }));
vi.mock("./components/WorkspacePage.js", () => ({ WorkspacePage: () => <div>WorkspacePage</div> }));
vi.mock("./components/ChatPage.js", () => ({ ChatPage: () => <div>ChatPage</div> }));
vi.mock("./components/RadarContacts.js", () => ({ RadarContacts: () => <div>RadarContacts</div> }));
vi.mock("./components/SettingsPage.js", () => ({ SettingsPage: () => <div>SettingsPage</div> }));
vi.mock("./components/MemoryPage.js", () => ({ MemoryPage: () => <div>MemoryPage</div> }));
vi.mock("./components/FileTree.js", () => ({ FileTree: () => <div>FileTree</div> }));
vi.mock("./components/FilePreviewModal.js", () => ({ FilePreviewModal: () => null }));
// 登录态下 AppShell 会拉文件/用量，测试不触网：仅覆盖网络函数，其余（restore 用的 setOnUnauthorized 等）保持真实。
vi.mock("./lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api.js")>();
  return {
    ...actual,
    getToken: () => null,
    fetchFiles: vi.fn().mockResolvedValue([]),
    fetchFileUsage: vi.fn().mockResolvedValue({ used: 0, quota: 0 }),
    uploadFile: vi.fn(),
  };
});

/** 可控 BootWave 桩：渲染时记录最新 onDone，由测试手动触发；未完成时主内容不得出现。 */
let bootDoneFns: Array<() => void> = [];
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    const [done, setDone] = useState(false);
    useEffect(() => {
      bootDoneFns.push(() => { setDone(true); onDone(); });
    }, [onDone]);
    return done ? null : <div>BootWave</div>;
  },
}));

describe("App 启动动画集成", () => {
  beforeEach(() => {
    bootDoneFns = [];
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({
      page: "home", navCollapsed: false, activeConversationId: null,
      contactsHidden: false, detailContact: null, pendingAttachment: null,
    });
  });

  afterEach(() => { bootDoneFns = []; });

  it("未登录时：动画完成前只有 BootWave，完成后显示登录页", async () => {
    render(<App />);
    // 完成前：BootWave 可见，登录页尚未出现（门禁生效）
    expect(screen.getByText("BootWave")).toBeTruthy();
    expect(screen.queryByText("LoginPage")).toBeNull();

    await act(async () => { bootDoneFns[0]?.(); });
    await waitFor(() => { expect(screen.getByText("LoginPage")).toBeTruthy(); });
    expect(screen.queryByText("BootWave")).toBeNull();
  });

  it("已登录时：动画完成后才显示主界面", async () => {
    useAuthStore.setState({
      token: "t", user: { id: "u1", username: "t", displayName: "T" }, status: "authed", error: null,
    });
    render(<App />);
    expect(screen.getByText("BootWave")).toBeTruthy();
    expect(screen.queryByText("NavRail")).toBeNull();

    await act(async () => { bootDoneFns[0]?.(); });
    await waitFor(() => { expect(screen.getByText("NavRail")).toBeTruthy(); });
  });
});
