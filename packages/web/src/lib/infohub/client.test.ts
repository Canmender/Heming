import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  callInfohub,
  describeInfohubError,
  formatInfohubBytes,
  formatInfohubTime,
  isInfohubAvailable,
  onInfohubEvent,
  readInfohubConfig,
  writeInfohubConfig,
} from "./client.js";

type Bridge = NonNullable<Window["__heming_infohub"]>;

function installBridge(partial: Partial<Bridge>): Bridge {
  const bridge = {
    info: vi.fn(async () => ({})),
    start: vi.fn(async () => ({})),
    call: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
    ...partial,
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return bridge;
}

describe("infohub 客户端", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器环境没有桥：可用性为 false，事件订阅返回空取消函数", () => {
    expect(isInfohubAvailable()).toBe(false);
    const off = onInfohubEvent(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("桌面端有桥：可用性为 true，事件按进度对象透传并可取消", () => {
    const listeners: ((event: unknown) => void)[] = [];
    installBridge({
      onEvent: vi.fn((callback) => {
        listeners.push(callback);
        return () => {
          listeners.length = 0;
        };
      }),
    });
    expect(isInfohubAvailable()).toBe(true);
    const received: unknown[] = [];
    const off = onInfohubEvent((event) => received.push(event));
    listeners[0]?.({ event: "progress", phase: "sync", stage: "微信", current: 2, total: 5 });
    expect(received).toEqual([{ event: "progress", phase: "sync", stage: "微信", current: 2, total: 5 }]);
    off();
    expect(listeners.length).toBe(0);
  });

  it("本地配置读写：只接受非空值，损坏的存储回落为空", () => {
    expect(readInfohubConfig(null)).toEqual({});
    writeInfohubConfig({ home: "D:\\wohaolei", python: "D:\\py\\python.exe" });
    expect(readInfohubConfig()).toEqual({ home: "D:\\wohaolei", python: "D:\\py\\python.exe" });
    writeInfohubConfig({});
    expect(readInfohubConfig()).toEqual({});

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readInfohubConfig(broken)).toEqual({});
    expect(() => writeInfohubConfig({ home: "x" }, broken)).not.toThrow();
  });

  it("callInfohub 原样转发方法与配置，并把 IPC 错误前缀剥掉", async () => {
    const bridge = installBridge({
      call: vi.fn(async () => ({ items: [], total: 0 })),
    });
    await expect(callInfohub("conversations", { limit: 3 }, { home: "D:\\w" })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(bridge.call).toHaveBeenCalledWith("conversations", { limit: 3 }, { home: "D:\\w" });

    installBridge({
      call: vi.fn(async () => {
        throw new Error("Error invoking remote method 'infohub:call': Error: 会话不存在");
      }),
    });
    await expect(callInfohub("messages", {})).rejects.toThrow(/^会话不存在$/);
  });

  it("没有桥时调用给出可读错误（不静默失败）", async () => {
    await expect(callInfohub("status")).rejects.toThrow("信息中枢仅桌面端可用");
  });

  it("错误文案清理：去 IPC 前缀与重复的 Error:", () => {
    expect(describeInfohubError("Error invoking remote method 'x': Error: 启动失败")).toBe("启动失败");
    expect(describeInfohubError(new Error("Error: 超时"))).toBe("超时");
    expect(describeInfohubError(null)).toBe("");
  });

  it("时间与字节格式化", () => {
    expect(formatInfohubTime(0)).toBe("");
    const ts = new Date(2026, 10, 1, 9, 5).getTime() / 1000;
    expect(formatInfohubTime(ts)).toBe("11-01 09:05");
    expect(formatInfohubTime(ts, true)).toBe("2026-11-01 09:05");
    expect(formatInfohubBytes(0)).toBe("0 B");
    expect(formatInfohubBytes(900)).toBe("900 B");
    expect(formatInfohubBytes(2048)).toBe("2.0 KB");
    expect(formatInfohubBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatInfohubBytes(2 * 1024 ** 3)).toBe("2.00 GB");
  });
});
