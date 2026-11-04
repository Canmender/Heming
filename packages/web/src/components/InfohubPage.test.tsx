import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InfohubPage } from "./InfohubPage.js";
import { useUiStore } from "../store/ui.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import type {
  InfohubAgendaItem,
  InfohubBridgeInfo,
  InfohubStatus,
} from "../lib/infohub/client.js";

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

type Bridge = NonNullable<Window["__heming_infohub"]>;

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
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器环境：明确提示仅桌面端可用，不回退云端", () => {
    render(<InfohubPage />);
    // 与其他页一致的页头（不再是一张孤立卡片落在空白页上）
    expect(screen.getByRole("heading", { name: "信息中枢", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("信息中枢仅桌面端可用")).toBeInTheDocument();
    expect(screen.getByText(/在桌面版安装包里打开「信息中枢」/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "连接" })).not.toBeInTheDocument();
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
});
