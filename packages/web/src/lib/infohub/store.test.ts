import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useInfohubStore, canUseInfohub } from "./store.js";
import type { InfohubBridgeInfo, InfohubStatus } from "./client.js";

/**
 * 共享运行态（d.115）的两条约束：
 *
 * 1. `boot()` 只探测，不拉起 Python 子进程；
 * 2. `ensureRunning()` 是模块生效后的自动入口：拉起 → 刷新 → 空库自动采集一次；
 *    重复调用不会重复启动或重复采集，失败必须回可读错误。
 *
 * 其余用例钉住「停止后不残留旧数据」：否则首页卡会拿上一次连接的日程继续展示，
 * 工具也可能在进程已退出时仍被注入。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

const HOME = "D:\\wohaolei";
const HOME_KEY = "heming.infohub.home.v1";

const status = {
  home: HOME,
  stats: { conversations: 1, messages: 2, per_source: { qq: 1 } },
} as unknown as InfohubStatus;

const agenda = {
  items: [],
  summary: { overdue: 0, today: 0, week: 0, total: 0 },
};

/** config.detect 的返回：微信 + QQNT 都识别到。 */
const detectSources = {
  wechat: { db_dir: "D:\wx", detected: true },
  qq: { nt_db: "D:\qq\nt_msg.db", nt_account: "123", export_dir: "", detected: true },
};

function info(overrides: Partial<InfohubBridgeInfo> = {}): InfohubBridgeInfo {
  return {
    packageDir: "D:\\Heming\\packages\\infohub",
    defaultHome: "C:\\Users\\x\\Heming\\infohub",
    bundledPython: null,
    running: false,
    pid: null,
    home: null,
    python: null,
    pythonSource: null,
    startedAt: 0,
    methods: ["status", "agenda"],
    ...overrides,
  };
}

function installBridge(
  options: { running?: boolean; startError?: Error; engineError?: Error; engineInstalled?: boolean } = {},
) {
  const call = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "status") return status;
    if (method === "agenda") return agenda;
    if (method === "config.detect") {
      return { applied: true, sources: detectSources, summary: { autoSyncOnStart: true } };
    }
    return undefined;
  });
  let engineOn = options.engineInstalled ?? true;
  const engineInfo = vi.fn(async () => ({
    id: "heming.infohub-engine",
    expectedVersion: "1.0.0",
    installed: engineOn,
    version: engineOn ? "1.0.0" : "",
    base: "http://47.92.39.184/updates/modules",
  }));
  const ensureEngine = vi.fn(async () => {
    if (options.engineError) throw options.engineError;
    engineOn = true;
    return { ...(await engineInfo()), installed: true, updated: true };
  });
  const bridge = {
    info: vi.fn(async () => info({ running: options.running ?? false })),
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
      return info({
        running: true,
        pid: 4321,
        home: HOME,
        python: "C:\\py\\python.exe",
        pythonSource: "bundled",
      });
    }),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    engineInfo,
    ensureEngine,
    onEngine: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge, call, ensureEngine };
}

function resetStore() {
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
    detected: null,
    autoCollected: false,
    autoNote: "",
    busy: "",
    error: "",
  });
}

