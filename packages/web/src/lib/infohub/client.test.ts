import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  callInfohub,
  describeInfohubError,
  formatInfohubBytes,
  formatInfohubTime,
  infohubBridgeStatus,
  isInfohubAvailable,
  onInfohubBridgeEvent,
  onInfohubEvent,
  probeInfohubBridge,
  readInfohubConfig,
  startInfohubBridge,
  stopInfohubBridge,
  writeInfohubConfig,
  type InfohubBridgeApi,
  type InfohubBridgeStatus,
} from "./client.js";

type Bridge = NonNullable<Window["__heming_infohub"]> & InfohubBridgeApi;

function bridgeStatus(overrides: Partial<InfohubBridgeStatus> = {}): InfohubBridgeStatus {
  return {
    running: false,
    starting: false,
    url: null,
    port: null,
    home: null,
    python: null,
    pythonSource: "unknown",
    source: "none",
    since: null,
    error: null,
    ...overrides,
  };
}

function installBridge(partial: Partial<Bridge>): Bridge {
  const bridge = {
    info: vi.fn(async () => ({})),
    start: vi.fn(async () => ({})),
    call: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
    bridgeStatus: vi.fn(async () => bridgeStatus()),
    bridgeStart: vi.fn(async () => bridgeStatus({ running: true, starting: false, source: "app", port: 8776 })),
    bridgeStop: vi.fn(async () => true),
    onBridgeEvent: vi.fn(() => () => {}),
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

  describe("采集桥（d.96）", () => {
    it("桌面端：四个函数转发到 preload，事件订阅可退订", async () => {
      const listeners: ((status: InfohubBridgeStatus) => void)[] = [];
      const status = bridgeStatus({
        running: true,
        source: "app",
        port: 8776,
        url: "http://127.0.0.1:8776/mcp",
        since: 1800000000000,
      });
      const bridge = installBridge({
        bridgeStatus: vi.fn(async () => status),
        bridgeStart: vi.fn(async () => status),
        bridgeStop: vi.fn(async () => true),
        onBridgeEvent: vi.fn((callback) => {
          listeners.push(callback);
          return () => {
            const index = listeners.indexOf(callback);
            if (index >= 0) listeners.splice(index, 1);
          };
        }),
      });

      await expect(infohubBridgeStatus()).resolves.toEqual(status);
      await expect(startInfohubBridge({ home: "D:\\\\wohaolei" })).resolves.toEqual(status);
      expect(bridge.bridgeStart).toHaveBeenCalledWith({ home: "D:\\\\wohaolei" });
      await expect(stopInfohubBridge()).resolves.toBe(true);

      const received: InfohubBridgeStatus[] = [];
      const off = onInfohubBridgeEvent((next) => received.push(next));
      listeners[0]?.(status);
      expect(received).toEqual([status]);
      off();
      expect(listeners).toHaveLength(0);
    });

    it("浏览器端：采集桥函数与事件订阅都按「仅桌面端可用」处理", async () => {
      expect(isInfohubAvailable()).toBe(false);
      await expect(infohubBridgeStatus()).rejects.toThrow("信息中枢仅桌面端可用");
      await expect(startInfohubBridge()).rejects.toThrow("信息中枢仅桌面端可用");
      await expect(stopInfohubBridge()).rejects.toThrow("信息中枢仅桌面端可用");
      // 事件订阅是「有就挂、没有就空函数」：页面卸载时统一调 off() 不能炸。
      const off = onInfohubBridgeEvent(() => {});
      expect(typeof off).toBe("function");
      expect(() => off()).not.toThrow();
    });

    it("旧版桌面端没有采集桥方法：给可执行的更新提示，而不是 TypeError", async () => {
      installBridge({
        bridgeStatus: undefined,
        bridgeStart: undefined,
        bridgeStop: undefined,
        onBridgeEvent: undefined,
      } as unknown as Partial<Bridge>);
      await expect(infohubBridgeStatus()).rejects.toThrow("当前桌面端不支持采集桥，请更新和鸣");
      await expect(startInfohubBridge()).rejects.toThrow("当前桌面端不支持采集桥，请更新和鸣");
      const off = onInfohubBridgeEvent(() => {});
      expect(() => off()).not.toThrow();
    });

    it("probe：/health 返回 infohub-mcp 即视为检测到（只读 GET、不带凭据）", async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", name: "infohub-mcp" }),
      })) as unknown as typeof fetch;
      const result = await probeInfohubBridge(undefined, { fetchImpl });

      expect(result).toEqual({ ok: true, name: "infohub-mcp" });
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://127.0.0.1:8776/health",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("probe：超时按中文原因返回，不抛异常", async () => {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const result = await probeInfohubBridge("http://127.0.0.1:8776/health", {
        fetchImpl,
        timeoutMs: 10,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/超时/);
    });

    it("probe：网络错误与 HTTP 非 2xx 都收口成 { ok: false, error }", async () => {
      const refused = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const network = await probeInfohubBridge(undefined, { fetchImpl: refused });
      expect(network.ok).toBe(false);
      expect(network.error).toMatch(/无法连接本机采集桥/);

      const broken = vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      const http = await probeInfohubBridge(undefined, { fetchImpl: broken });
      expect(http).toEqual({ ok: false, error: "本机采集桥返回 HTTP 503" });
    });

    it("probe：2xx 但服务名不是 infohub-mcp 时不误判为可用", async () => {
      const other = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: "some-other-service" }),
      })) as unknown as typeof fetch;
      const result = await probeInfohubBridge(undefined, { fetchImpl: other });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/不是信息采集中枢/);
    });
  });
});
