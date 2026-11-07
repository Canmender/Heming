import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  AUTO_COLLECT_INTERVAL_MS,
  AUTO_COLLECT_KEY,
  COLLECTOR_PLUGIN_ID,
  collectorPluginActive,
  createAutoCollectStore,
  formatAutoCollectStatus,
  readAutoCollectEnabled,
  shouldCollectNow,
  summarizeSyncResult,
  useAutoCollect,
  useAutoCollectStore,
  writeAutoCollectEnabled,
  type AutoCollectDeps,
} from "./autoCollect.js";
import { pluginStore, type InstalledPlugin, type PluginContributionKind } from "../plugins/store.js";
import { useInfohubStore } from "./store.js";
import type {
  InfohubBridgeApi,
  InfohubBridgeInfo,
  InfohubBridgeStatus,
  InfohubSyncResult,
} from "./client.js";

/**
 * 「装插件后自动采集」（d.98）的约定：
 *
 * - 插件生效 + 自动采集开 + 桌面端才真采集；浏览器端一个进程都不拉；
 * - 安装/启用立刻补一次，此后每 30 分钟一次，上一轮没结束不开下一轮；
 * - 失败只记中文原因，等满一个间隔再试（不重试风暴）；
 * - localStorage 只存开关，不存归档正文。
 *
 * 纯逻辑用 `createAutoCollectStore` 注入 deps（可控时钟/调用记录）；hook 用真实
 * 单例 + 真实 pluginStore（验证事件接线），client 层用 `window.__heming_infohub`
 * 假桥（与 store/scheduler 测试同口径），不 spawn 任何进程、不真等 30 分钟。
 */

type Bridge = NonNullable<Window["__heming_infohub"]> & InfohubBridgeApi;

const NOW = Date.UTC(2026, 10, 7, 8, 0, 0);

/** 与 plugins/infohub-collector/plugin.json 同形的 v3 清单（只留采集必需项）。 */
const COLLECTOR_MANIFEST = {
  schemaVersion: 3,
  id: COLLECTOR_PLUGIN_ID,
  name: "信息采集中枢",
  version: "1.0.0",
  author: "和鸣",
  permissions: { network: ["127.0.0.1:8776"], tools: "write", files: [] },
  contributions: {
    skills: [],
    mcpServers: [{ key: "infohub", name: "信息采集中枢（本机采集桥）", url: "http://127.0.0.1:8776/mcp" }],
  },
};

function bridgeStatus(overrides: Partial<InfohubBridgeStatus> = {}): InfohubBridgeStatus {
  return {
    running: true,
    starting: false,
    url: "http://127.0.0.1:8776/mcp",
    port: 8776,
    home: "D:\\archive",
    python: "python.exe",
    pythonSource: "configured",
    source: "app",
    since: NOW,
    error: null,
    ...overrides,
  };
}

function bridgeInfo(overrides: Partial<InfohubBridgeInfo> = {}): InfohubBridgeInfo {
  return {
    packageDir: "D:\\Heming\\packages\\infohub",
    defaultHome: "D:\\archive",
    bundledPython: null,
    running: true,
    pid: 1234,
    home: "D:\\archive",
    python: "python.exe",
    pythonSource: "configured",
    startedAt: NOW,
    methods: ["status", "sync", "agenda"],
    ...overrides,
  };
}

function syncResult(overrides: Partial<InfohubSyncResult> = {}): InfohubSyncResult {
  return {
    reports: [
      { source: "qq", conversations: 1, added: 2, updated: 0, skipped: 0, errors: [], elapsed: 10 },
    ],
    agenda: null,
    kb: null,
    ...overrides,
  };
}

/** 只填 `collectorPluginActive` 读到的字段；其余按空值补齐（不物化技能/服务）。 */
function collectorPlugin(
  options: { enabled?: boolean; disabledKinds?: PluginContributionKind[] } = {},
): InstalledPlugin {
  return {
    manifest: { id: COLLECTOR_PLUGIN_ID } as InstalledPlugin["manifest"],
    enabled: options.enabled ?? true,
    disabledKinds: options.disabledKinds ?? [],
    skillIds: [],
    serverIds: [],
    fingerprint: "",
    publisher: null,
    signature: null,
    installedAt: "",
    updatedAt: "",
  };
}

