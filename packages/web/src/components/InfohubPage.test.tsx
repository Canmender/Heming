import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InfohubPage } from "./InfohubPage.js";
import type {
  InfohubAgendaItem,
  InfohubBridgeInfo,
  InfohubConversation,
  InfohubMessage,
  InfohubStatus,
} from "../lib/infohub/client.js";

const HOME = "D:\\wohaolei";

const conv: InfohubConversation = {
  id: 25,
  source: "qq",
  account: "",
  external_id: "qq:private:1",
  name: "叶老师",
  kind: "private",
  avatar: "",
  last_ts: 1800000100,
  message_count: 2,
  meta: {},
};

const message: InfohubMessage = {
  id: 1,
  conversation_id: 25,
  external_id: "m1",
  ts: 1800000100,
  sender_id: "s1",
  sender_name: "叶老师",
  is_self: false,
  type_code: 1,
  type_label: "文本",
  content: "免检单记得交",
  imported_at: 1800000200,
  media: null,
};

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
    methods: ["status", "conversations"],
    ...overrides,
  };
}

function installBridge(overrides: Partial<Bridge> = {}) {
  const call = vi.fn(async (method: string) => {
    if (method === "status") return status;
    if (method === "conversations") return { items: [conv], total: 1 };
    if (method === "messages") return { conversation: conv, items: [message], hasMore: false };
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
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器环境：明确提示仅桌面端可用，不回退云端", () => {
    render(<InfohubPage />);
    expect(screen.getByText("信息中枢仅桌面端可用")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "连接" })).not.toBeInTheDocument();
  });

  it("连接后展示规模、会话与消息", async () => {
    const { bridge, call } = installBridge();
    await connectPage();

    expect(bridge.start).toHaveBeenCalledWith({});
    expect(call).toHaveBeenCalledWith("status", {}, expect.anything());
    expect(call).toHaveBeenCalledWith(
      "conversations",
      expect.objectContaining({ limit: 1000 }),
      expect.anything(),
    );

    expect(screen.getByText("1")).toBeInTheDocument(); // 会话数
    expect(screen.getByText("2")).toBeInTheDocument(); // 消息数
    expect(screen.getAllByText("叶老师").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("免检单记得交")).toBeInTheDocument());
    // 配置区只显示「是否配置过」，不出现任何密钥值
    expect(screen.getByText(/推送：smtp（无凭据）/)).toBeInTheDocument();
    expect(screen.getByText(/模型：未设置（无 Key）/)).toBeInTheDocument();
  });

  it("检索：命中词高亮，点结果回到对应会话", async () => {
    installBridge();
    await connectPage();

    fireEvent.click(screen.getByRole("tab", { name: "检索" }));
    fireEvent.change(screen.getByLabelText("在归档中检索"), { target: { value: "免检单" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    const mark = await screen.findByText("免检单");
    expect(mark.tagName).toBe("MARK");
    fireEvent.click(mark.closest("button") as HTMLElement);
    await waitFor(() => expect(screen.getByText("免检单记得交")).toBeInTheDocument());
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
});
