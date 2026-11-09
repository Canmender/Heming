import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InfohubHomeCard } from "./InfohubHomeCard.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useUiStore } from "../store/ui.js";
import { useModuleStore } from "../lib/modules/store.js";
import type { InfohubAgendaItem, InfohubBridgeInfo, InfohubStatus } from "../lib/infohub/client.js";

/**
 * 首页「本机归档」卡（d.46）只做露出：
 *
 * - 浏览器端没有本机桥 → 整张卡不渲染；
 * - 未连接 → 自动拉起 + 隐私说明（没有手动「连接」入口）；
 * - 已连接 → 日程摘要/规模 + 两个入口，点入口只投递意图，不复制页面状态机。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

const HOME = "D:\\wohaolei";

const status = {
  home: HOME,
  stats: { conversations: 1234, messages: 5678, per_source: { qq: 1234 } },
} as unknown as InfohubStatus;

function agendaItem(id: number, title: string, dueTs: number): InfohubAgendaItem {
  return {
    id,
    messageId: id,
    conversationId: 25,
    title,
    detail: "",
    dueTs,
    dueText: `${id} 号截止`,
    allDay: false,
    kind: "deadline",
    status: "open",
    convName: "叶老师",
    source: "qq",
    senderName: "叶老师",
    msgTs: 1800000000,
  };
}

const agenda = {
  items: [
    agendaItem(4, "第四件事", 400),
    agendaItem(1, "第一件事", 100),
    agendaItem(3, "第三件事", 300),
    agendaItem(2, "第二件事", 200),
  ],
  summary: { overdue: 2, today: 1, week: 3, total: 4 },
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
    methods: [],
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
      return info({ running: true, pid: 1, home: HOME, python: "C:\\py\\python.exe", pythonSource: "bundled" });
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

describe("首页本机归档卡", () => {
  beforeEach(() => {
    localStorage.clear();
    useModuleStore.getState().reset();
    useModuleStore.getState().install("infohub");
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    useInfohubStore.setState({
      available: false,
      running: false,
      booted: false,
      info: null,
      status: null,
      agenda: null,
      autoCollected: false,
      autoNote: "",
      busy: "",
      error: "",
    });
    useUiStore.setState({ page: "home", activeConversationId: null, infohubIntent: null });
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器端：整张卡不渲染", () => {
    const view = render(<InfohubHomeCard />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("未连接：卡片自动拉起，没有手动连接入口，连上后展示摘要", async () => {
    const { bridge } = installBridge();
    render(<InfohubHomeCard />);

    expect(await screen.findByText("本机归档")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "连接" })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("已连接")).toBeInTheDocument());
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("逾期 2")).toBeInTheDocument();
    expect(screen.getByText("今天 1")).toBeInTheDocument();
    expect(screen.getByText("本周 3")).toBeInTheDocument();
    expect(screen.getByText("1,234 个会话 · 5,678 条消息")).toBeInTheDocument();
  });

  it("已连接：日程按截止时间取前三，点击投递日程意图", async () => {
    installBridge({ running: true });
    render(<InfohubHomeCard />);

    await screen.findByText("第一件事");
    const titles = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    // 前三 = 按 dueTs 升序的 1/2/3；第四件不出现
    expect(titles.some((t) => t.includes("第一件事"))).toBe(true);
    expect(titles.some((t) => t.includes("第二件事"))).toBe(true);
    expect(titles.some((t) => t.includes("第三件事"))).toBe(true);
    expect(screen.queryByText("第四件事")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部日程" }));
    expect(useUiStore.getState()).toMatchObject({
      page: "infohub",
      infohubIntent: { tab: "agenda" },
    });
  });

  it("已连接：检索入口只投递 search 意图", async () => {
    installBridge({ running: true });
    render(<InfohubHomeCard />);
    await screen.findByText("已连接");

    fireEvent.click(screen.getByRole("button", { name: "检索归档" }));
    expect(useUiStore.getState().page).toBe("infohub");
    expect(useUiStore.getState().infohubIntent).toEqual({ tab: "search" });
  });

  it("自动启动失败：展示可读错误且卡片上可重试", async () => {
    installBridge({
      startError: new Error(
        "Error invoking remote method 'infohub:start': Error: 未找到可用的 Python 解释器",
      ),
    });
    render(<InfohubHomeCard />);

    expect(await screen.findByText("未找到可用的 Python 解释器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
