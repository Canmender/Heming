import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  callInfohub,
  describeInfohubError,
  detectInfohubSources,
  detectedSourcesFromSummary,
  detectedSyncSources,
  ensureInfohubEngine,
  formatInfohubBytes,
  formatInfohubTime,
  infohubEngineInfo,
  isInfohubAvailable,
  onInfohubEngineEvent,
  onInfohubEvent,
  readAutoCollectPreference,
  readInfohubConfig,
  supportsInfohubEngine,
  writeAutoCollectPreference,
  writeInfohubConfig,
  type InfohubConfigSummary,
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

  it("detectInfohubSources 只走本机 config.detect，不带任何云端参数", async () => {
    const result = {
      applied: true,
      sources: {
        wechat: { db_dir: "D:\\wx", detected: true },
        qq: { nt_db: "D:\\qq\\nt_msg.db", nt_account: "123", export_dir: "", detected: true },
      },
      summary: {} as InfohubConfigSummary,
    };
    const bridge = installBridge({ call: vi.fn(async () => result) });

    await expect(detectInfohubSources({ home: "D:\\w" })).resolves.toBe(result);
    expect(bridge.call).toHaveBeenCalledWith("config.detect", {}, { home: "D:\\w" });
    expect(bridge.call).toHaveBeenCalledTimes(1);
  });

  it("从 status.config 还原来源状态，并给出可采集来源", () => {
    const summary = {
      wechat: { enabled: true, dbDir: "D:\\wx", detected: true },
      qq: { enabled: true, mode: "nt", ntAccount: "123", ntDb: "", exportDir: "D:\\qq", exportDetected: true, detected: true },
    } as unknown as InfohubConfigSummary;

    const detected = detectedSourcesFromSummary(summary);
    expect(detected.wechat).toEqual({ db_dir: "D:\\wx", detected: true });
    expect(detected.qq.export_detected).toBe(true);
    expect(detectedSyncSources(detected)).toEqual(["qq", "wechat"]);

    // 只有配置了路径但标记未识别（例如手填路径不存在）时不算来源
    const broken = detectedSourcesFromSummary({
      wechat: { enabled: true, dbDir: "D:\\gone", detected: false },
      qq: { enabled: true, mode: "nt", ntAccount: "", ntDb: "D:\\gone.db", detected: false },
    } as unknown as InfohubConfigSummary);
    expect(detectedSyncSources(broken)).toEqual([]);
  });

  it("自动采集偏好：localStorage 优先，未设置返回 null（回落到 config）", () => {
    expect(readAutoCollectPreference()).toBeNull();
    writeAutoCollectPreference(false);
    expect(readAutoCollectPreference()).toBe(false);
    writeAutoCollectPreference(true);
    expect(readAutoCollectPreference()).toBe(true);
    writeAutoCollectPreference(null);
    expect(readAutoCollectPreference()).toBeNull();
    expect(() => writeAutoCollectPreference(true, null)).not.toThrow();
  });

  it("错误文案清理：去 IPC 前缀与重复的 Error:", () => {
    expect(describeInfohubError("Error invoking remote method 'x': Error: 启动失败")).toBe("启动失败");
    expect(describeInfohubError(new Error("Error: 超时"))).toBe("超时");
    expect(describeInfohubError(null)).toBe("");
  });

  it("选装引擎：状态/按需安装透传，旧宿主给出可读错误并判为不支持", async () => {
    const engine = vi.fn(async () => ({
      id: "heming.infohub-engine",
      expectedVersion: "1.0.0",
      installed: false,
      version: "",
      base: "http://47.92.39.184/updates/modules",
    }));
    const ensure = vi.fn(async () => ({
      id: "heming.infohub-engine",
      expectedVersion: "1.0.0",
      installed: true,
      version: "1.0.0",
      base: "http://47.92.39.184/updates/modules",
      updated: true,
    }));
    installBridge({ engineInfo: engine, ensureEngine: ensure });

    expect(supportsInfohubEngine()).toBe(true);
    await expect(infohubEngineInfo()).resolves.toMatchObject({ installed: false });
    await expect(ensureInfohubEngine()).resolves.toMatchObject({ installed: true, updated: true });
    expect(ensure).toHaveBeenCalledWith(undefined);

    installBridge({});
    expect(supportsInfohubEngine()).toBe(false);
    await expect(ensureInfohubEngine()).rejects.toThrow("当前桌面端不支持选装模块");
  });

  it("引擎进度事件：按 stage 透传，取消后不再回调", () => {
    const listeners: ((event: unknown) => void)[] = [];
    installBridge({
      onEngine: vi.fn((callback) => {
        listeners.push(callback);
        return () => {
          listeners.length = 0;
        };
      }),
    });
    const received: unknown[] = [];
    const off = onInfohubEngineEvent((event) => received.push(event));
    listeners[0]?.({ stage: "download", version: "1.0.0", received: 1024, total: 4096 });
    expect(received).toEqual([{ stage: "download", version: "1.0.0", received: 1024, total: 4096 }]);
    off();
    expect(listeners.length).toBe(0);
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
