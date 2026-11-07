/**
 * 全局快捷键帮助入口（d.61 F 轨）：`?` / `Ctrl+/` 打开，输入框内不触发，Esc 只关面板。
 *
 * 用真实 App 壳 + 真实登录页（登录页有输入框，正好验证「输入框内按 ? 不弹帮助」）。
 * 启动动画换成「立即完成」的桩，避免遮罩影响按键。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken, fetchMe } from "./lib/api.js";

vi.mock("./lib/appPresence.js", () => ({ useAppPresence: () => undefined }));
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => {
      onDone();
    }, [onDone]);
    return null;
  },
}));

// 只桩网络函数：getToken/setToken 走真实实现（登录页无需请求）
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

beforeEach(() => {
  localStorage.clear();
  setToken(null);
  vi.mocked(fetchMe).mockReset();
  useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  useUiStore.setState({ page: "home", activeConversationId: null, pendingAttachment: null });
});

afterEach(() => cleanup());

describe("快捷键帮助的全局入口", () => {
  it("?（Shift+/）在页面上打开帮助面板，Esc 关闭", async () => {
    render(<App />);
    await screen.findByPlaceholderText("用户名");
    expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull();

    fireEvent.keyDown(document, { key: "?", shiftKey: true, code: "Slash" });
    const dialog = await screen.findByRole("dialog", { name: "快捷键" });
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull());
  });

  it("输入框内按 ? 不触发（用户是在打问号，不是在求帮助）", async () => {
    render(<App />);
    const input = await screen.findByPlaceholderText("用户名");
    input.focus();

    fireEvent.keyDown(input, { key: "?", shiftKey: true, code: "Slash" });
    expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull();
  });

  it("Ctrl+/ 也能打开（与 ? 同一个面板）", async () => {
    render(<App />);
    await screen.findByPlaceholderText("用户名");
    fireEvent.keyDown(document, { key: "/", ctrlKey: true, code: "Slash" });
    expect(await screen.findByRole("dialog", { name: "快捷键" })).toBeInTheDocument();
  });

  it("导航轨的 ? 按钮再次打开帮助（入口常驻）", async () => {
    render(<App />);
    await screen.findByPlaceholderText("用户名");
    // 未登录时导航轨不渲染；直接验证登录态：给一个用户后应用壳出现
    act(() => {
      useAuthStore.setState({
        token: "t1",
        user: { id: "u1", username: "alice", displayName: "爱丽丝" },
        status: "authed",
        error: null,
      });
    });
    const helpBtn = await screen.findByRole("button", { name: "快捷键帮助" });
    fireEvent.click(helpBtn);
    expect(await screen.findByRole("dialog", { name: "快捷键" })).toBeInTheDocument();
  });
});
