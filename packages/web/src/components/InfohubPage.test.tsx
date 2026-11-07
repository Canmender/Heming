import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InfohubPage } from "./InfohubPage.js";
import { useUiStore } from "../store/ui.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import {
  formatInfohubTime,
  type InfohubAgendaItem,
  type InfohubBridgeApi,
  type InfohubBridgeInfo,
  type InfohubBridgeStatus,
  type InfohubStatus,
} from "../lib/infohub/client.js";
import { useAutoCollectStore } from "../lib/infohub/autoCollect.js";

/**
 * d.97 自动采集 store（T5 的 `lib/infohub/autoCollect.ts`）在页面测试里用同契约的
 * 真实 zustand store 顶替：页面只负责「读状态 / 投动作」，真正的 30 分钟循环与采集
 * 由 autoCollect 自己的测试覆盖。每个用例前重置状态与调用记录，避免跨用例污染。
 */
const autoCollectMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  setEnabled: vi.fn(),
  runNow: vi.fn(async () => {}),
}));

type AutoCollectStatus = "idle" | "ok" | "error";

const AUTO_COLLECT_DEFAULT_STATE = {
  pluginActive: true,
  enabled: true,
  running: false,
  lastRunAt: null as number | null,
  lastStatus: "idle" as AutoCollectStatus,
  lastMessage: "",
  nextRunAt: null as number | null,
};

vi.mock("../lib/infohub/autoCollect.js", async () => {
  const { create } = await import("zustand");
  // 默认值与页面测试里的 AUTO_COLLECT_DEFAULT_STATE 保持一致；工厂会被提升，
  // 不能引用模块作用域的常量，所以这里写一份字面量。
  return {
    COLLECTOR_PLUGIN_ID: "heming.infohub-collector",
    AUTO_COLLECT_INTERVAL_MS: 30 * 60_000,
    AUTO_COLLECT_KEY: "heming.infohub.autoCollect.v1",
    useAutoCollectStore: create<{
      pluginActive: boolean;
      enabled: boolean;
      running: boolean;
      lastRunAt: number | null;
      lastStatus: AutoCollectStatus;
      lastMessage: string;
      nextRunAt: number | null;
      refresh: typeof autoCollectMocks.refresh;
      setEnabled: typeof autoCollectMocks.setEnabled;
      runNow: typeof autoCollectMocks.runNow;
    }>(() => ({
      pluginActive: true,
      enabled: true,
      running: false,
      lastRunAt: null,
      lastStatus: "idle",
      lastMessage: "",
      nextRunAt: null,
      ...autoCollectMocks,
    })),
  };
});

function setAutoCollect(overrides: Partial<typeof AUTO_COLLECT_DEFAULT_STATE> = {}) {
  useAutoCollectStore.setState({ ...AUTO_COLLECT_DEFAULT_STATE, ...overrides });
}

const HOME = "D:\\wohaolei";

const status: InfohubStatus = {
  home: HOME,
  configPath: `${HOME}\\config.json`,
  configExists: true,
  dbPath: `${HOME}\\data\\archive.db`,
  hasDb: true,
  config: {
    dataDir: `${HOME}\\data`,
    configPath: `${HOME}\\config.json`,
    wechat: { enabled: true, dbDir: "" },
    qq: { enabled: true, mode: "nt", ntAccount: "" },
    voice: { enabled: true },
    kb: { vault: "", autoExport: true },
    digest: { enabled: true, intervalMin: 60 },
    agent: { enabled: true },
    push: { enabled: false, channel: "smtp", hasCredentials: false },
    llm: { enabled: false, baseUrl: "", model: "", hasKey: false, allowRemote: false },
  },
  stats: { conversations: 1, messages: 2, per_source: { qq: 1 } },
  sources: { qq: { status: "ok", lastRun: 1800000000, detail: "" } },
  events: 1,
  media: {},
  dbBytes: 2048,
  lastMessageTs: 1800000100,
};

const agendaItem: InfohubAgendaItem = {
  id: 7,
  messageId: 1,
  conversationId: 25,
  title: "补交材料",
  detail: "周五前交到办公室",
  dueTs: Math.floor(Date.now() / 1000) + 86400,
  dueText: "11-03 18:00",
  allDay: false,
  kind: "deadline",
  status: "open",
  convName: "叶老师",
  source: "qq",
  senderName: "叶老师",
  msgTs: 1800000100,
};

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

