import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppPresence } from "./appPresence.js";
import { connectWs } from "./ws.js";
import { useAuthStore } from "../store/auth.js";

vi.mock("./ws.js", () => ({ connectWs: vi.fn() }));

/**
 * 应用级在场连接：登录后保活一条 WS（只用于服务端 presence），登出/卸载关闭。
 * 团队审计 P1-3 的根因就是「只有开某个会话才建连」，人被团队算成离线。
 */
describe("lib/appPresence", () => {
  const close = vi.fn();

  beforeEach(() => {
    vi.mocked(connectWs).mockReset();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close } as never);
    close.mockReset();
    useAuthStore.setState({ status: "authed", token: "t1", user: null, error: null });
  });

  it("已登录：建立一条只保活的连接（事件忽略）", () => {
    renderHook(() => useAppPresence());
    expect(connectWs).toHaveBeenCalledTimes(1);
    const handlers = vi.mocked(connectWs).mock.calls[0][0];
    expect(() => handlers.onEvent({ type: "agent_chunk" } as never)).not.toThrow();
  });

  it("未登录：不建连；登出后关闭", () => {
    useAuthStore.setState({ status: "idle", token: null, user: null, error: null });
    const first = renderHook(() => useAppPresence());
    expect(connectWs).not.toHaveBeenCalled();
    first.unmount();

    useAuthStore.setState({ status: "authed", token: "t1", user: null, error: null });
    const { unmount } = renderHook(() => useAppPresence());
    expect(connectWs).toHaveBeenCalledTimes(1);
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("enabled=false 时不建连（测试/特殊场景可关）", () => {
    renderHook(() => useAppPresence(false));
    expect(connectWs).not.toHaveBeenCalled();
  });
});