describe("信息中枢共享状态", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStore();
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器端：boot 只标记不可用，不探测也不启动", async () => {
    await useInfohubStore.getState().boot();
    expect(useInfohubStore.getState()).toMatchObject({
      booted: true,
      available: false,
      running: false,
    });
  });

  it("boot 在进程未运行时只读 info，不拉起子进程", async () => {
    const { bridge, call } = installBridge();
    await useInfohubStore.getState().boot();

    expect(bridge.info).toHaveBeenCalledTimes(1);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(useInfohubStore.getState()).toMatchObject({ available: true, running: false });
  });

  it("boot 发现进程已在跑：挂上状态并刷新统计与日程", async () => {
    const { bridge, call } = installBridge({ running: true });
    await useInfohubStore.getState().boot();

    expect(bridge.start).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith("status", {}, expect.anything());
    expect(call).toHaveBeenCalledWith("agenda", expect.objectContaining({ days: 14, overdue: 30 }), expect.anything());
    expect(useInfohubStore.getState().running).toBe(true);
    expect(useInfohubStore.getState().status).toBe(status);
    expect(useInfohubStore.getState().agenda).toEqual(agenda);
  });

  it("connect 是唯一启动入口：带上本机保存的目录并刷新数据", async () => {
    localStorage.setItem(HOME_KEY, HOME);
    const { bridge, call } = installBridge();
    await useInfohubStore.getState().connect();

    expect(bridge.start).toHaveBeenCalledWith({ home: HOME });
    expect(call).toHaveBeenCalledWith(
      "status",
      {},
      { home: HOME, python: "C:\\py\\python.exe" },
    );
    expect(useInfohubStore.getState()).toMatchObject({ running: true, busy: "", error: "" });
    expect(canUseInfohub()).toBe(true);
  });

  it("connect 失败：回到未连接并给出剥掉 IPC 前缀的错误", async () => {
    installBridge({
      startError: new Error(
        "Error invoking remote method 'infohub:start': Error: 未找到可用的 Python 解释器",
      ),
    });
    await useInfohubStore.getState().connect();

    expect(useInfohubStore.getState()).toMatchObject({
      running: false,
      busy: "",
      error: "未找到可用的 Python 解释器",
    });
    expect(canUseInfohub()).toBe(false);
  });

  it("ensureRunning：模块生效即自动拉起，并空库自动采集一次", async () => {
    const emptyStatus = {
      home: HOME,
      hasDb: false,
      dbBytes: 0,
      stats: { conversations: 0, messages: 0, per_source: {} },
      config: {
        autoDetect: true,
        autoSyncOnStart: true,
        wechat: { enabled: true, dbDir: "D:\\wx", detected: true },
        qq: {
          enabled: true,
          mode: "nt",
          ntAccount: "123",
          ntDb: "D:\\qq\\nt_msg.db",
          exportDir: "",
          detected: true,
          exportDetected: false,
        },
      },
    } as unknown as InfohubStatus;
    const { bridge, call } = installBridge();
    call.mockImplementation(async (method: string) => {
      if (method === "status") return emptyStatus;
      if (method === "agenda") return agenda;
      if (method === "sync") {
        return { reports: [{ source: "qq", added: 3, errors: [] }], agenda: 1, kb: null };
      }
      return undefined;
    });

    await useInfohubStore.getState().ensureRunning();

    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "sync",
      { sources: ["qq", "wechat"], full: false, archive: false },
      expect.anything(),
    );
    expect(useInfohubStore.getState()).toMatchObject({
      running: true,
      autoCollected: true,
      autoNote: "自动采集完成：新增 3 条消息",
    });
  });

  it("ensureRunning 重复调用：不重复启动、不重复采集", async () => {
    const emptyStatus = {
      home: HOME,
      hasDb: false,
      dbBytes: 0,
      stats: { conversations: 0, messages: 0, per_source: {} },
      config: {
        autoDetect: true,
        autoSyncOnStart: true,
        wechat: { enabled: true, dbDir: "D:\\wx", detected: true },
        qq: { enabled: true, mode: "nt", ntDb: "", exportDir: "", detected: false },
      },
    } as unknown as InfohubStatus;
    const { bridge, call } = installBridge();
    call.mockImplementation(async (method: string) => {
      if (method === "status") return emptyStatus;
      if (method === "agenda") return agenda;
      if (method === "sync") return { reports: [], agenda: 0, kb: null };
      return undefined;
    });

    await useInfohubStore.getState().ensureRunning();
    await useInfohubStore.getState().ensureRunning();

    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.filter(([method]) => method === "sync")).toHaveLength(1);
  });

  it("并发 ensureRunning（App 与页面同时进入）：共用一次启动，不误报失败", async () => {
    const { bridge, ensureEngine } = installBridge();

    await Promise.all([
      useInfohubStore.getState().ensureRunning(),
      useInfohubStore.getState().ensureRunning(),
    ]);

    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(ensureEngine).toHaveBeenCalledTimes(1);
    expect(useInfohubStore.getState()).toMatchObject({ running: true, error: "" });
  });

  it("引擎未装：先下载安装再启动，进度写进自动状态", async () => {
    const { bridge, ensureEngine } = installBridge({ engineInstalled: false });
    const pending = useInfohubStore.getState().ensureRunning();
    await pending;

    expect(ensureEngine).toHaveBeenCalledTimes(1);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(useInfohubStore.getState()).toMatchObject({ running: true, error: "" });
    expect(useInfohubStore.getState().autoNote).not.toContain("引擎");
  });

  it("引擎下载/验签失败：不拉起进程，错误按原样给用户看", async () => {
    const { bridge } = installBridge({
      engineInstalled: false,
      engineError: new Error(
        "Error invoking remote method 'infohub:engine-ensure': Error: 模块包未通过首方签名，已拒绝安装",
      ),
    });

    await useInfohubStore.getState().ensureRunning();

    expect(bridge.start).not.toHaveBeenCalled();
    expect(useInfohubStore.getState()).toMatchObject({
      running: false,
      error: "模块包未通过首方签名，已拒绝安装",
      autoNote: "信息中枢引擎未就绪：模块包未通过首方签名，已拒绝安装",
    });
  });

  it("ensureRunning 启动失败：给出可读错误，不 pretend 已连接", async () => {
    installBridge({
      startError: new Error(
        "Error invoking remote method 'infohub:start': Error: 未找到可用的 Python 解释器",
      ),
    });

    await useInfohubStore.getState().ensureRunning();

    expect(useInfohubStore.getState()).toMatchObject({
      running: false,
      error: "未找到可用的 Python 解释器",
    });
  });

  it("disconnect：回收进程并清掉依赖连接的数据", async () => {
    const { bridge } = installBridge({ running: true });
    await useInfohubStore.getState().boot();
    expect(useInfohubStore.getState().status).not.toBeNull();

    await useInfohubStore.getState().disconnect();

    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(useInfohubStore.getState()).toMatchObject({
      running: false,
      status: null,
      agenda: null,
      error: "",
    });
    expect(canUseInfohub()).toBe(false);
  });

  it("syncInfo 停止时清空旧统计，避免首页卡拿过期日程", async () => {
    const { bridge } = installBridge({ running: true });
    await useInfohubStore.getState().boot();
    expect(useInfohubStore.getState().agenda).not.toBeNull();

    useInfohubStore.getState().syncInfo(info({ running: false }));

    expect(useInfohubStore.getState()).toMatchObject({
      available: true,
      running: false,
      status: null,
      agenda: null,
    });
  });

  it("未连接时 refresh 不发请求", async () => {
    const { call } = installBridge();
    useInfohubStore.setState({ available: true });
    await useInfohubStore.getState().refresh();
    expect(call).not.toHaveBeenCalled();
  });

  it("detect：调用 config.detect，把来源状态与摘要写回共享状态", async () => {
    const summary = { ...status.config, autoSyncOnStart: true };
    const sources = {
      wechat: { db_dir: "D:\\wx", detected: true },
      qq: { nt_db: "D:\\qq\\nt_msg.db", nt_account: "123", export_dir: "", detected: true },
    };
    const { call } = installBridge();
    call.mockImplementation(async (method: string) => {
      if (method === "config.detect") return { applied: true, sources, summary };
      if (method === "status") return status;
      if (method === "agenda") return agenda;
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true, status });

    const result = await useInfohubStore.getState().detect();

    expect(call).toHaveBeenCalledWith("config.detect", {}, expect.anything());
    expect(result).toEqual(sources);
    expect(useInfohubStore.getState().detected).toEqual(sources);
    expect(useInfohubStore.getState().status?.config).toEqual(summary);
    expect(useInfohubStore.getState().error).toBe("");
  });

  it("detect 失败：保留可读错误，不覆盖已有识别结果", async () => {
    const previous = {
      wechat: { db_dir: "D:\\wx", detected: true },
      qq: { nt_db: "", nt_account: "", export_dir: "", detected: false },
    };
    const { call } = installBridge();
    call.mockImplementation(async () => {
      throw new Error("Error invoking remote method 'infohub:call': Error: 边车未就绪");
    });
    useInfohubStore.setState({ available: true, running: true, detected: previous });

    const result = await useInfohubStore.getState().detect();

    expect(result).toBeNull();
    expect(useInfohubStore.getState().detected).toEqual(previous);
    expect(useInfohubStore.getState().error).toBe("边车未就绪");
  });

  it("autoCollected：每轮重新连接重置为 false，可再尝试一次自动采集", async () => {
    installBridge();
    useInfohubStore.setState({ autoCollected: true, running: false });

    await useInfohubStore.getState().connect();

    expect(useInfohubStore.getState().autoCollected).toBe(false);
  });

  it("canUseInfohub 同时要求桌面桥与运行态", async () => {
    useInfohubStore.setState({ running: true });
    expect(canUseInfohub()).toBe(false); // 没有桌面桥，running 再真也不能用

    installBridge({ running: true });
    useInfohubStore.setState({ running: false });
    expect(canUseInfohub()).toBe(false);
    useInfohubStore.setState({ running: true });
    expect(canUseInfohub()).toBe(true);
  });
});