function bridgeInfo(overrides: Partial<InfohubBridgeInfo> = {}): InfohubBridgeInfo {
  return {
    packageDir: "D:\\Heming\\packages\\infohub",
    defaultHome: "C:\\Users\\x\\Heming\\infohub",
    bundledPython: "C:\\py\\python.exe",
    running: false,
    pid: null,
    home: null,
    python: null,
    pythonSource: null,
    startedAt: 0,
    methods: ["status", "search", "agenda"],
    ...overrides,
  };
}

function installBridge(overrides: Partial<Bridge> = {}) {
  const call = vi.fn(async (method: string) => {
    if (method === "status") return status;
    if (method === "search") {
      return {
        items: [
          {
            id: 1,
            conversationId: 25,
            ts: 1800000100,
            senderName: "叶老师",
            content: "请把免检单交上来",
            snippet: "请把<<免检单>>交上来",
            convName: "叶老师",
            source: "qq",
          },
        ],
        query: "免检单",
      };
    }
    if (method === "agenda") {
      return {
        items: [agendaItem],
        summary: { overdue: 1, today: 0, week: 1, total: 1 },
      };
    }
    if (method === "sync") return { reports: [], agenda: 1, kb: null };
    return undefined;
  });

  const bridge = {
    info: vi.fn(async () => bridgeInfo()),
    start: vi.fn(async () =>
      bridgeInfo({ running: true, pid: 4321, home: HOME, python: "C:\\py\\python.exe", pythonSource: "bundled" }),
    ),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => "D:\\picked"),
    pickPython: vi.fn(async () => "D:\\py\\python.exe"),
    onEvent: vi.fn(() => () => {}),
    bridgeStatus: vi.fn(async () => bridgeStatus()),
    bridgeStart: vi.fn(async () =>
      bridgeStatus({ running: true, source: "app", port: 8776, url: "http://127.0.0.1:8776/mcp" }),
    ),
    bridgeStop: vi.fn(async () => true),
    onBridgeEvent: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as Bridge;

  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge, call };
}

async function connectPage() {
  render(<InfohubPage />);
  fireEvent.click(screen.getByRole("button", { name: "连接" }));
  await waitFor(() => expect(screen.getByText("已连接 · 只读归档")).toBeInTheDocument());
}

