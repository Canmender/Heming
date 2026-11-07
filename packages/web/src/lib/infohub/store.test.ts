import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useInfohubStore, canUseInfohub } from "./store.js";
import type {
  InfohubBridgeApi,
  InfohubBridgeInfo,
  InfohubBridgeStatus,
  InfohubStatus,
} from "./client.js";

/**
 * 共享运行态（d.46）的两条硬约束：
 *
 * 1. `boot()` 只探测，**绝不**拉起 Python 子进程——自动 spawn 会越过用户意图；
 * 2. 只有 `connect()`（用户显式点连接）才能启动，失败必须回可读错误。
 *
 * 其余用例钉住「停止后不残留旧数据」：否则首页卡会拿上一次连接的日程继续展示，
 * 工具也可能在进程已退出时仍被注入。
 */

type Bridge = NonNullable<Window["__heming_infohub"]> & InfohubBridgeApi;

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
  options: {
    running?: boolean;
    startError?: Error;
    bridgeStatus?: InfohubBridgeStatus;
    bridgeStartStatus?: InfohubBridgeStatus;
    bridgeStatusError?: Error;
    stopResult?: boolean;
  } = {},
) {
  const listeners: ((status: InfohubBridgeStatus) => void)[] = [];
  const call = vi.fn(async (method: string) => {
    if (method === "status") return status;
    if (method === "agenda") return agenda;
    return undefined;
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
    onEvent: vi.fn(() => () => {}),
    bridgeStatus: vi.fn(async () => {
      if (options.bridgeStatusError) throw options.bridgeStatusError;
      return options.bridgeStatus ?? bridgeStatus();
    }),
    bridgeStart: vi.fn(async () => {
      if (options.startError) throw options.startError;
      return (
        options.bridgeStartStatus ??
        bridgeStatus({ running: true, source: "app", port: 8776, url: "http://127.0.0.1:8776/mcp" })
      );
    }),
    bridgeStop: vi.fn(async () => options.stopResult ?? true),
    onBridgeEvent: vi.fn((callback: (next: InfohubBridgeStatus) => void) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge, call, listeners };
}

function resetStore() {
  // 采集桥事件订阅是 store 级单例：用例之间必须显式退订，否则上一个用例的 mock 会被复用。
  useInfohubStore.getState().resetBridge();
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
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
    vi.unstubAllGlobals();
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
    expect(call).toHaveBeenCalledWith("status", {}, { home: HOME });
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

  it("canUseInfohub 同时要求桌面桥与运行态", async () => {
    useInfohubStore.setState({ running: true });
    expect(canUseInfohub()).toBe(false); // 没有桌面桥，running 再真也不能用

    installBridge({ running: true });
    useInfohubStore.setState({ running: false });
    expect(canUseInfohub()).toBe(false);
    useInfohubStore.setState({ running: true });
    expect(canUseInfohub()).toBe(true);
  });

  describe("采集桥（d.96）", () => {
    it("refreshBridge：读 IPC 状态，事件订阅只挂一次", async () => {
      const { bridge, listeners } = installBridge({
        bridgeStatus: bridgeStatus({
          running: true,
          source: "app",
          port: 8776,
          url: "http://127.0.0.1:8776/mcp",
        }),
      });

      await useInfohubStore.getState().refreshBridge();
      await useInfohubStore.getState().refreshBridge();

      expect(bridge.bridgeStatus).toHaveBeenCalledTimes(2);
      expect(bridge.onBridgeEvent).toHaveBeenCalledTimes(1);
      expect(listeners).toHaveLength(1);
      expect(useInfohubStore.getState().bridgeStatus).toMatchObject({ running: true, source: "app" });
      expect(useInfohubStore.getState().bridgeBusy).toBe("");
    });

    it("refreshBridge：读状态失败留可读错误，不把归档运行态打回未连接", async () => {
      installBridge({
        running: true,
        bridgeStatusError: new Error(
          "Error invoking remote method 'infohub:bridge-status': Error: 主进程忙",
        ),
      });
      useInfohubStore.setState({ running: true }); // 归档边车已连：采集桥失败与它无关
      await useInfohubStore.getState().refreshBridge();

      expect(useInfohubStore.getState()).toMatchObject({
        bridgeError: "主进程忙",
        bridgeBusy: "",
        running: true,
      });
    });

    it("startBridge：用户显式启动，转发配置并更新运行态", async () => {
      const { bridge } = installBridge();
      await useInfohubStore.getState().startBridge({ home: HOME });

      expect(bridge.bridgeStart).toHaveBeenCalledWith({ home: HOME });
      expect(useInfohubStore.getState()).toMatchObject({
        bridgeStatus: expect.objectContaining({ running: true, source: "app" }),
        bridgeBusy: "",
        bridgeError: "",
      });
    });

    it("startBridge：失败保留未运行并给出剥掉 IPC 前缀的原因", async () => {
      installBridge({
        startError: new Error(
          "Error invoking remote method 'infohub:bridge-start': Error: 端口 8776 已被占用",
        ),
      });
      await useInfohubStore.getState().startBridge();

      expect(useInfohubStore.getState()).toMatchObject({
        bridgeStatus: null,
        bridgeBusy: "",
        bridgeError: "端口 8776 已被占用",
      });
    });

    it("stopBridge：停止后回到未运行；外部进程不代关并给出说明", async () => {
      const { bridge } = installBridge();
      await useInfohubStore.getState().refreshBridge();
      await useInfohubStore.getState().stopBridge();

      expect(bridge.bridgeStop).toHaveBeenCalledTimes(1);
      expect(useInfohubStore.getState().bridgeStatus).toMatchObject({ running: false, source: "none" });

      const external = installBridge({ stopResult: false });
      await useInfohubStore.getState().stopBridge();
      expect(external.bridge.bridgeStop).toHaveBeenCalledTimes(1);
      expect(useInfohubStore.getState().bridgeError).toMatch(/外部进程/);
    });

    it("事件推送：主进程推新状态即更新 store，刷新不重复订阅", async () => {
      const running = bridgeStatus({
        running: true,
        source: "app",
        port: 8776,
        url: "http://127.0.0.1:8776/mcp",
      });
      const { listeners } = installBridge();
      await useInfohubStore.getState().refreshBridge();
      expect(listeners).toHaveLength(1);

      listeners[0]?.(running);
      expect(useInfohubStore.getState().bridgeStatus).toMatchObject({ running: true, source: "app" });

      await useInfohubStore.getState().refreshBridge(); // 页面重挂 / 手动刷新不重复挂监听
      expect(listeners).toHaveLength(1);
    });

    it("resetBridge：退订事件并清空桥运行态；之后再刷新会重新订阅", async () => {
      const { bridge, listeners } = installBridge();
      await useInfohubStore.getState().refreshBridge();
      expect(listeners).toHaveLength(1);

      useInfohubStore.getState().resetBridge();
      expect(listeners).toHaveLength(0);
      expect(useInfohubStore.getState().bridgeStatus).toBeNull();
      expect(useInfohubStore.getState().bridgeBusy).toBe("");

      await useInfohubStore.getState().refreshBridge();
      expect(bridge.onBridgeEvent).toHaveBeenCalledTimes(2);
    });

    it("浏览器端 probeBridge：探测成功/失败都写进运行态，不依赖桌面桥", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ name: "infohub-mcp" }) })),
      );
      try {
        await useInfohubStore.getState().probeBridge();
        expect(useInfohubStore.getState().bridgeProbe).toEqual({ ok: true, name: "infohub-mcp" });
        expect(useInfohubStore.getState().bridgeProbedAt).not.toBeNull();
        expect(useInfohubStore.getState().bridgeError).toBe("");

        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("ECONNREFUSED");
          }),
        );
        await useInfohubStore.getState().probeBridge();
        expect(useInfohubStore.getState().bridgeProbe).toMatchObject({ ok: false });
        expect(useInfohubStore.getState().bridgeError).toMatch(/无法连接本机采集桥/);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(useInfohubStore.getState().bridgeBusy).toBe("");
    });

    it("桌面端 probeBridge 退化为读 IPC，不发网络探测", async () => {
      const { bridge } = installBridge();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await useInfohubStore.getState().probeBridge();
        expect(bridge.bridgeStatus).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(useInfohubStore.getState().bridgeProbe).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