function makeDeps(overrides: Partial<AutoCollectDeps> = {}): AutoCollectDeps {
  return {
    now: () => NOW,
    available: () => true,
    plugins: () => [collectorPlugin()],
    start: vi.fn(async () => bridgeInfo()),
    adopt: vi.fn(),
    startBridge: vi.fn(async () => bridgeStatus()),
    sync: vi.fn(async () => syncResult()),
    refreshStats: vi.fn(async () => {}),
    intervalMs: AUTO_COLLECT_INTERVAL_MS,
    ...overrides,
  };
}

/** 假桥：只回本地 IPC 该回的形状，记录调用；不会 spawn 任何进程。 */
function installBridge() {
  const call = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "sync") return syncResult();
    if (method === "status") {
      return { stats: { conversations: 1, messages: 2, per_source: { qq: 1 } } };
    }
    if (method === "agenda") {
      return { items: [], summary: { overdue: 0, today: 0, week: 0, total: 0 } };
    }
    return {};
  });
  const bridge = {
    info: vi.fn(async () => bridgeInfo()),
    start: vi.fn(async () => bridgeInfo()),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
    bridgeStatus: vi.fn(async () => bridgeStatus()),
    bridgeStart: vi.fn(async () => bridgeStatus()),
    bridgeStop: vi.fn(async () => true),
    onBridgeEvent: vi.fn(() => () => {}),
  };
  (window as unknown as { __heming_infohub?: unknown }).__heming_infohub = bridge;
  return { bridge, call };
}