describe("信息中枢页", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    // 采集桥事件订阅是 store 级单例：每例前退订，避免上个用例的 mock 被复用。
    useInfohubStore.getState().resetBridge();
    useUiStore.setState({
      page: "home",
      activeConversationId: null,
      infohubIntent: null,
      automationIntent: null,
    });
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
    // d.97 自动采集 store 也是模块单例：每例前清掉调用记录、还原「插件已启用、自动采集开」，
    // 否则上一个用例留下的插件/开关状态会串到下一个用例。
    vi.clearAllMocks();
    setAutoCollect();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器环境：明确提示仅桌面端可用，不回退云端", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    render(<InfohubPage />);
    // 与其他页一致的页头（不再是一张孤立卡片落在空白页上）
    expect(screen.getByRole("heading", { name: "信息中枢", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("信息中枢仅桌面端可用")).toBeInTheDocument();
    expect(screen.getByText(/在桌面版安装包里打开「信息中枢」/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "连接" })).not.toBeInTheDocument();
    // d.96 采集桥：浏览器只能探测，如实显示「未检测到」，不假装可用
    expect(await screen.findByText("未检测到本机采集桥")).toBeInTheDocument();
  });

  it("连接后展示归档规模，不提供会话浏览入口", async () => {
    const { bridge, call } = installBridge();
    await connectPage();

    expect(bridge.start).toHaveBeenCalledWith({});
    expect(call).toHaveBeenCalledWith("status", {}, expect.anything());
    // 去 IM：连接时不再拉会话列表或消息
    expect(call.mock.calls.some(([method]) => method === "conversations")).toBe(false);
    expect(call.mock.calls.some(([method]) => method === "messages")).toBe(false);

    expect(screen.getByText("1")).toBeInTheDocument(); // 归档会话数
    expect(screen.getByText("2")).toBeInTheDocument(); // 消息数
    expect(screen.queryByRole("tab", { name: "会话" })).not.toBeInTheDocument();
    expect(screen.queryByText("群聊")).not.toBeInTheDocument();
    expect(screen.queryByText("私聊")).not.toBeInTheDocument();
    // 配置区只显示「是否配置过」，不出现任何密钥值
    expect(screen.getByText(/推送：smtp（无凭据）/)).toBeInTheDocument();
    expect(screen.getByText(/模型：未设置（无 Key）/)).toBeInTheDocument();
    // 页面状态同步到共享 store：首页卡与归档工具读的是同一份
    await waitFor(() => expect(useInfohubStore.getState().status).not.toBeNull());
    expect(useInfohubStore.getState().running).toBe(true);
  });

  it("边车已在跑（自动采集拉起）：进入页面直接挂上，并把解释器一起带上", async () => {
    const { bridge, call } = installBridge({
      info: vi.fn(async () =>
        bridgeInfo({
          running: true,
          pid: 4321,
          home: "D:\\temp-home",
          python: "D:\\py\\python.exe",
          pythonSource: "configured",
        }),
      ),
    });
    render(<InfohubPage />);
    await waitFor(() => expect(screen.getByText("已连接 · 只读归档")).toBeInTheDocument());
    // d.97 真机自检抓到的回归：少传 python 会被主进程当成另一个目标重开边车，
    // 在没有内置运行时的机器上直接报「未找到可用的 Python 解释器」。
    expect(call).toHaveBeenCalledWith(
      "status",
      {},
      { home: "D:\\temp-home", python: "D:\\py\\python.exe" },
    );
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("自动采集在页面挂载后才拉起边车：共享 store 变为运行中时页面自动连接", async () => {
    const { bridge } = installBridge();
    render(<InfohubPage />);
    // 挂载那一刻主进程还没开始跑（安装插件即采是异步的），页面保持「未连接」。
    expect(await screen.findByRole("button", { name: "连接" })).toBeInTheDocument();
    expect(screen.queryByText("已连接 · 只读归档")).not.toBeInTheDocument();

    // 自动采集拉起边车 → 共享 store 变 running → 页面不再要求用户手动连接。
    useInfohubStore.setState({
      running: true,
      info: bridgeInfo({ running: true, pid: 4321, home: "D:\\temp-home", python: "D:\\py\\python.exe" }),
    });
    await waitFor(() => expect(screen.getByText("已连接 · 只读归档")).toBeInTheDocument());
    expect(bridge.start).toHaveBeenCalled();
  });

  it("检索：命中词高亮，结果只读展示、不再跳会话", async () => {
    installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("tab", { name: "检索" }));
    fireEvent.change(screen.getByLabelText("在归档中检索"), { target: { value: "免检单" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    const mark = await screen.findByText("免检单");
    expect(mark.tagName).toBe("MARK");
    expect(mark.closest("button")).toBeNull();
    expect(screen.queryByText("免检单记得交")).not.toBeInTheDocument();
  });

  it("日程：展示逾期统计与事项，可手动重扫", async () => {
    const { call } = installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("tab", { name: /日程/ }));
    expect(await screen.findByText("补交材料")).toBeInTheDocument();
    expect(screen.getByText("逾期 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重扫议程" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "agenda",
        expect.objectContaining({ rebuild: true }),
        expect.anything(),
      ),
    );
  });

  it("同步：显式选择来源后调用 sync，结束后刷新数据", async () => {
    const { bridge, call } = installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("button", { name: "同步" }));
    fireEvent.click(screen.getByRole("button", { name: "开始同步" }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "sync",
        { sources: ["qq", "wechat"], full: false, archive: false },
        expect.anything(),
      ),
    );
    const statusCalls = call.mock.calls.filter(([method]) => method === "status").length;
    await waitFor(() => expect(statusCalls).toBeGreaterThan(1));
    expect(bridge.call).toHaveBeenCalled();
  });

  it("断开：回收进程并回到连接面板", async () => {
    const { bridge } = installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "连接" })).toBeInTheDocument();
    expect(useInfohubStore.getState()).toMatchObject({ running: false, status: null, agenda: null });
  });

  it("连接失败：显示可读错误并可重试", async () => {
    installBridge({
      start: vi.fn(async () => {
        throw new Error("Error invoking remote method 'infohub:start': Error: 未找到可用的 Python 解释器");
      }),
    });
    render(<InfohubPage />);
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(await screen.findByText("未找到可用的 Python 解释器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连接" })).toBeInTheDocument();
  });

  it("跨页意图：带检索词进入页面后自动检索并消费意图", async () => {
    localStorage.setItem("heming.infohub.home.v1", HOME);
    const { call } = installBridge({
      info: vi.fn(async () => bridgeInfo({ running: true, home: HOME })),
    });
    useUiStore.setState({
      page: "infohub",
      activeConversationId: null,
      infohubIntent: { tab: "search", query: "免检单" },
    });

    render(<InfohubPage />);

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "search",
        { query: "免检单", limit: 100 },
        { home: HOME },
      ),
    );
    expect(useUiStore.getState().infohubIntent).toBeNull();
    expect(await screen.findByText("免检单")).toBeInTheDocument(); // 命中词高亮
  });

  it("定时：把当前同步选项带进自动化页的新建表单", async () => {
    installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("button", { name: "新建定时同步" }));

    expect(useUiStore.getState().page).toBe("automations");
    expect(useUiStore.getState().automationIntent).toEqual({
      kind: "infohub.sync",
      sync: { sources: ["qq", "wechat"], full: false, archive: false },
    });
  });

  it("定时：同步面板里改过的来源与全量选项原样带过去", async () => {
    installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("button", { name: "同步" }));
    fireEvent.click(screen.getByLabelText("微信"));
    fireEvent.click(screen.getByLabelText("全量重扫"));
    fireEvent.click(screen.getByRole("button", { name: "保存为定时任务" }));

    expect(useUiStore.getState().automationIntent).toEqual({
      kind: "infohub.sync",
      sync: { sources: ["qq"], full: true, archive: false },
    });
  });

  it("定时：一个来源都没选时不投递意图", async () => {
    installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("button", { name: "同步" }));
    fireEvent.click(screen.getByLabelText("QQ"));
    fireEvent.click(screen.getByLabelText("微信"));
    fireEvent.click(screen.getByRole("button", { name: "保存为定时任务" }));

    expect(screen.getByRole("alert")).toHaveTextContent("至少选择一个采集来源");
    expect(useUiStore.getState().automationIntent).toBeNull();
    expect(useUiStore.getState().page).not.toBe("automations");
  });

  it("定时重扫：日程工具栏投递重扫意图", async () => {
    installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("tab", { name: /日程/ }));
    fireEvent.click(screen.getByRole("button", { name: "新建定时重扫" }));

    expect(useUiStore.getState().page).toBe("automations");
    expect(useUiStore.getState().automationIntent).toEqual({ kind: "infohub.agenda" });
  });

  it("跨页意图：日程意图直接落在日程页", async () => {
    localStorage.setItem("heming.infohub.home.v1", HOME);
    installBridge({
      info: vi.fn(async () => bridgeInfo({ running: true, home: HOME })),
    });
    useUiStore.setState({
      page: "infohub",
      activeConversationId: null,
      infohubIntent: { tab: "agenda" },
    });

    render(<InfohubPage />);

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /日程/ })).toHaveAttribute("aria-selected", "true"),
    );
    expect(useUiStore.getState().infohubIntent).toBeNull();
    expect(await screen.findByText("补交材料")).toBeInTheDocument();
  });

  describe("采集桥区块（d.96）", () => {
    it("桌面端未运行：显示未运行与启动按钮，且不影响归档连接区", async () => {
      installBridge();
      render(<InfohubPage />);

      expect(await screen.findByText("采集桥")).toBeInTheDocument();
      expect(await screen.findByText("未运行")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "启动采集桥" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "去插件区" })).toBeInTheDocument();
      // 说明区：只回环、自动采集由和鸣托管、写操作人工确认、归档不出本机
      expect(screen.getByText(/只监听本机回环 · 自动采集由和鸣托管 · 写操作仍走人工确认 · 归档不出本机/)).toBeInTheDocument();
      // 采集桥未运行时，归档连接照常可用
      expect(screen.getByRole("button", { name: "连接" })).toBeInTheDocument();
    });

    it("桌面端启动中：显示启动中…并禁用启动按钮", async () => {
      installBridge({
        bridgeStatus: vi.fn(async () => bridgeStatus({ starting: true })),
      });
      render(<InfohubPage />);

      expect(await screen.findByText("启动中…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "启动采集桥" })).toBeDisabled();
    });

    it("桌面端运行中（和鸣托管）：显示回环地址与托管方，可停止", async () => {
      installBridge({
        bridgeStatus: vi.fn(async () =>
          bridgeStatus({
            running: true,
            source: "app",
            port: 8776,
            url: "http://127.0.0.1:8776/mcp",
          }),
        ),
      });
      render(<InfohubPage />);

      expect(await screen.findByText("运行中 · 127.0.0.1:8776 · 由和鸣托管")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "启动采集桥" })).not.toBeInTheDocument();
    });

    it("桌面端运行中（外部进程）：不显示停止，提示去原窗口关闭", async () => {
      installBridge({
        bridgeStatus: vi.fn(async () =>
          bridgeStatus({
            running: true,
            source: "external",
            port: 8776,
            url: "http://127.0.0.1:8776/mcp",
          }),
        ),
      });
      render(<InfohubPage />);

      expect(await screen.findByText("运行中 · 外部进程")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
      expect(screen.getByText("请在你启动它的窗口里关闭")).toBeInTheDocument();
    });

    it("桌面端失败：显示主进程给的中文原因", async () => {
      installBridge({
        bridgeStatus: vi.fn(async () => bridgeStatus({ error: "端口 8776 已被占用，请先关掉占用它的进程" })),
      });
      render(<InfohubPage />);

      expect(
        await screen.findByText("失败：端口 8776 已被占用，请先关掉占用它的进程"),
      ).toBeInTheDocument();
    });

    it("桌面端：点启动后进入运行中，点停止回到未运行", async () => {
      let running = false;
      const { bridge } = installBridge({
        bridgeStatus: vi.fn(async () =>
          running
            ? bridgeStatus({
                running: true,
                source: "app",
                port: 8776,
                url: "http://127.0.0.1:8776/mcp",
              })
            : bridgeStatus(),
        ),
        bridgeStart: vi.fn(async () => {
          running = true;
          return bridgeStatus({
            running: true,
            source: "app",
            port: 8776,
            url: "http://127.0.0.1:8776/mcp",
          });
        }),
        bridgeStop: vi.fn(async () => {
          running = false;
          return true;
        }),
      });
      render(<InfohubPage />);

      fireEvent.click(await screen.findByRole("button", { name: "启动采集桥" }));
      expect(await screen.findByText("运行中 · 127.0.0.1:8776 · 由和鸣托管")).toBeInTheDocument();
      // 没有保存过目录/解释器时传空对象，由主进程回落默认值
      expect(bridge.bridgeStart).toHaveBeenCalledWith({});

      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      expect(await screen.findByText("未运行")).toBeInTheDocument();
      expect(bridge.bridgeStop).toHaveBeenCalledTimes(1);
    });

    it("浏览器端：自动探测到本机采集桥，说明不能拉起进程", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", name: "infohub-mcp" }),
        })),
      );
      render(<InfohubPage />);

      expect(await screen.findByText("检测到本机采集桥")).toBeInTheDocument();
      expect(screen.getByText(/浏览器版不能拉起进程，请在和鸣桌面端启动/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "启动采集桥" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "重新检测" })).toBeInTheDocument();
    });

    it("浏览器端：未检测到时给出原因，可重新检测", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      );
      render(<InfohubPage />);

      expect(await screen.findByText("未检测到本机采集桥")).toBeInTheDocument();
      expect(screen.getByText(/无法连接本机采集桥/)).toBeInTheDocument();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", name: "infohub-mcp" }),
        })),
      );
      fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
      expect(await screen.findByText("检测到本机采集桥")).toBeInTheDocument();
    });

    it("去插件区：入口把页面切到插件区", async () => {
      installBridge();
      render(<InfohubPage />);

      fireEvent.click(await screen.findByRole("button", { name: "去插件区" }));
      expect(useUiStore.getState().page).toBe("plugins");
    });

    it("不阻塞主流程：采集桥未启动时连接、检索、日程照常可用", async () => {
      installBridge();
      await connectPage();

      expect(screen.getByText("已连接 · 只读归档")).toBeInTheDocument();
      expect(await screen.findByText("未运行")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("在归档中检索"), { target: { value: "免检单" } });
      fireEvent.click(screen.getByRole("button", { name: "检索" }));
      expect(await screen.findByText("免检单")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: /日程/ }));
      expect(await screen.findByText("补交材料")).toBeInTheDocument();
    });
  });

  describe("自动采集（d.97）", () => {
    it("插件未启用：说明装完即自动采集，并给出去插件区的入口", async () => {
      setAutoCollect({ pluginActive: false });
      installBridge();
      render(<InfohubPage />);

      expect(await screen.findByText("插件未启用")).toBeInTheDocument();
      expect(
        screen.getByText(/安装并启用「信息采集中枢」插件后，会自动开始采集/),
      ).toBeInTheDocument();
      // 没有插件就没有可自动采集的端点：两个动作都禁用
      expect(screen.getByRole("button", { name: "关闭自动采集" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "立即采集一次" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "去插件区安装" }));
      expect(useUiStore.getState().page).toBe("plugins");
    });

    it("开关：开启状态点「关闭自动采集」调用 setEnabled(false)", async () => {
      installBridge();
      render(<InfohubPage />);

      expect(await screen.findByText("已开启")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "关闭自动采集" }));
      expect(autoCollectMocks.setEnabled).toHaveBeenCalledWith(false);
    });

    it("关闭后：显示已关闭、不显示下次预计，按钮改为开启", async () => {
      const nextRunAt = Date.parse("2026-11-07T23:00:00+08:00");
      setAutoCollect({ enabled: false, nextRunAt });
      installBridge();
      render(<InfohubPage />);

      expect(await screen.findByText("已关闭")).toBeInTheDocument();
      // 关掉后不再预告下一次：即使 store 里还残留 nextRunAt 也不展示
      expect(screen.queryByText(/下次预计/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "开启自动采集" }));
      expect(autoCollectMocks.setEnabled).toHaveBeenCalledWith(true);
    });

    it("立即采集一次：调用 runNow(\"manual\")", async () => {
      installBridge();
      render(<InfohubPage />);

      fireEvent.click(await screen.findByRole("button", { name: "立即采集一次" }));
      expect(autoCollectMocks.runNow).toHaveBeenCalledWith("manual");
    });

    it("运行中：状态显示正在采集，按钮禁用避免重入", async () => {
      setAutoCollect({ running: true });
      installBridge();
      render(<InfohubPage />);

      expect(await screen.findByText("正在采集…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "关闭自动采集" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "立即采集一次" })).toBeDisabled();
    });

    it("上次采集与下次预计按本机时间显示", async () => {
      const lastRunAt = Date.parse("2026-11-07T22:30:00+08:00");
      const nextRunAt = lastRunAt + 30 * 60_000;
      setAutoCollect({ lastRunAt, lastStatus: "ok", nextRunAt });
      installBridge();
      render(<InfohubPage />);

      const lastText = formatInfohubTime(lastRunAt / 1000, true);
      const nextText = formatInfohubTime(nextRunAt / 1000);
      expect(await screen.findByText(`上次采集：${lastText} · 下次预计：${nextText}`)).toBeInTheDocument();
    });

    it("从未采集：显示还没有采集过，且没有下次预计", async () => {
      setAutoCollect({ lastRunAt: null, nextRunAt: null });
      installBridge();
      render(<InfohubPage />);

      expect(await screen.findByText("上次采集：还没有采集过")).toBeInTheDocument();
      expect(screen.queryByText(/下次预计/)).not.toBeInTheDocument();
    });

    it("失败：显示中文原因，且不阻塞采集桥与归档连接", async () => {
      setAutoCollect({ lastStatus: "error", lastMessage: "采集桥没有运行，请先启动采集桥" });
      installBridge();
      render(<InfohubPage />);

      expect(
        await screen.findByText("上次采集失败：采集桥没有运行，请先启动采集桥"),
      ).toBeInTheDocument();
      // 边界说明始终在：仅桌面端 / 只采本机 / 30 分钟 / 可关闭
      expect(screen.getByText(/仅桌面端 · 只采本机 · 每 30 分钟增量一次 · 可在这一步关闭/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "启动采集桥" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "连接" })).toBeInTheDocument();
    });

    it("浏览器端：说明不会自动采集也不会拉起进程，不给假按钮", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      );
      render(<InfohubPage />);

      expect(await screen.findByText("浏览器版不会自动采集，也不会拉起进程。")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "立即采集一次" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "关闭自动采集" })).not.toBeInTheDocument();
    });

    it("原有区块不回归：自动采集与采集桥、连接、检索并存", async () => {
      installBridge();
      await connectPage();

      expect(autoCollectMocks.refresh).toHaveBeenCalled();
      expect(await screen.findByText("已开启")).toBeInTheDocument();
      // 采集桥与归档原有状态/操作都还在
      expect(screen.getByText("未运行")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "断开" })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("在归档中检索"), { target: { value: "免检单" } });
      fireEvent.click(screen.getByRole("button", { name: "检索" }));
      expect(await screen.findByText("免检单")).toBeInTheDocument();
    });
  });
});
