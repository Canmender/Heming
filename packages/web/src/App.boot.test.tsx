import { useEffect, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken, fetchMe } from "./lib/api.js";

// 启动动画集成用例独立成文件：BootWave 换成可控桩（不自动完成），
// 专注验证「主界面从 T=0 就挂载（动画只是遮罩）」与「登录态恢复在动画期间后台完成」。
// 组件自身的揭示行为见 components/BootWave.test.tsx。
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

// 只桩掉网络函数：getToken/setToken/restore 走真实实现（getToken 读模块内 token）。
vi.mock("./lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api.js")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    fetchFiles: vi.fn().mockResolvedValue([]),
    fetchFileUsage: vi.fn().mockResolvedValue({ used: 0, quota: 0 }),
    uploadFile: vi.fn(),
  };
});

/** 可控 BootWave 桩：渲染时记录最新 onDone，由测试手动触发；未完成时遮罩仍在。 */
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

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

describe("App 启动动画集成", () => {
  beforeEach(() => {
    bootDoneFns = [];
    localStorage.clear();
    setToken(null);
    vi.mocked(fetchMe).mockReset();
    vi.mocked(fetchMe).mockResolvedValue(alice);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({
      page: "home", navCollapsed: false, activeConversationId: null,
      contactsHidden: false, detailContact: null, pendingAttachment: null,
    });
  });

  afterEach(() => { bootDoneFns = []; });

  it("未登录时：登录页在 T=0 就已挂载（遮罩只是盖在上面），动画结束后遮罩消失", async () => {
    render(<App />);

    // 主界面不等动画：遮罩与登录页同时存在，遮罩负责先遮住它
    expect(screen.getByText("BootWave")).toBeTruthy();
    expect(screen.getByText("LoginPage")).toBeTruthy();

    await act(async () => { bootDoneFns[0]?.(); });
    await waitFor(() => { expect(screen.queryByText("BootWave")).toBeNull(); });
    expect(screen.getByText("LoginPage")).toBeTruthy();
  });

  // 核心回归：restore() 必须在动画播放期间后台完成，而不是动画结束后才开始。
  // 否则已登录用户会在启动动画刚结束时撞见一帧「加载中…」。
  it("已登录时：动画还在播时登录态已恢复，动画结束后直接是主界面（无「加载中…」）", async () => {
    setToken("t1");
    useAuthStore.setState({ token: "t1", user: null, status: "pending", error: null });

    render(<App />);
    // 动画未完成：遮罩仍在
    expect(screen.getByText("BootWave")).toBeTruthy();

    // 恢复在遮罩之下完成
    await waitFor(() => { expect(fetchMe).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(useAuthStore.getState().status).toBe("authed"); });
    expect(useAuthStore.getState().user?.username).toBe("alice");
    // 恢复完成时动画仍未结束 —— 证明 restore 与动画并行，而非串行
    expect(screen.getByText("BootWave")).toBeTruthy();

    await act(async () => { bootDoneFns[0]?.(); });
    // 遮罩一撤就是主界面，中间没有任何「加载中…」
    expect(screen.getByText("NavRail")).toBeTruthy();
    expect(screen.queryByText("加载中…")).toBeNull();
    expect(screen.queryByText("BootWave")).toBeNull();
  });

  it("无 token 时：动画期间不发恢复请求", async () => {
    render(<App />);
    expect(screen.getByText("BootWave")).toBeTruthy();
    expect(screen.getByText("LoginPage")).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it("恢复失败（token 失效）时：动画期间就已回落到登录页，结束后不会闪现加载态", async () => {
    setToken("stale");
    useAuthStore.setState({ token: "stale", user: null, status: "pending", error: null });
    vi.mocked(fetchMe).mockRejectedValue(new Error("unauthorized"));

    render(<App />);
    expect(screen.getByText("BootWave")).toBeTruthy();
    await waitFor(() => { expect(useAuthStore.getState().status).toBe("idle"); });

    await act(async () => { bootDoneFns[0]?.(); });
    await waitFor(() => { expect(screen.queryByText("BootWave")).toBeNull(); });
    expect(screen.getByText("LoginPage")).toBeTruthy();
    expect(screen.queryByText("加载中…")).toBeNull();
  });
});