/** 微任务排空：hook 里的 runNow 链（start→sync→refresh）都是立刻 resolve 的假桥调用。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function resetInfohubStore(): void {
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
    busy: "",
    error: "",
    bridgeStatus: null,
    bridgeBusy: "",
    bridgeError: "",
    bridgeProbe: null,
    bridgeProbedAt: null,
  });
}

function resetAutoCollectStore(): void {
  useAutoCollectStore.setState({
    pluginActive: false,
    enabled: true,
    running: false,
    lastRunAt: null,
    lastStatus: "idle",
    lastMessage: "",
    nextRunAt: null,
  });
}

describe("自动采集 · 偏好（localStorage 只存开关）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("默认开启，且不写任何东西", () => {
    expect(readAutoCollectEnabled()).toBe(true);
    expect(localStorage.getItem(AUTO_COLLECT_KEY)).toBeNull();
  });

  it("关闭后读回 false，且只存 { enabled }（不落归档正文）", () => {
    writeAutoCollectEnabled(false);
    expect(readAutoCollectEnabled()).toBe(false);
    const raw = localStorage.getItem(AUTO_COLLECT_KEY) as string;
    expect(JSON.parse(raw)).toEqual({ enabled: false });
    expect(raw).not.toContain("消息");
  });

  it("脏值（非 JSON / 字段类型不对 / 数组）一律回落默认开启", () => {
    localStorage.setItem(AUTO_COLLECT_KEY, "not-json");
    expect(readAutoCollectEnabled()).toBe(true);
    localStorage.setItem(AUTO_COLLECT_KEY, JSON.stringify({ enabled: "no" }));
    expect(readAutoCollectEnabled()).toBe(true);
    localStorage.setItem(AUTO_COLLECT_KEY, JSON.stringify([true]));
    expect(readAutoCollectEnabled()).toBe(true);
  });
});

describe("自动采集 · 插件激活判定", () => {
  it("没装插件 → 不采集", () => {
    expect(collectorPluginActive([])).toBe(false);
    expect(collectorPluginActive([collectorPlugin({ enabled: false })])).toBe(false);
  });

  it("装了且总开关开、mcpServers 贡献生效 → 采集", () => {
    expect(collectorPluginActive([collectorPlugin()])).toBe(true);
  });

  it("总开关关闭 → 不采集（与插件页读口径一致）", () => {
    expect(collectorPluginActive([collectorPlugin({ enabled: false })])).toBe(false);
  });

  it("mcpServers 贡献被单独停用 → 不采集；只停技能不影响采集", () => {
    expect(collectorPluginActive([collectorPlugin({ disabledKinds: ["mcpServers"] })])).toBe(false);
    expect(collectorPluginActive([collectorPlugin({ disabledKinds: ["skills"] })])).toBe(true);
  });
});

describe("自动采集 · 间隔判定", () => {
  it("force 时永远该采", () => {
    expect(shouldCollectNow({ now: NOW, lastRunAt: NOW - 1000, force: true })).toBe(true);
  });

  it("从没采过 → 该采", () => {
    expect(shouldCollectNow({ now: NOW, lastRunAt: null })).toBe(true);
  });

  it("不满间隔不采；正好到点就采（边界含等于）", () => {
    expect(shouldCollectNow({ now: NOW, lastRunAt: NOW - AUTO_COLLECT_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldCollectNow({ now: NOW, lastRunAt: NOW - AUTO_COLLECT_INTERVAL_MS })).toBe(true);
  });

  it("时钟回拨（lastRunAt 在未来）判为不采，避免时间跳变后连采两轮", () => {
    expect(shouldCollectNow({ now: NOW, lastRunAt: NOW + 60_000 })).toBe(false);
  });
});

describe("自动采集 · 结果摘要与状态文案", () => {
  it("摘要按来源列新增、错误只计数，不带正文", () => {
    const text = summarizeSyncResult(
      syncResult({
        reports: [
          { source: "qq", conversations: 1, added: 2, updated: 1, skipped: 0, errors: [], elapsed: 1 },
          { source: "wechat", conversations: 1, added: 3, updated: 0, skipped: 0, errors: ["a"], elapsed: 1 },
        ],
      }),
    );
    expect(text).toBe("同步完成：QQ 新增 2，微信 新增 3；1 个采集错误");
    expect(summarizeSyncResult(null)).toBe("同步完成：无新增");
  });

  it("浏览器端：只说明「只在桌面端运行」，不谎报已开启", () => {
    expect(
      formatAutoCollectStatus(
        {
          pluginActive: true,
          enabled: true,
          running: false,
          lastRunAt: null,
          lastStatus: "idle",
          lastMessage: "",
          nextRunAt: null,
        },
        { available: false },
      ),
    ).toBe("自动采集只在和鸣桌面端运行");
  });

  it("插件未启用 / 已关闭 / 正在采集 / 失败 / 正常，各给人话", () => {
    const base = {
      pluginActive: true,
      enabled: true,
      running: false,
      lastRunAt: null as number | null,
      lastStatus: "idle" as const,
      lastMessage: "",
      nextRunAt: null as number | null,
    };
    expect(formatAutoCollectStatus({ ...base, pluginActive: false }, { available: true })).toContain(
      "未启用",
    );
    expect(formatAutoCollectStatus({ ...base, enabled: false }, { available: true })).toBe(
      "自动采集已关闭",
    );
    expect(formatAutoCollectStatus({ ...base, running: true }, { available: true })).toBe(
      "正在采集本机消息…",
    );
    expect(
      formatAutoCollectStatus(
        { ...base, lastStatus: "error", lastMessage: "InfoHub 请求超时" },
        { available: true },
      ),
    ).toBe("上次自动采集失败：InfoHub 请求超时");
    expect(
      formatAutoCollectStatus(
        {
          ...base,
          lastRunAt: NOW - 5 * 60_000,
          lastStatus: "ok",
          lastMessage: "同步完成：QQ 新增 2",
          nextRunAt: NOW + 25 * 60_000,
        },
        { now: NOW, available: true },
      ),
    ).toBe("上次自动采集：5 分钟前（同步完成：QQ 新增 2）；下次约 25 分钟后");
  });
});

describe("自动采集 · runNow（依赖注入）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("成功：先保桥、再拉起边车、sync、刷新统计，并记录时间与摘要", async () => {
    const deps = makeDeps();
    const store = createAutoCollectStore(deps);

    await store.getState().runNow("manual");

    expect(deps.startBridge).toHaveBeenCalledTimes(1);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.adopt).toHaveBeenCalledTimes(1);
    expect(deps.refreshStats).toHaveBeenCalledTimes(1);
    const state = store.getState();
    expect(state.running).toBe(false);
    expect(state.lastStatus).toBe("ok");
    expect(state.lastRunAt).toBe(NOW);
    expect(state.nextRunAt).toBe(NOW + AUTO_COLLECT_INTERVAL_MS);
    expect(state.lastMessage).toBe("同步完成：QQ 新增 2");
  });

  it("防重入：上一轮没结束，第二次 runNow 直接返回", async () => {
    let resolveSync!: (value: InfohubSyncResult) => void;
    const sync = vi.fn(
      () =>
        new Promise<InfohubSyncResult>((resolve) => {
          resolveSync = resolve;
        }),
    );
    const store = createAutoCollectStore(makeDeps({ sync }));

    const first = store.getState().runNow("manual");
    await flush();
    expect(store.getState().running).toBe(true);
    await store.getState().runNow("manual");
    expect(sync).toHaveBeenCalledTimes(1);

    resolveSync(syncResult());
    await first;
    expect(store.getState().running).toBe(false);
    expect(store.getState().lastStatus).toBe("ok");
  });

  it("失败：记中文原因与时间点，下一轮等满间隔（不立刻重试）", async () => {
    const deps = makeDeps({ sync: vi.fn(async () => Promise.reject(new Error("InfoHub 请求超时"))) });
    const store = createAutoCollectStore(deps);

    await store.getState().runNow("manual");
    const failed = store.getState();
    expect(failed.running).toBe(false);
    expect(failed.lastStatus).toBe("error");
    expect(failed.lastMessage).toBe("InfoHub 请求超时");
    expect(failed.lastRunAt).toBe(NOW);
    expect(failed.nextRunAt).toBe(NOW + AUTO_COLLECT_INTERVAL_MS);

    // 失败后间隔未到：定时器到点也不重试（不重试风暴）
    await store.getState().runNow("schedule");
    expect(deps.sync).toHaveBeenCalledTimes(1);
  });

  it("边车拉不起来 → sync 不调用，错误如实记录", async () => {
    const deps = makeDeps({ start: vi.fn(async () => Promise.reject(new Error("没有 Python"))) });
    const store = createAutoCollectStore(deps);

    await store.getState().runNow("manual");
    expect(deps.sync).not.toHaveBeenCalled();
    expect(store.getState().lastStatus).toBe("error");
    expect(store.getState().lastMessage).toBe("没有 Python");
  });

  it("采集桥失败不阻塞采集：sync 照跑，桥错误只写进摘要", async () => {
    const deps = makeDeps({
      startBridge: vi.fn(async () => Promise.reject(new Error("8776 被占用"))),
    });
    const store = createAutoCollectStore(deps);

    await store.getState().runNow("manual");
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(store.getState().lastStatus).toBe("ok");
    expect(store.getState().lastMessage).toContain("采集桥启动失败：8776 被占用");
  });

  it("浏览器端：一个进程都不拉，只把状态记为不可用", async () => {
    const deps = makeDeps({ available: () => false });
    const store = createAutoCollectStore(deps);

    await store.getState().runNow("manual");
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
    expect(deps.sync).not.toHaveBeenCalled();
    expect(store.getState().lastRunAt).toBeNull();
    expect(store.getState().lastMessage).toBe("自动采集只在和鸣桌面端运行");
  });

  it("插件未启用：不采集，状态说明原因", async () => {
    const deps = makeDeps({ plugins: () => [] });
    const store = createAutoCollectStore(deps);
    store.getState().refresh();

    await store.getState().runNow("install");
    expect(deps.sync).not.toHaveBeenCalled();
    expect(store.getState().pluginActive).toBe(false);
    expect(store.getState().lastMessage).toContain("未启用");
  });

  it("schedule 看间隔；manual 是用户显式动作，关掉自动采集也照跑", async () => {
    const deps = makeDeps();
    const store = createAutoCollectStore(deps);

    store.setState({ lastRunAt: NOW - 1_000 });
    await store.getState().runNow("schedule");
    expect(deps.sync).not.toHaveBeenCalled();

    store.setState({ lastRunAt: NOW - AUTO_COLLECT_INTERVAL_MS });
    await store.getState().runNow("schedule");
    expect(deps.sync).toHaveBeenCalledTimes(1);

    store.getState().setEnabled(false);
    await store.getState().runNow("schedule");
    expect(deps.sync).toHaveBeenCalledTimes(1);
    await store.getState().runNow("manual");
    expect(deps.sync).toHaveBeenCalledTimes(2);
  });

  it("setEnabled 写偏好；关闭时清掉 nextRunAt", () => {
    const store = createAutoCollectStore(makeDeps());
    store.setState({ nextRunAt: NOW + 1000 });

    store.getState().setEnabled(false);
    expect(store.getState().enabled).toBe(false);
    expect(store.getState().nextRunAt).toBeNull();
    expect(readAutoCollectEnabled()).toBe(false);

    store.getState().setEnabled(true);
    expect(store.getState().enabled).toBe(true);
    expect(readAutoCollectEnabled()).toBe(true);
  });

  it("refresh 重算 pluginActive（插件停用/卸载后立刻反映）", () => {
    let plugins: InstalledPlugin[] = [];
    const store = createAutoCollectStore(makeDeps({ plugins: () => plugins }));

    store.getState().refresh();
    expect(store.getState().pluginActive).toBe(false);

    plugins = [collectorPlugin()];
    store.getState().refresh();
    expect(store.getState().pluginActive).toBe(true);

    plugins = [collectorPlugin({ enabled: false })];
    store.getState().refresh();
    expect(store.getState().pluginActive).toBe(false);
  });
});

describe("自动采集 · useAutoCollect（事件接线）", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    pluginStore.remove(COLLECTOR_PLUGIN_ID);
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetInfohubStore();
    resetAutoCollectStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    pluginStore.remove(COLLECTOR_PLUGIN_ID);
    resetAutoCollectStore();
  });

  it("插件已装 + 桌面端：挂载即补一次采集", async () => {
    const { bridge } = installBridge();
    pluginStore.install(COLLECTOR_MANIFEST);

    renderHook(() => useAutoCollect(true));
    await flush();

    expect(bridge.call).toHaveBeenCalledWith("sync", {}, {});
    const state = useAutoCollectStore.getState();
    expect(state.pluginActive).toBe(true);
    expect(state.lastStatus).toBe("ok");
    expect(state.lastRunAt).toBe(NOW);
  });

  it("此后每 30 分钟一次；不满 30 分钟不加采", async () => {
    const { bridge } = installBridge();
    pluginStore.install(COLLECTOR_MANIFEST);
    renderHook(() => useAutoCollect(true));
    await flush();
    const syncCalls = (): number =>
      (bridge.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (args) => args[0] === "sync",
      ).length;
    expect(syncCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(AUTO_COLLECT_INTERVAL_MS);
    await flush();
    expect(syncCalls()).toBe(2);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await flush();
    expect(syncCalls()).toBe(2);
  });

  it("安装插件事件 → 立刻采集一次（reason install，不等 30 分钟）", async () => {
    const { bridge } = installBridge();
    renderHook(() => useAutoCollect(true));
    await flush();
    expect(useAutoCollectStore.getState().lastRunAt).toBeNull();

    pluginStore.install(COLLECTOR_MANIFEST);
    await flush();

    const syncs = (bridge.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (args) => args[0] === "sync",
    );
    expect(syncs).toHaveLength(1);
    expect(useAutoCollectStore.getState().lastStatus).toBe("ok");
  });

  it("停用/卸载插件 → 停循环并重算；重新启用 → 立刻再采一次", async () => {
    const { bridge } = installBridge();
    pluginStore.install(COLLECTOR_MANIFEST);
    renderHook(() => useAutoCollect(true));
    await flush();
    const syncCalls = (): number =>
      (bridge.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (args) => args[0] === "sync",
      ).length;
    expect(syncCalls()).toBe(1);

    pluginStore.setEnabled(COLLECTOR_PLUGIN_ID, false);
    await flush();
    expect(useAutoCollectStore.getState().pluginActive).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTO_COLLECT_INTERVAL_MS * 2);
    await flush();
    expect(syncCalls()).toBe(1); // 定时器已停

    pluginStore.setEnabled(COLLECTOR_PLUGIN_ID, true);
    await flush();
    expect(useAutoCollectStore.getState().pluginActive).toBe(true);
    expect(syncCalls()).toBe(2); // 重新启用立刻补一次

    pluginStore.remove(COLLECTOR_PLUGIN_ID);
    await flush();
    expect(useAutoCollectStore.getState().pluginActive).toBe(false);
  });

  it("浏览器端（无桌面桥）：不拉起任何进程，状态记为不可用", async () => {
    pluginStore.install(COLLECTOR_MANIFEST);
    renderHook(() => useAutoCollect(true));
    await flush();

    expect(useInfohubStore.getState().running).toBe(false);
    expect(useAutoCollectStore.getState().lastRunAt).toBeNull();
    expect(useAutoCollectStore.getState().lastMessage).toBe("自动采集只在和鸣桌面端运行");

    await vi.advanceTimersByTimeAsync(AUTO_COLLECT_INTERVAL_MS * 2);
    await flush();
    expect(useAutoCollectStore.getState().lastRunAt).toBeNull();
  });

  it("页面关掉自动采集 → 定时器停；再打开 → 补一拍", async () => {
    const { bridge } = installBridge();
    pluginStore.install(COLLECTOR_MANIFEST);
    renderHook(() => useAutoCollect(true));
    await flush();
    const syncCalls = (): number =>
      (bridge.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (args) => args[0] === "sync",
      ).length;
    expect(syncCalls()).toBe(1);

    useAutoCollectStore.getState().setEnabled(false);
    await vi.advanceTimersByTimeAsync(AUTO_COLLECT_INTERVAL_MS * 2);
    await flush();
    expect(syncCalls()).toBe(1);

    useAutoCollectStore.getState().setEnabled(true);
    await flush();
    expect(syncCalls()).toBe(2);
  });

  it("其它插件的变化不额外触发采集（事件是全局的）", async () => {
    const { bridge } = installBridge();
    pluginStore.install(COLLECTOR_MANIFEST);
    renderHook(() => useAutoCollect(true));
    await flush();
    const syncCalls = (): number =>
      (bridge.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (args) => args[0] === "sync",
      ).length;
    expect(syncCalls()).toBe(1);

    pluginStore.install({
      schemaVersion: 3,
      id: "acme.other",
      name: "其它插件",
      version: "1.0.0",
      author: "Acme",
      contributions: { skills: [{ name: "其它技能", instructions: "别的能力。" }] },
    });
    await flush();
    expect(syncCalls()).toBe(1);
    expect(useAutoCollectStore.getState().pluginActive).toBe(true);
    pluginStore.remove("acme.other");
  });

  it("active=false（未登录/模块停用/浏览器）不挂循环、不监听", async () => {
    const { bridge } = installBridge();
    pluginStore.install(COLLECTOR_MANIFEST);

    renderHook(() => useAutoCollect(false));
    await vi.advanceTimersByTimeAsync(AUTO_COLLECT_INTERVAL_MS * 2);
    await flush();
    expect(bridge.call).not.toHaveBeenCalled();
    expect(useAutoCollectStore.getState().lastRunAt).toBeNull();
  });
});
