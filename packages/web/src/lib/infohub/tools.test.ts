import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  INFOHUB_TOOLS,
  buildInfohubToolBridge,
  buildInfohubToolsIfConnected,
  isInfohubPluginEnabled,
} from "./tools.js";
import { useInfohubStore } from "./store.js";
import { pluginStore, type InstalledPlugin } from "../plugins/store.js";
import type {
  InfohubAgendaItem,
  InfohubBridgeInfo,
  InfohubConversation,
  InfohubMessage,
  InfohubSearchHit,
} from "./client.js";

/**
 * 归档工具的边界（d.46）：
 *
 * - 只在「桌面桥 + 已连接」时注入，未连接给可执行指引而不是偷偷拉起进程；
 * - 读取工具全是 read，唯一写操作 `infohub_agenda_rebuild` 必须标 write 交 HITL；
 * - `sync` 不暴露给模型（写归档且耗时最长，只留在信息中枢页）；
 * - 结果里的来源统一标 archive，脚注才能说清「这些来自本机归档」。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

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

const selfMessage: InfohubMessage = {
  ...message,
  id: 2,
  external_id: "m2",
  sender_name: "我",
  is_self: true,
  content: "好的",
};

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

const agendaItem: InfohubAgendaItem = {
  id: 7,
  messageId: 1,
  conversationId: 25,
  title: "补交材料",
  detail: "周五前交到办公室",
  dueTs: 1800000100,
  dueText: "11-03 18:00",
  allDay: false,
  kind: "deadline",
  status: "open",
  convName: "叶老师",
  source: "qq",
  senderName: "叶老师",
  msgTs: 1800000100,
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

function installBridge(
  handler: (method: string, params: Record<string, unknown>) => unknown = () => undefined,
) {
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => handler(method, params));
  const bridge = {
    info: vi.fn(async () => info({ running: true, home: HOME })),
    start: vi.fn(async () => info({ running: true, home: HOME })),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge, call };
}

const run = (name: string, args: Record<string, unknown> = {}) =>
  buildInfohubToolBridge().execute({ name, arguments: JSON.stringify(args) });

function names(tools: unknown[]): string[] {
  return tools.map((t) => (t as { function: { name: string } }).function.name);
}

/** 只造判定用到的字段：注入条件只看插件是否安装/启用/记录可信。 */
function fakePlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    manifest: { id: "heming.infohub" },
    enabled: true,
    ...overrides,
  } as unknown as InstalledPlugin;
}

