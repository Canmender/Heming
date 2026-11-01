import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useInfohubStore, canUseInfohub } from "./store.js";
import type { InfohubBridgeInfo, InfohubStatus } from "./client.js";

/**
 * 共享运行态（d.46）的两条硬约束：
 *
 * 1. `boot()` 只探测，**绝不**拉起 Python 子进程——自动 spawn 会越过用户意图；
 * 2. 只有 `connect()`（用户显式点连接）才能启动，失败必须回可读错误。
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

function installBridge(options: { running?: boolean; startError?: Error } = {}) {
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
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge, call };
}

function resetStore() {
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
});
