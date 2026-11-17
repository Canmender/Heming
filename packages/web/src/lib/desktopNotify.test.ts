import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DESKTOP_NOTIFY_KEY,
  isDesktopNotifyEnabled,
  notifyDesktop,
  onDesktopNotifyOpen,
  setDesktopNotifyEnabled,
} from "./desktopNotify.js";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  delete window.__heming_notify;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("desktopNotify", () => {
  it("窗口聚焦时不弹系统通知", () => {
    const message = vi.fn();
    window.__heming_notify = { message, onOpen: vi.fn(() => () => {}) };
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(notifyDesktop({ title: "t", body: "b" })).toBe(false);
    expect(message).not.toHaveBeenCalled();
  });

  it("桥的 message 抛错：不向外抛，返回 false", () => {
    window.__heming_notify = {
      message: vi.fn(() => {
        throw new Error("ipc broken");
      }),
      onOpen: vi.fn(() => () => {}),
    };
    expect(() => notifyDesktop({ title: "t", body: "b" })).not.toThrow();
    expect(notifyDesktop({ title: "t", body: "b" })).toBe(false);
  });
});

describe("系统通知开关（d.208）", () => {
  it("默认开：没存过 / 只认显式 0 为关", () => {
    expect(isDesktopNotifyEnabled()).toBe(true);
    localStorage.setItem(DESKTOP_NOTIFY_KEY, "1");
    expect(isDesktopNotifyEnabled()).toBe(true);
    localStorage.setItem(DESKTOP_NOTIFY_KEY, "0");
    expect(isDesktopNotifyEnabled()).toBe(false);
  });

  it("关掉之后即使窗口在后台也不弹", () => {
    const message = vi.fn();
    window.__heming_notify = { message, onOpen: vi.fn(() => () => {}) };
    setDesktopNotifyEnabled(false);
    expect(notifyDesktop({ title: "t", body: "b" })).toBe(false);
    expect(message).not.toHaveBeenCalled();
    // 打开后恢复
    setDesktopNotifyEnabled(true);
    expect(notifyDesktop({ title: "t", body: "b" })).toBe(true);
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("setDesktopNotifyEnabled 返回写入后的状态", () => {
    expect(setDesktopNotifyEnabled(false)).toBe(false);
    expect(setDesktopNotifyEnabled(true)).toBe(true);
  });
});

describe("点通知回到会话（d.208）", () => {
  it("转发 onOpen 的会话 id；返回的退订函数可用", () => {
    let captured: ((conversationId: string | null) => void) | null = null;
    const off = vi.fn();
    window.__heming_notify = {
      message: vi.fn(),
      onOpen: vi.fn((handler: (conversationId: string | null) => void) => {
        captured = handler;
        return off;
      }),
    };
    const seen: (string | null)[] = [];
    const unsubscribe = onDesktopNotifyOpen((conversationId) => seen.push(conversationId));
    expect(captured).not.toBeNull();
    captured!("c7");
    captured!(null);
    expect(seen).toEqual(["c7", null]);
    unsubscribe();
    expect(off).toHaveBeenCalled();
  });

  it("界面回调抛异常不外溢；没有桥时订阅是空操作", () => {
    window.__heming_notify = {
      message: vi.fn(),
      onOpen: vi.fn((handler: (conversationId: string | null) => void) => {
        handler("c1");
        return () => {};
      }),
    };
    expect(() =>
      onDesktopNotifyOpen(() => {
        throw new Error("界面炸了");
      }),
    ).not.toThrow();
    delete window.__heming_notify;
    expect(() => onDesktopNotifyOpen(() => {})()).not.toThrow();
  });
});