describe("信息中枢工具提供者", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    useInfohubStore.setState({
      available: false,
      running: false,
      booted: false,
      info: null,
      status: null,
      agenda: null,
      detected: null,
      autoCollected: false,
      busy: "",
      error: "",
    });
    // 注入条件只认「插件已安装且启用」这一条口径。
    vi.spyOn(pluginStore, "get").mockReturnValue(fakePlugin());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("只在桌面端且已连接时注入工具", () => {
    expect(buildInfohubToolsIfConnected()).toBeNull(); // 浏览器端

    installBridge();
    useInfohubStore.setState({ available: true, running: false });
    expect(buildInfohubToolsIfConnected()).toBeNull(); // 未连接

    useInfohubStore.setState({ running: true });
    const bridge = buildInfohubToolsIfConnected();
    expect(bridge).not.toBeNull();
    expect(names(bridge!.tools)).toEqual([
      "infohub_search",
      "infohub_read_conversation",
      "infohub_agenda",
      "infohub_agenda_rebuild",
    ]);
  });

  it("sync 不暴露为工具（写归档只从信息中枢页发起）", () => {
    expect(names(INFOHUB_TOOLS)).not.toContain("infohub_sync");
    expect(names(INFOHUB_TOOLS).every((n) => n.startsWith("infohub_"))).toBe(true);
  });

  it("meta：默认只读，只有重扫日程是写操作", () => {
    const meta = buildInfohubToolBridge().meta!;
    expect(meta("infohub_search")).toEqual({ risk: "read", displayName: "检索本机归档" });
    expect(meta("infohub_read_conversation")).toEqual({ risk: "read", displayName: "读取本机归档会话" });
    expect(meta("infohub_agenda")).toEqual({ risk: "read", displayName: "查看本机日程" });
    expect(meta("infohub_agenda_rebuild")).toEqual({ risk: "write", displayName: "重扫本机日程" });
    expect(meta("unknown_tool")).toBeUndefined();
  });

  it("浏览器端执行：直接告知仅桌面端可用，不触达桥", async () => {
    const out = await run("infohub_search", { query: "免检单" });
    expect(out).toEqual({ text: "信息中枢仅桌面端可用，无法读取本机归档。", ok: false });
  });

  it("未就绪执行：给自动启动指引并拒绝（工具不负责 spawn）", async () => {
    const { bridge, call } = installBridge();
    useInfohubStore.setState({ available: true, running: false });

    const out = await run("infohub_search", { query: "免检单" });

    expect(out.ok).toBe(false);
    expect(out.text).toContain("信息中枢正在自动启动本机归档");
    expect(bridge.start).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("search：查询、默认条数、来源与提醒模型区分归档和当前会话", async () => {
    const { call } = installBridge((method) => {
      if (method === "search") return { items: [hit], query: "免检单" };
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });

    const out = await run("infohub_search", { query: " 免检单 " });

    expect(call).toHaveBeenCalledWith("search", { query: "免检单", limit: 8 }, expect.anything());
    expect(out.ok).toBe(true);
    expect(out.text).toContain("在本机归档找到 1 条匹配「免检单」的消息");
    expect(out.text).toContain("叶老师");
    expect(out.text).toContain("请把免检单交上来");
    expect(out.text).toContain("不要当成和鸣当前会话的消息");
    expect(out.sources).toEqual([
      {
        id: "infohub:message:1",
        title: expect.stringContaining("叶老师"),
        detail: "QQ · 本机归档",
        kind: "archive",
      },
    ]);
  });

  it("search：条数上限被夹到 20，空关键词直接拒绝", async () => {
    const { call } = installBridge(() => ({ items: [], query: "x" }));
    useInfohubStore.setState({ available: true, running: true });

    await run("infohub_search", { query: "x", limit: 999 });
    expect(call).toHaveBeenCalledWith("search", { query: "x", limit: 20 }, expect.anything());

    const out = await run("infohub_search", { query: "   " });
    expect(out).toEqual({ text: "query 不能为空。", ok: false });
  });

  it("search：无命中或归档库缺失都给可读结论", async () => {
    installBridge((method) => {
      if (method === "search") return { items: [], query: "不存在" };
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });
    expect(await run("infohub_search", { query: "不存在" })).toEqual({
      text: "本机归档里没有匹配「不存在」的消息。",
      ok: true,
    });

    installBridge((method) => {
      if (method === "search") return { items: [], query: "x", dbMissing: true };
      return undefined;
    });
    const missing = await run("infohub_search", { query: "x" });
    expect(missing.ok).toBe(true);
    expect(missing.text).toContain("请先在信息中枢页完成一次同步");
  });

  it("read_conversation：数字 id 直接读消息，自己发的消息标「我」", async () => {
    const { call } = installBridge((method) => {
      if (method === "messages") return { conversation: conv, items: [message, selfMessage], hasMore: true };
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });

    const out = await run("infohub_read_conversation", { conversation: "25" });

    expect(call).toHaveBeenCalledWith(
      "messages",
      { conversationId: 25, limit: 30 },
      expect.anything(),
    );
    expect(out.ok).toBe(true);
    expect(out.text).toContain("会话「叶老师」（QQ）最近 2 条消息");
    expect(out.text).toContain("叶老师：免检单记得交");
    expect(out.text).toContain("我：好的");
    expect(out.text).toContain("beforeTs 继续翻页");
    expect(out.sources).toEqual([
      {
        id: "infohub:conversation:25",
        title: "叶老师 · 最近 2 条",
        detail: "QQ · 本机归档",
        kind: "archive",
      },
    ]);
  });

  it("read_conversation：按名字先查会话，精确同名优先", async () => {
    const { call } = installBridge((method) => {
      if (method === "conversations") {
        return {
          items: [{ ...conv, id: 30, name: "叶老师" }, { ...conv, id: 31, name: "叶老师班群" }],
          total: 2,
        };
      }
      if (method === "messages") return { conversation: conv, items: [message], hasMore: false };
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });

    await run("infohub_read_conversation", { conversation: "叶老师", limit: 10, beforeTs: 1800000000 });

    expect(call).toHaveBeenCalledWith(
      "conversations",
      { keyword: "叶老师", limit: 20 },
      expect.anything(),
    );
    expect(call).toHaveBeenCalledWith(
      "messages",
      { conversationId: 30, limit: 10, beforeTs: 1800000000 },
      expect.anything(),
    );
  });

  it("read_conversation：无精确同名且有多个候选时列出来，不瞎猜", async () => {
    const { call } = installBridge((method) => {
      if (method === "conversations") {
        return {
          items: [
            { ...conv, id: 30, name: "叶老师" },
            { ...conv, id: 31, name: "叶老师班群" },
          ],
          total: 2,
        };
      }
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });

    const out = await run("infohub_read_conversation", { conversation: "叶" });

    expect(out.ok).toBe(true);
    expect(out.text).toContain("匹配到多个会话");
    expect(out.text).toContain("id=30");
    expect(out.text).toContain("id=31");
    expect(call.mock.calls.some(([method]) => method === "messages")).toBe(false);
  });

  it("read_conversation：无内容的消息按媒体类型给占位", async () => {
    const image: InfohubMessage = {
      ...message,
      content: "",
      media: {
        messageId: 1,
        kind: "image",
        name: "a.jpg",
        width: 10,
        height: 10,
        size: 100,
        hasPath: true,
      },
    };
    installBridge((method) => {
      if (method === "messages") return { conversation: conv, items: [image], hasMore: false };
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });

    const out = await run("infohub_read_conversation", { conversation: "25" });
    expect(out.text).toContain("[图片]");
  });

  it("agenda：透传统计与事项；重扫才带 rebuild", async () => {
    const { call } = installBridge((method) => {
      if (method === "agenda") {
        return { items: [agendaItem], summary: { overdue: 1, today: 0, week: 1, total: 1 } };
      }
      return undefined;
    });
    useInfohubStore.setState({ available: true, running: true });

    const out = await run("infohub_agenda", {});

    expect(call).toHaveBeenCalledWith("agenda", { days: 14, overdue: 30 }, expect.anything());
    expect(out.text).toContain("本机归档日程逾期 1 · 今天 0 · 本周 1 · 共 1");
    expect(out.text).toContain("补交材料");
    expect(out.text).toContain("截止 11-03 18:00");
    expect(out.sources).toEqual([
      {
        id: "infohub:agenda:7",
        title: "补交材料 · 11-03 18:00",
        detail: "叶老师 · 本机日程",
        kind: "archive",
      },
    ]);

    const rebuilt = await run("infohub_agenda_rebuild", { days: 7, overdue: 3 });
    expect(call).toHaveBeenCalledWith("agenda", { days: 7, overdue: 3, rebuild: true }, expect.anything());
    expect(rebuilt.text).toContain("已重扫本机归档日程");
  });

  it("桥报错：包成可读失败结果，保留原文", async () => {
    installBridge(() => {
      throw new Error("Error invoking remote method 'infohub:call': Error: 归档库损坏");
    });
    useInfohubStore.setState({ available: true, running: true });

    const out = await run("infohub_search", { query: "x" });
    expect(out).toEqual({ text: "读取本机归档失败：归档库损坏", ok: false });
  });

  it("未知工具名返回失败而不是抛错", async () => {
    installBridge();
    useInfohubStore.setState({ available: true, running: true });
    expect(await run("infohub_nope")).toEqual({ text: "未知工具 infohub_nope", ok: false });
  });
});

/* ───────────────── d.125 注入条件改为「插件已安装并启用」 ───────────────── */

describe("信息中枢工具注入 · 插件化口径", () => {
  beforeEach(() => {
    localStorage.clear();
    installBridge();
    useInfohubStore.setState({ available: true, running: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("插件已安装且启用 → 注入", () => {
    vi.spyOn(pluginStore, "get").mockReturnValue(fakePlugin());
    expect(isInfohubPluginEnabled()).toBe(true);
    expect(buildInfohubToolsIfConnected()).not.toBeNull();
  });

  it("插件停用 / 卸载 / 记录损坏 → 不注入（模型不该还能查用户以为关掉的归档）", () => {
    const get = vi.spyOn(pluginStore, "get");
    get.mockReturnValue(undefined);
    expect(isInfohubPluginEnabled()).toBe(false);
    expect(buildInfohubToolsIfConnected()).toBeNull();

    get.mockReturnValue(fakePlugin({ enabled: false }));
    expect(isInfohubPluginEnabled()).toBe(false);
    expect(buildInfohubToolsIfConnected()).toBeNull();

    get.mockReturnValue(fakePlugin({ invalidRecord: true, invalidReason: "清单损坏" }));
    expect(isInfohubPluginEnabled()).toBe(false);
    expect(buildInfohubToolsIfConnected()).toBeNull();
  });

  it("插件判定只认 heming.infohub 这个 id（其它插件启用不影响归档工具）", () => {
    const get = vi.spyOn(pluginStore, "get").mockReturnValue(undefined);
    expect(buildInfohubToolsIfConnected()).toBeNull();
    expect(get).toHaveBeenCalledWith("heming.infohub");
  });
});
