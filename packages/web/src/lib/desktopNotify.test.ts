import { describe, it, expect, beforeEach, vi } from "vitest";
import { notifyDesktop } from "./desktopNotify.js";

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
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
