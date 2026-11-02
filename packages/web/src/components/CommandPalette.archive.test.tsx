import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette.js";
import type { TeamMember } from "@heming/shared";
import { useUiStore } from "../store/ui.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import type { InfohubBridgeInfo, InfohubSearchHit } from "../lib/infohub/client.js";
import { fetchTeam } from "../lib/api.js";

// 面板挂载即预取团队名册；单测里给桩，避免去打真实网络。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchTeam: vi.fn() };
});

/**
 * 命令面板的本机归档检索（d.46）。
 *
 * 面板不复制归档页：命中后只投递「检索词」意图，由信息中枢页自己跑检索。
 * 未连接时直接不请求——避免每次敲键都撞到不存在的桥。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

const hit: InfohubSearchHit = {
  id: 1,
  conversationId: 25,
  ts: 1800000100,
  senderName: "叶老师",
  content: "请把免检单交上来",
  snippet: "请把<<免检单>>交上来",
  convName: "叶老师",
  source: "qq",
};

function info(): InfohubBridgeInfo {
  return {
    packageDir: "D:\\Heming\\packages\\infohub",
    defaultHome: "C:\\Users\\x\\Heming\\infohub",
    bundledPython: null,
    running: true,
    pid: 1,
    home: "D:\\wohaolei",
    python: "C:\\py\\python.exe",
    pythonSource: "bundled",
    startedAt: 0,
    methods: [],
  };
}

function installBridge() {
  const call = vi.fn(async (method: string) => {
    if (method === "search") return { items: [hit], query: "免检单" };
    return undefined;
  });
  const bridge = {
    info: vi.fn(async () => info()),
    start: vi.fn(async () => info()),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { call };
}

describe("命令面板 · 本机归档检索", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useUiStore.setState({ page: "home", activeConversationId: null, infohubIntent: null });
    useInfohubStore.setState({ available: true, running: true, booted: true, error: "" });
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("已连接：输入后防抖检索归档，点击命中把检索词交给信息中枢页", async () => {
    const { call } = installBridge();
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);

    fireEvent.change(screen.getByLabelText("搜索成员与技能"), {
      target: { value: "免检单" },
    });

    const row = await screen.findByRole("button", { name: "选择 请把免检单交上来" });
    expect(call).toHaveBeenCalledWith(
      "search",
      { query: "免检单", limit: 5 },
      expect.anything(),
    );
    expect(row.textContent).toContain("本机");
    expect(row.textContent).toContain("QQ · 叶老师");

    fireEvent.click(row);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState()).toMatchObject({
      page: "infohub",
      infohubIntent: { tab: "search", query: "免检单" },
    });
  });

  it("未连接：不请求归档，提示先连接信息中枢", () => {
    const { call } = installBridge();
    useInfohubStore.setState({ running: false });

    render(<CommandPalette onClose={vi.fn()} />);
    expect(screen.getByText(/连接信息中枢后/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索成员与技能"), {
      target: { value: "免检单" },
    });

    expect(call).not.toHaveBeenCalled();
    expect(screen.queryByText("请把免检单交上来")).not.toBeInTheDocument();
  });

  it("归档检索失败不打断成员/技能结果", async () => {
    const { call } = installBridge();
    call.mockRejectedValue(new Error("归档库损坏"));
    const member: TeamMember = {
      user: { id: "u9", username: "mianjian", displayName: "免检单讨论组" },
      lastSeenAt: null,
      online: true,
    };
    vi.mocked(fetchTeam).mockResolvedValue({ members: [member], onlineCount: 1 });

    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("搜索成员与技能"), {
      target: { value: "免检单" },
    });

    expect(await screen.findByText("免检单讨论组")).toBeInTheDocument();
    await waitFor(() => expect(call).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("正在检索本机归档…")).not.toBeInTheDocument());
  });
});
