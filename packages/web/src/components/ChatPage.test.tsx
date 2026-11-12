import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import type { Message, User, WsClientEvent } from "@heming/shared";
import { ChatPage, clampComposerHeight } from "./ChatPage.js";
import { readChatScroll, writeChatScroll } from "../lib/chatScroll.js";
import { useUiStore } from "../store/ui.js";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";
import { useLlmStore, type LlmProfile } from "../store/llm.js";
import { setNotificationStorage, useNotificationStore } from "../store/notifications.js";
import { useHitlStore } from "../store/hitl.js";
import { createMemoryStorage } from "../lib/memory/storage.js";
import { TASKS_KEY, useTaskStore } from "../lib/tasks/store.js";
import { rolloutLog } from "../lib/rollout/index.js";
import { streamChat } from "../lib/llmClient.js";
import { visionImageDataUrl } from "../lib/vision/history.js";
import { connectWs, type WsHandlers, type WsHandle } from "../lib/ws.js";
import { memoryStore } from "../lib/memory/index.js";
import { maybeRunReview } from "../lib/memory/reviewRunner.js";
import { mcpRegistry } from "../lib/mcp/store.js";
import { MODEL_CAPS_KEY, setOverride } from "../lib/modelCaps.js";
import { skillPool } from "../lib/skills/index.js";
import { CONTEXT_KEYS, type ContextSettings } from "../lib/agentContext/index.js";
import { hasSubtle, toB64, fromB64 } from "../lib/e2eCrypto.js";
import { sealMessage } from "../lib/e2eSession.js";
import { migrateMsgCache, msgCache, openMessage } from "../lib/e2eSession.js";
import { DEFAULT_WINDOW } from "../lib/messageWindow.js";
import { formatClock, formatDayClock } from "../lib/formatTime.js";

vi.mock("../lib/ws.js", () => ({ connectWs: vi.fn() }));
// E2E Task 4：hasSubtle 桩（默认 true，无 subtle 用例按例翻转）；
// sealMessage 桩——cipher 内直接 JSON 明文（形状同真信封，断言可解），
// 真封解密路径由 e2eSession.test 覆盖，组件面只测「经 seal → 发信封」的接线。
vi.mock("../lib/e2eCrypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/e2eCrypto.js")>();
  return { ...actual, hasSubtle: vi.fn(() => true) };
});
// MCP 工具执行桩：本文件只用它验证「工具轮的可视化接线」，协议细节由 lib/mcp 自测覆盖。
// 桩客户端的 callTool 返回固定文本，让断言聚焦 DOM 上出现思考过程 / 工具轨迹 / 最终答案。
vi.mock("../lib/mcp/httpClient.js", () => ({
  createHttpMcpClient: () => ({
    sessionId: "sess-1",
    initialize: async () => ({ serverName: "echo-svc", protocolVersion: "2024-11-05" }),
    listTools: async () => [],
    callTool: async (_name: string, args: Record<string, unknown>) => ({
      text: `回声：${String(args.text ?? "")}`,
      isError: false,
      content: [],
    }),
  }),
}));
// 复盘分身接线：这里只验证「成功轮次收尾会触发一次复盘」，复盘本身的行为由
// lib/memory/review.test.ts 覆盖，故把 runner 打桩。
vi.mock("../lib/memory/reviewRunner.js", () => ({
  maybeRunReview: vi.fn(),
}));

// 历史图片解密桩：解密/转 base64 的纯逻辑由 lib/vision/history.test.ts 覆盖，
// 组件面只验证「视觉模型才附内容片、非视觉模型不附」的接线。
vi.mock("../lib/vision/history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/vision/history.js")>();
  return { ...actual, visionImageDataUrl: vi.fn(async () => "aW1n") };
});

vi.mock("../lib/e2eSession.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/e2eSession.js")>();
  // openMessage / migrateMsgCache 包成 vi.fn：默认走真实实现，个别用例可注入
  // 「duplicate 补齐」「迁移抛错」等路径（P0-5b 接线验收）。
  return {
    ...actual,
    sealMessage: vi.fn(),
    openMessage: vi.fn(actual.openMessage),
    migrateMsgCache: vi.fn(() => 0),
  };
});

/**
 * 闸门故障注入：ChatPage 的 confirmToolCalls 自带 catch，
 * 只有让 `hitlGate.review` 抛错才能覆盖「异常按拒绝」的接线层路径。
 */
const gateState = vi.hoisted(() => ({ failReview: false }));
vi.mock("../lib/hitl/gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/hitl/gate.js")>();
  return {
    ...actual,
    createHitlGate: (deps: Parameters<typeof actual.createHitlGate>[0]) => {
      const gate = actual.createHitlGate(deps);
      return {
        review: async (batch: Parameters<typeof gate.review>[0]) => {
          if (gateState.failReview) {
            gateState.failReview = false;
            throw new Error("确认通道断开");
          }
          return gate.review(batch);
        },
      };
    },
  };
});

/** 桩 cipher 解码：btoa(UTF8 JSON) 的逆（seal 桩实现见 beforeEach）。 */
const decodePlain = (cipher: string): Record<string, unknown> =>
  JSON.parse(decodeURIComponent(escape(atob(cipher))));

/** 桩封条：明文 JSON 直接 base64（不含任何真实密码学）。 */
let sealN = 0;
const stubSeal = async (conv: { id: string }, plain: unknown, _deps?: unknown) => ({
  type: "send_message" as const,
  conversationId: conv.id,
  payload: { text: "" },
  enc: "e2e" as const,
  cipher: btoa(unescape(encodeURIComponent(JSON.stringify(plain)))),
  chainKid: "test-kid",
  n: sealN++,
});
// 流式打底走本机 streamChat：模块 mock（保留 testConnection/buildRequest 真实现），
// 默认立即回空串——mention 发送用例不至于把 fetch 打到供应商端点
vi.mock("../lib/llmClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llmClient.js")>();
  return { ...actual, streamChat: vi.fn(async () => "") };
});

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const peer: User = { id: "u2", username: "bob", displayName: "鲍勃" };

const msg = (id: string, text: string, createdAt: string): Message => ({
  id,
  conversationId: "c1",
  senderType: "user",
  senderId: "u2",
  payload: { text },
  createdAt,
  enc: "plain",
});

/** 智能体历史消息（senderType=agent）：d.126-C 的思考/工具转录块只挂在助手消息上。 */
const agentMsg = (id: string, text: string, createdAt: string): Message => ({
  ...msg(id, text, createdAt),
  senderType: "agent",
  senderId: "system-assistant",
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * E2E Task 5 测试侧附件密文构造（与 api.ts 的 FILE_ENC_AAD +「12B IV 前置」同口径）：
 * 生产实现改口径而测试没改 → 解密必失败，渲染用例即红（两处常量的可执行锁）。
 */
async function sealAttachment(keyB64: string, plaintext: string): Promise<Blob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey("raw", fromB64(keyB64).buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("heming.e2e.file.v1") },
      ck,
      new TextEncoder().encode(plaintext),
    ),
  );
  const sealed = new Uint8Array(iv.length + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, iv.length);
  return new Blob([sealed]);
}

/**
 * 会话 fetch mock：/messages 按调用序返回不同历史（首次 → first，其后 → second ?? first）；
 * /reads、/members 按调用序取 conv 内对应序列（缺省空表 200，避免挂载期 loadReads/fetchMembers 走 404 噪声）；
 * /files/:id/content 走 fetchFileBlobUrl 的同一 fetch 面（默认 200 blob；contentFail 模拟 401）——
 * jsdom 不发真实网络请求，附件断言统一落在 objectURL 桩上。
 */
function mockMessagesFetch(
  first: Message[],
  second?: Message[],
  conv: {
    contentFail?: boolean;
    /** 附件上传（POST /api/files）的返回体；不配则维持 404（多数用例不上传）。 */
    uploadMeta?: unknown;
  } = {},
) {
  let m = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url)) {
      return Promise.resolve(jsonRes(m++ === 0 ? first : (second ?? first)));
    }
    if (url === "/api/e2e/keys") {
      return Promise.resolve(jsonRes({})); // 公钥上云 PUT/拉取 GET：成功即可（无设备登记）
    }
    const reenc = /^\/api\/messages\/([^/]+)\/reencrypt$/.exec(url);
    if (reenc) {
      // 存量自迁移 PUT：回 e2e 形态（保留原消息身份字段，payload 按服务端语义清占位——
      // migrate 会用本地已知明文经 plainById 回填渲染）
      const orig = first.find((m) => m.id === reenc[1]);
      return Promise.resolve(
        jsonRes({
          ...(orig ?? msg(reenc[1], "", "2026-10-17T00:00:00.000Z")),
          payload: { text: "" },
          enc: "e2e",
          cipher: "QQ==",
          chainKid: "test-kid",
          n: 0,
        }),
      );
    }
    if (/^\/api\/files\/[^/]+\/content$/.test(url)) {
      if (conv.contentFail) return Promise.resolve(jsonRes({ error: "unauthorized" }, 401));
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: async () => new Blob(["bin"]),
      } as unknown as Response);
    }
    if (url === "/api/files" && conv.uploadMeta !== undefined)
      return Promise.resolve(jsonRes(conv.uploadMeta, 201));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

/** connectWs 已 vi.mock：返回最近一次注册的 handlers。 */
function lastHandlers(): WsHandlers {
  const calls = vi.mocked(connectWs).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

/**
 * 等最后一条 send_message 落帧并断言其为 e2e 信封（enc/cipher/chainKid/n、payload 占位），
 * 返回解出的明文（桩 cipher = base64(UTF8 JSON)）。E2E Task 4：全部发送路径共用此断言面。
 */
async function lastSealed(send: { mock: { calls: unknown[][] } }): Promise<Record<string, unknown>> {
  await waitFor(() =>
    expect(
      send.mock.calls.some((c) => (c[0] as { type?: string } | undefined)?.type === "send_message"),
    ).toBe(true),
  );
  const ev = send.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === "send_message")
    .at(-1)!;
  expect(ev.enc).toBe("e2e");
  expect(typeof ev.cipher).toBe("string");
  expect(typeof ev.chainKid).toBe("string");
  expect(typeof ev.n).toBe("number");
  expect(ev.payload).toEqual({ text: "" }); // 服务端 e2e 路径不读 payload
  return decodePlain(ev.cipher as string);
}

/** 取 send 里指定 type 的全部密文事件并解出明文（agent_chunk/finish 的信封形态）。 */
function sealedOf(send: { mock: { calls: unknown[][] } }, type: string): Record<string, unknown>[] {
  return send.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type && typeof e.cipher === "string")
    .map((e) => ({ ...e, plain: decodePlain(e.cipher as string) }));
}

/** 本机 LLM 连接（Key 不出设备）：绑定到会话智能体后发送才会真正触发流式生成。 */
const testProfile: LlmProfile = {
  id: "p1",
  label: "l",
  provider: "openai",
  apiKey: "k",
  model: "m",
};
function bindAssistant() {
  useLlmStore.setState({
    profiles: [testProfile],
    bindings: { "system-assistant": "p1" },
    prompts: { "system-assistant": "你是和小鸣" },
  });
}

/**
 * 助手会话底座：默认 beforeEach 已挂 c1（agent 会话），这里只接 WS 句柄与历史。
 * 一对一里「跟谁说话」由会话本身确定，普通发送即触发会话绑定的智能体。
 */
async function setupAgentChat(
  history: Message[] = [],
  conv: { contentFail?: boolean; uploadMeta?: unknown } = {},
) {
  const send = vi.fn();
  vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
  mockMessagesFetch(history, undefined, conv);
  render(<ChatPage />);
  await act(async () => {}); // 冲刷挂载 effects（fetchMessages 落定）
  return send;
}

describe("ChatPage", () => {
  /** objectURL 桩的序号（每用例归零）：附件断言落在 `blob:mock-N` 上，不依赖真实请求。 */
  let blobSeq = 0;

  beforeEach(() => {
    vi.restoreAllMocks();
    // E2E 存储按 convId 复用：清 msgCache/链/暂挂（cache-first 会跨用例读到旧明文）；
    // 草稿同样按 convId 持久（d.31），不清理会把上一个用例的半截输入带进来。
    for (const k of Object.keys(localStorage)) {
      if (
        k.startsWith("heming.msgCache.") ||
        k.startsWith("heming.e2e.") ||
        k.startsWith("heming.draft.") ||
        // d.126-C：思考/工具转录按消息落盘（按 convId 复用），不清理会把上个用例的块带进来
        k.startsWith("heming.transcript.")
      ) {
        localStorage.removeItem(k);
      }
    }
    // 通知与待确认队列跨用例不残留（d.34 起确认会推通知，泄漏会串到别的断言）。
    useNotificationStore.setState({ items: [] });
    useHitlStore.getState().cancelAll("测试隔离");
    // jsdom 未实现 scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
    // 附件气泡：createObjectURL 给可区分伪地址，revoke 留给卸载断言（jsdom 原生缺，由 test-setup 补桩）
    blobSeq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mock-${++blobSeq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.mocked(connectWs).mockReset();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() });
    vi.mocked(hasSubtle).mockReturnValue(true);
    vi.mocked(sealMessage).mockReset();
    vi.mocked(sealMessage).mockImplementation(stubSeal as never);
    // 流式管道复位：streamChat 回空串；llm 绑定默认清空（无绑定 → 发送前拦截路径）；
    // chat store 的 streaming/streamOwner 跨用例不残留
    vi.mocked(streamChat).mockReset();
    vi.mocked(streamChat).mockResolvedValue("");
    vi.mocked(visionImageDataUrl).mockReset();
    vi.mocked(visionImageDataUrl).mockResolvedValue("aW1n");
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useUiStore.setState({
      page: "chat",
      activeConversationId: "c1",
      pendingAttachment: null,
      settingsTab: null,
    });
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            name: "和小鸣",
            avatar: null,
            owner_id: null,
            description: "",
          },
          unreadCount: 0,
        },
      ],
      messages: {},
      messagesLoading: {},
      messagesError: {},
      streaming: {},
      streamOwner: {},
      plainById: {},
      pendingE2e: {},
    });
    // 本批新增接线：@ 触发会注入记忆/技能段，从而改写系统提示词。既有用例只验证
    // 「原提示词 + 历史」链路（如 I3 的 system 内容严格相等），故把两个模块级单例
    // 内置为静止态（记忆总开关关闭 + 技能全禁用）——既有断言保持原样，不放宽；
    // 本批新增用例（本 describe 末尾）按需临时打开。
    memoryStore.updateSettings({ enabled: false });
    for (const s of skillPool.list()) skillPool.setEnabled(s.id, false);
    // 本批新增接线（上下文预算 · Task B）：@ 触发会把历史交给 prepareHistory 压缩，而
    // `heming.context.v1` 缺省即「开启」（预算 6000 / 保留 8 轮）——既有 fetchHistory 断言
    // （如 I3 的 30 轮原文、撤回剔除用例的逐条内容）会被压缩改写。故此处把本机设置显式置为
    // 「关闭 = 原样发送」（回到加预算之前的行为），既有断言一字不改；本批新增用例按需打开。
    // 摘要缓存键一并清掉，防跨用例命中（本文件内的用例共用 c1）。
    localStorage.setItem(
      CONTEXT_KEYS.settings,
      JSON.stringify({ enabled: false, budgetTokens: 6000, keepRecentTurns: 8, llmSummary: true }),
    );
    localStorage.removeItem(CONTEXT_KEYS.summaries);
  });

  afterEach(() => {
    vi.unstubAllGlobals(); // Task 5 的 MediaRecorder 桩不跨用例
    if (vi.isFakeTimers()) vi.useRealTimers(); // 录音 60s 上限用例即便中途失败也不泄漏假时钟
  });

  it("会话内搜索：命中明文、前后跳转并高亮当前消息", async () => {
    const m1 = msg("m1", "第一条 发布计划", "2026-10-14T01:00:00.000Z");
    const m2 = msg("m2", "第二条 无关", "2026-10-14T01:01:00.000Z");
    const m3 = msg("m3", "第三条 发布复盘", "2026-10-14T01:02:00.000Z");
    mockMessagesFetch([m1, m2, m3]);

    render(<ChatPage />);
    expect(await screen.findByText("第一条 发布计划")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    const input = screen.getByLabelText("搜索本会话");
    fireEvent.change(input, { target: { value: "发布" } });

    expect(await screen.findByText("1/2")).toBeInTheDocument();
    expect(document.getElementById("msg-m1")?.className).toContain("ring-[var(--warn-line)]");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(document.getElementById("msg-m3")?.className).toContain("ring-[var(--warn-line)]");

    // 再按一次循环回第一条
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("1/2")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("搜索本会话")).not.toBeInTheDocument();
  });

  /**
   * d.33 · P2-2：消息列表窗口化。
   *
   * 主判据是**渲染出的消息节点数**（确定性），不是耗时——vitest 里的计时断言在
   * 不同机器上极不稳定，只能当粗粒度冒烟。
   */
  it("长会话只渲染初始窗口，点按钮才追加更早的消息（d.33）", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      msg(`w${i}`, `第 ${i} 条`, `2026-10-14T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`),
    );
    mockMessagesFetch(many);

    const { container } = render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("第 199 条")).toBeInTheDocument());

    const rows = () => container.querySelectorAll('[id^="msg-w"]');
    expect(rows()).toHaveLength(DEFAULT_WINDOW);
    // 窗口贴着最新消息：最早的几条没渲染
    expect(screen.queryByText("第 0 条")).not.toBeInTheDocument();
    expect(screen.getByText("第 199 条")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /加载更早的消息/ }));
    expect(rows()).toHaveLength(DEFAULT_WINDOW * 2);
  });

  it("滚到顶部自动追加一窗历史（d.33）", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      msg(`r${i}`, `行 ${i}`, `2026-10-14T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`),
    );
    mockMessagesFetch(many);

    const { container } = render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("行 199")).toBeInTheDocument());
    const rows = () => container.querySelectorAll('[id^="msg-r"]');
    expect(rows()).toHaveLength(DEFAULT_WINDOW);

    const scroller = screen.getByTestId("message-list");
    scroller.scrollTop = 0; // 贴顶
    fireEvent.scroll(scroller);

    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_WINDOW * 2));
  });

  it("d.62：消息列 880 居中，输入区/工具栏同宽（宽屏行长可读）", async () => {
    mockMessagesFetch([msg("l1", "布局检查", "2026-10-14T00:00:00.000Z")]);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("布局检查")).toBeInTheDocument());

    const scroller = screen.getByTestId("message-list");
    const column = scroller.querySelector('[class*="max-w-[880px]"]');
    expect(column).not.toBeNull();
    expect(column!.className).toContain("mx-auto");
    expect(column!.className).toContain("w-full");
    // 消息行确实在 880 列内部（不是直接挂在滚动容器上）
    expect(column!.querySelector('[id^="msg-l1"]')).not.toBeNull();

    // 输入区、工具栏、快捷键提示共用同一宽度档
    const form = document.querySelector("form");
    const composerWrap = form?.querySelector('[class*="max-w-[880px]"]');
    expect(composerWrap).not.toBeNull();
    expect(screen.getByLabelText("消息输入框").closest('[class*="max-w-[880px]"]')).not.toBeNull();
    expect(screen.getByLabelText("输入快捷键提示").closest('[class*="max-w-[880px]"]')).not.toBeNull();
  });

  it("会话内搜索命中窗口外的老消息：自动扩窗后高亮（d.33）", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      msg(
        `s${i}`,
        i === 5 ? "老消息 目标命中" : `条目 ${i}`,
        `2026-10-14T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`,
      ),
    );
    mockMessagesFetch(many);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("条目 199")).toBeInTheDocument());
    // 窗口外：目标消息一开始没渲染
    expect(screen.queryByText("老消息 目标命中")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    fireEvent.change(screen.getByLabelText("搜索本会话"), { target: { value: "目标命中" } });

    // 扩窗后节点出现且被高亮
    expect(await screen.findByText("老消息 目标命中")).toBeInTheDocument();
    expect(document.getElementById("msg-s5")?.className).toContain("ring-[var(--warn-line)]");
  });

  it("切会话后窗口回到初始值（d.33）", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      msg(`c${i}`, `切 ${i}`, `2026-10-14T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`),
    );
    mockMessagesFetch(many);

    const { container } = render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("切 199")).toBeInTheDocument());
    const rows = () => container.querySelectorAll('[id^="msg-c"]');
    fireEvent.click(screen.getByRole("button", { name: /加载更早的消息/ }));
    expect(rows()).toHaveLength(DEFAULT_WINDOW * 2);

    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    await waitFor(() => expect(rows().length).toBeLessThanOrEqual(DEFAULT_WINDOW));
  });

  it("空会话：显示引导文案而不是整片空白", async () => {
    mockMessagesFetch([]);

    render(<ChatPage />);

    expect(await screen.findByText("还没有消息")).toBeInTheDocument();
    expect(screen.getByText("发送第一条消息，开始这段对话。")).toBeInTheDocument();
  });

  it("导出会话：本机明文生成 Markdown 并触发下载", async () => {
    const m1 = msg("m1", "第一条", "2026-10-14T01:00:00.000Z");
    const m2 = { ...msg("m2", "回答", "2026-10-14T01:01:00.000Z"), senderType: "agent" as const };
    mockMessagesFetch([m1, m2]);
    let clicked: HTMLAnchorElement | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked = this;
      });

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("第一条")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "导出会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "导出 Markdown" }));

    expect(clickSpy).toHaveBeenCalled();
    expect(clicked!.download).toMatch(/^和鸣-和小鸣-.*\.md$/);
    const urlArg = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0] as Blob;
    const content = new TextDecoder().decode(await urlArg.arrayBuffer());
    expect(content).toContain("# 会话：和小鸣");
    expect(content).toContain("第一条");
    expect(content).toContain("回答");
    expect(await screen.findByText(/已导出 2 条消息/)).toBeInTheDocument();
  });

  it("多选导出：只导出勾选的那几条，未勾选的不进文件", async () => {
    const m1 = msg("m1", "要留的", "2026-10-14T01:00:00.000Z");
    const m2 = { ...msg("m2", "不要的", "2026-10-14T01:01:00.000Z"), senderType: "agent" as const };
    mockMessagesFetch([m1, m2]);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("要留的")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "选择消息导出" }));
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);

    expect(screen.getByText("已选 1 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出所选 Markdown" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0] as Blob;
    const content = new TextDecoder().decode(await blob.arrayBuffer());
    expect(content).toContain("要留的");
    expect(content).not.toContain("不要的");
    expect(content).toContain("- 消息数：1");
    expect(await screen.findByText(/已导出 1 条消息/)).toBeInTheDocument();
  });

  it("多选导出：全选后导出 JSON，退出选择后勾选态清空", async () => {
    mockMessagesFetch([
      msg("m1", "第一条", "2026-10-14T01:00:00.000Z"),
      { ...msg("m2", "第二条", "2026-10-14T01:01:00.000Z"), senderType: "agent" as const },
    ]);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("第一条")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "选择消息导出" }));
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选 2 条")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导出所选 JSON" }));
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0] as Blob;
    const doc = JSON.parse(new TextDecoder().decode(await blob.arrayBuffer()));
    expect(doc.messages.map((x: { text: string }) => x.text)).toEqual(["第一条", "第二条"]);

    // 勾选保留（同一次选择里可能还要导另一种格式），退出选择才清
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "退出选择" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("已选 2 条")).not.toBeInTheDocument();
  });

  it("多选导出：一条没勾时导出按钮禁用；清空撤掉全部勾选", async () => {
    mockMessagesFetch([msg("m1", "第一条", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("第一条")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "选择消息导出" }));

    expect(screen.getByRole("button", { name: "导出所选 Markdown" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空" })).toBeDisabled();

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: "导出所选 Markdown" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText("已选 0 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出所选 Markdown" })).toBeDisabled();
  });


  it("挂载后收到 message_new：append 到消息列表", async () => {
    mockMessagesFetch([msg("m1", "第一条", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("第一条")).toBeInTheDocument());

    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: msg("m2", "断线期间的新消息", "2026-10-14T01:05:00.000Z"),
      });
    });

    expect(screen.getByText("断线期间的新消息")).toBeInTheDocument();
    expect(screen.getByText("第一条")).toBeInTheDocument(); // 历史仍在
    expect(useChatStore.getState().messages.c1.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("触发 onOpen（重连）：补拉 fetchMessages 并用合并结果渲染", async () => {
    const m1 = msg("m1", "旧消息", "2026-10-14T01:00:00.000Z");
    const m3 = msg("m3", "断档消息", "2026-10-14T01:10:00.000Z");
    const fetchMock = mockMessagesFetch([m1], [m1, m3]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("旧消息")).toBeInTheDocument());
    const messagesCalls = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/messages"));
    const callsBefore = messagesCalls().length;

    // 连接期间本地先收到一条（覆盖 WS 与补拉历史交错的合并不变量）
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: msg("m2", "本地已入列", "2026-10-14T01:07:00.000Z"),
      });
    });

    act(() => {
      lastHandlers().onOpen?.();
    });

    await waitFor(() => {
      const calls = messagesCalls();
      expect(calls.length).toBe(callsBefore + 1);
      expect(String(calls[calls.length - 1][0])).toBe("/api/conversations/c1/messages");
    });
    // 合并结果：历史 + 断档 + 本地独有条目全部渲染
    expect(await screen.findByText("断档消息")).toBeInTheDocument();
    expect(screen.getByText("本地已入列")).toBeInTheDocument();
    expect(screen.getByText("旧消息")).toBeInTheDocument();
    expect(useChatStore.getState().messages.c1.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 无发送失败提示
  });

  it("断线显示重连横幅，恢复后横幅消失并短暂提示已恢复", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);

    act(() => {
      lastHandlers().onClose?.();
    });
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("连接已断开");
    expect(
      screen.getByText("连接已断开，正在自动重连…消息会排队，恢复后自动补发"),
    ).toBeInTheDocument();

    act(() => {
      lastHandlers().onOpen?.();
    });
    expect(
      screen.queryByText("连接已断开，正在自动重连…消息会排队，恢复后自动补发"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("通道已恢复")).toBeInTheDocument();
    expect(screen.getByText("通道已连接")).toBeInTheDocument();
  });

  it("首次连接不显示「通道已恢复」", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    act(() => {
      lastHandlers().onOpen?.();
    });
    expect(screen.getByText("通道已连接")).toBeInTheDocument();
    expect(screen.queryByText("通道已恢复")).not.toBeInTheDocument();
  });

  it("恢复提示出现后再断线：提示立刻收起，断线横幅出现", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    act(() => {
      lastHandlers().onClose?.();
    });
    act(() => {
      lastHandlers().onOpen?.();
    });
    expect(screen.getByText("通道已恢复")).toBeInTheDocument();

    act(() => {
      lastHandlers().onClose?.();
    });
    expect(screen.queryByText("通道已恢复")).not.toBeInTheDocument();
    expect(
      screen.getByText("连接已断开，正在自动重连…消息会排队，恢复后自动补发"),
    ).toBeInTheDocument();
  });

  it("切会话重建连接不误报「通道已恢复」（断线标记不跨会话黏住）", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    act(() => {
      lastHandlers().onClose?.();
    });
    act(() => {
      lastHandlers().onOpen?.();
    });
    expect(screen.getByText("通道已恢复")).toBeInTheDocument();

    // 切到 c2：WS effect 重建，新连接尚未 open → 回到「通道连接中…」，恢复提示清掉
    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    expect(screen.getByText("通道连接中…")).toBeInTheDocument();
    expect(screen.queryByText("通道已恢复")).not.toBeInTheDocument();

    // c2 的连接首次 open 不算「恢复」
    act(() => {
      lastHandlers().onOpen?.();
    });
    expect(screen.getByText("通道已连接")).toBeInTheDocument();
    expect(screen.queryByText("通道已恢复")).not.toBeInTheDocument();
  });

  it("「通道已恢复」3 秒后自动消失", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    vi.useFakeTimers();
    try {
      act(() => {
        lastHandlers().onClose?.();
      });
      act(() => {
        lastHandlers().onOpen?.();
      });
      expect(screen.getByText("通道已恢复")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2999);
      });
      expect(screen.getByText("通道已恢复")).toBeInTheDocument(); // 未满 3 秒仍在

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText("通道已恢复")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });








  it("连接句柄为 null 时发送：保留草稿并显示「连接未就绪，消息未发送」", async () => {
    vi.mocked(connectWs).mockReturnValue(null as unknown as WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    bindAssistant(); // 新版发送先过「绑定检查」，再检查 socket 句柄
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "还没发出去的话" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("连接未就绪，消息未发送");
    expect(input).toHaveValue("还没发出去的话"); // 草稿未被清空
  });

  it("句柄就绪时发送：走 handle.send，清空草稿且无失败提示", async () => {
    bindAssistant();
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const plain = await lastSealed(send);
    expect(plain).toMatchObject({ kind: "text", text: "你好" }); // 另带会话绑定的 mentions
    const ev = send.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(ev.conversationId).toBe("c1");
    expect(JSON.stringify(ev)).not.toContain("你好"); // 明文不落帧
    await waitFor(() => expect(input).toHaveValue("")); // 封发异步：等落帧后断言清空
    // 「无失败提示」：不能用 queryByRole("status") 当代理——消息骨架与流式气泡现在也带
    // role=status（③-2 语义补全），这里按失败提示的具体文案断言。
    expect(screen.queryByText(/发送失败/)).not.toBeInTheDocument();
  });

  it("草稿按会话持久：切走再回来各自的字还在，不串会话（d.31）", async () => {
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), {
      target: { value: "给 A 的草稿" },
    });

    // 切到 c2：切会话时会把待写草稿**立即**落盘（不等 300ms 节流），再读 c2 的草稿
    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    await waitFor(() => expect(screen.getByPlaceholderText("输入消息…")).toHaveValue(""));

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), {
      target: { value: "给 B 的草稿" },
    });

    // 切回 c1：A 的字回来了——这正是「ChatPage 常驻不卸载」下最容易串的地方
    act(() => {
      useUiStore.setState({ activeConversationId: "c1" });
    });
    await waitFor(() =>
      expect(screen.getByPlaceholderText("输入消息…")).toHaveValue("给 A 的草稿"),
    );
  });

  it("发送成功后清掉落盘的草稿（d.31）", async () => {
    bindAssistant();
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    // 预置一条已落盘的草稿（模拟节流窗口已过）
    localStorage.setItem("heming.draft.c1", JSON.stringify({ text: "你好", at: 1 }));

    render(<ChatPage />);
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    await waitFor(() => expect(input).toHaveValue("你好")); // 挂载时读回草稿

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await lastSealed(send);

    await waitFor(() => expect(input).toHaveValue(""));
    expect(localStorage.getItem("heming.draft.c1")).toBeNull(); // 盘上的那份也清了
  });


















  /** 在助手会话里发出指定文本（流式用例共用前奏）。 */
  async function pickAndSend(text: string) {
    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
  }




  it("生成中提示行点中断：abortAll → finish(partial) + aborted 错误行可重试", async () => {
    const send = await setupAgentChat();
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(
      (_p, _m, o) =>
        new Promise<string>((_res, rej) => {
          o.onDelta("半");
          o.signal.addEventListener("abort", () =>
            rej(new DOMException("AbortError", "AbortError")),
          );
        }),
    );

    await pickAndSend("@和小鸣 写段文字");
    await waitFor(() => expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument());
    expect(document.body.textContent).toContain("▌");

    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_error", code: "aborted" }),
      ),
    );
    await waitFor(() => expect(sealedOf(send, "agent_finish")).toHaveLength(1));
    expect(sealedOf(send, "agent_finish")[0].plain).toMatchObject({
      kind: "text",
      text: expect.stringContaining("半"),
    });

    const errEv = send.mock.calls.map((c) => c[0]).find((e) => e.type === "agent_error");
    expect(errEv).toMatchObject({ code: "aborted", message: "" }); // fix I2：message 进密文
    act(() => {
      lastHandlers().onEvent(errEv); // 密文回声：本机经出站箱还原原文（fix round 2）
    });
    // 密文回声经出站箱还原原文（异步解密链 → waitFor）；中断文案已中文化（A2）
    await waitFor(() => expect(screen.getByText(/已中断，可继续生成/)).toBeInTheDocument());
    expect(screen.getByText("继续生成")).toBeInTheDocument();
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument(); // 不再生成中
  });

  it("他机流：非本机 agent_chunk 按 text 累积渲染，message_new{streamId} 收口移除", async () => {
    await setupAgentChat();

    act(() => {
      lastHandlers().onEvent({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId: "remote-1",
        text: "你",
      });
    });
    act(() => {
      lastHandlers().onEvent({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId: "remote-1",
        text: "好",
      });
    });

    expect(screen.getByText(/你好/)).toBeInTheDocument(); // 累积而非单段
    expect(screen.getAllByText("和小鸣").length).toBeGreaterThan(0); // 标题/气泡署名
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument(); // 非本机流不占「生成中」行
    expect(useChatStore.getState().streaming["remote-1"]?.text).toBe("你好");

    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        streamId: "remote-1",
        message: {
          ...msg("mRemote", "你好", "2026-10-14T01:02:00.000Z"),
          senderType: "agent",
          senderId: "system-assistant",
        },
      });
    });
    expect(screen.queryByText("▌")).not.toBeInTheDocument();
    expect(useChatStore.getState().streaming["remote-1"]).toBeUndefined();
  });

  it("F1 回归：卸载中止后 finish(partial)/agent_error 在 ws close 之前实际发出", async () => {
    // 受控时序：send 与 close 往同一 order 记事件类型，锁定「catch 两帧先于 close」的次序
    const order: string[] = [];
    const send = vi.fn((e: WsClientEvent) => {
      order.push(e.type);
    });
    const close = vi.fn(() => {
      order.push("close");
    });
    vi.mocked(connectWs).mockReturnValue({ send, close } satisfies WsHandle);
        mockMessagesFetch([]);
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(
      (_p, _m, o) =>
        new Promise<string>((_res, rej) => {
          const abort = () => rej(new DOMException("AbortError", "AbortError"));
          if (o.signal.aborted) return abort();
          o.onDelta("半");
          o.signal.addEventListener("abort", abort);
        }),
    );

    const view = render(<ChatPage />);
    await act(async () => {});
    await pickAndSend("@和小鸣 写段文字");
    await waitFor(() => expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument());
    expect(Object.keys(useChatStore.getState().streaming)).toHaveLength(1); // 流已在飞（onDelta 半）

    view.unmount(); // cleanup：WS effect 先排期延迟 close，随后 abort effect 中止进行中流

    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(sealedOf(send, "agent_finish")[0]?.plain).toMatchObject({
      kind: "text",
      text: expect.stringContaining("半"),
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_error", code: "aborted" }),
    );
    // 次序不变量：catch（微任务）的两帧落到句柄上，必须早于 close（宏任务）——否则 partial 不入库
    expect(order.indexOf("agent_finish")).toBeLessThan(order.indexOf("close"));
    expect(order.indexOf("agent_error")).toBeLessThan(order.indexOf("close"));
  });

  it("I1 挂载清扫：本会话孤儿 streaming/streamOwner 条目被清，他会话条目保留", async () => {
    // 上一轮卸载中止后 socket 已关、echo 收不到 → store 残留本会话「生成中」孤儿项
    useChatStore.setState({
      streaming: {
        orphan1: {
          agentId: "system-assistant",
          conversationId: "c1",
          text: "残留半句",
          status: "streaming",
          lastAt: 0,
        },
        otherConv: {
          agentId: "system-assistant",
          conversationId: "c2",
          text: "他会话的流",
          status: "streaming",
          lastAt: 0,
        },
      },
      streamOwner: { orphan1: true, otherConv: true },
    });
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {}); // 冲刷挂载 effects（含清扫）

    const st = useChatStore.getState();
    expect(Object.keys(st.streaming).sort()).toEqual(["otherConv"]); // 本 convId 孤儿被清
    expect(st.streamOwner).toEqual({ otherConv: true }); // 归属键同步清，他会话保留
    expect(screen.queryByText("残留半句")).not.toBeInTheDocument(); // 无「生成中」气泡残留
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument(); // 中断行不再出现（no-op 中断按钮消失）
  });

  it("I3 fetchHistory 不再硬截 30 条：35 条历史全部进提示词（压缩交给 prepareHistory）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        const history = Array.from({ length: 35 }, (_, i) =>
      msg(`m${i + 1}`, `历史${i + 1}`, `2026-10-14T01:00:${String(i).padStart(2, "0")}.000Z`),
    );
    mockMessagesFetch(history);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 查下上下文");
    await waitFor(() => expect(seen).toBeDefined());

    // 窗口是 120 条 → 35 条全在；末条不等于发送文本故不被剔除
    // （bindAssistant 的系统提示词 unshift 在最前 + 本条 user 轮追加在尾 → 37 条）
    expect(seen).toHaveLength(37);
    expect(seen![0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(seen![1]).toEqual({ role: "user", content: "历史1" }); // 第 31 条以前的原话不再被丢
    expect(seen![35]).toEqual({ role: "user", content: "历史35" });
    expect(seen![36]).toEqual({ role: "user", content: "@和小鸣 查下上下文" });
  });

  it("I3b fetchHistory 带回上一轮工具链：tool_calls 与 role=tool 严格配对", async () => {
    type SentRow = {
      role: string;
      content: string;
      tool_call_id?: string;
      name?: string;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const assistant: Message = {
      ...agentMsg("m2", "我查一下天气。", "2026-10-14T01:00:01.000Z"),
      tools: [
        {
          id: "call_1",
          name: "天气__查询",
          args: '{"city":"杭州"}',
          status: "ok",
          result: "杭州 22℃ 多云",
          startedAt: 1,
          endedAt: 2,
        },
        {
          id: "call_2",
          name: "shell__exec",
          args: '{"cmd":"ls"}',
          status: "denied",
          startedAt: 3,
        },
      ],
    } as Message;
    mockMessagesFetch([msg("m1", "杭州天气怎么样？", "2026-10-14T01:00:00.000Z"), assistant]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: SentRow[] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages as unknown as SentRow[];
      return "";
    });

    await pickAndSend("@和小鸣 接着说");
    await waitFor(() => expect(seen).toBeDefined());

    const rows = seen!;
    const assistantRow = rows.find((r) => (r.tool_calls?.length ?? 0) > 0);
    expect(assistantRow).toBeDefined();
    expect(assistantRow!.role).toBe("assistant");
    expect(assistantRow!.tool_calls!.map((c) => c.id)).toEqual(["call_1", "call_2"]);
    // 名字与参数原样带回：模型才知道上一轮到底调了什么、传了什么
    expect(assistantRow!.tool_calls![0].function).toEqual({
      name: "天气__查询",
      arguments: '{"city":"杭州"}',
    });

    const toolRows = rows.filter((r) => r.role === "tool");
    expect(toolRows.map((r) => r.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(toolRows[0].content).toContain("杭州 22℃");
    // 被拒绝的调用也要留痕：否则模型会以为那次执行成功过
    expect(toolRows[1].content).toContain("用户拒绝");
  });

  it("附件文本进提示词：模型能看到文件内容，且带清晰边界", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        // 一条带解析文本的附件消息（模拟已上传成功的 PDF/DOCX 解析结果）
    const withDoc: Message = {
      ...msg("m1", "帮我总结这份报告", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "帮我总结这份报告",
        file: {
          id: "f1",
          name: "季度报告.pdf",
          mime: "application/pdf",
          size: 2048,
          text: "本季度营收 1580 万元，同比增长 23%。",
        },
      },
    };
    mockMessagesFetch([withDoc]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 那增长主要来自哪");
    await waitFor(() => expect(seen).toBeDefined());

    const withAttachment = seen!.find((m) => m.content.includes("季度报告.pdf"));
    expect(withAttachment, "附件文本必须出现在提示词里").toBeDefined();
    // 正文在前、附件块在后；文件名要出现，内容是解析出来的文字
    expect(withAttachment!.content).toContain("帮我总结这份报告");
    expect(withAttachment!.content).toContain("本季度营收 1580 万元");
    expect(withAttachment!.content).toContain("【附件结束】");
    // 角色仍是发起人，不能因为带附件就变成 assistant
    expect(withAttachment!.role).toBe("user");
  });

  it("没有解析文本的附件不污染提示词（只有正文，不出现空附件块）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        const noText: Message = {
      ...msg("m1", "看下这个", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看下这个",
        file: { id: "f2", name: "photo.png", mime: "image/png", size: 900 },
      },
    };
    mockMessagesFetch([noText]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });
    await pickAndSend("@和小鸣 这是什么");
    await waitFor(() => expect(seen).toBeDefined());
    const row = seen!.find((m) => m.content.includes("看下这个"));
    expect(row!.content).toBe("看下这个");
    expect(row!.content).not.toContain("【附件");
  });

  it("视觉模型：历史图片转成内容片，正文同条保留", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        const withImage: Message = {
      ...msg("m1", "这是什么", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "这是什么",
        file: { id: "f9", name: "cat.png", mime: "image/png", size: 900, key: "k9" },
      },
    };
    mockMessagesFetch([withImage]);
    render(<ChatPage />);
    await act(async () => {});
    useLlmStore.setState({
      profiles: [{ ...testProfile, model: "gpt-4o" }],
      bindings: { "system-assistant": "p1" },
      prompts: { "system-assistant": "你是和小鸣" },
    });

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 你再看一遍");
    await waitFor(() => expect(seen).toBeDefined());

    const row = seen!.find((m) => m.content === "这是什么");
    expect(row?.contentParts).toEqual([
      { type: "text", text: "这是什么" },
      { type: "image", mime: "image/png", data: "aW1n" },
    ]);
    // 只有声明支持视觉的模型才会去解密读图
    expect(visionImageDataUrl).toHaveBeenCalledWith(expect.objectContaining({ id: "f9" }));
  });

  it("非视觉模型：历史图片不附内容片，也不解密读图", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        const withImage: Message = {
      ...msg("m1", "看看图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看看图",
        file: { id: "f9", name: "cat.png", mime: "image/png", size: 900, key: "k9" },
      },
    };
    mockMessagesFetch([withImage]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant(); // 未知模型 m → 保守判定为不支持视觉

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 这是什么");
    await waitFor(() => expect(seen).toBeDefined());

    expect(seen!.some((m) => m.contentParts)).toBe(false);
    expect(visionImageDataUrl).not.toHaveBeenCalled();
  });

  it("图片 + 文字同发：一条消息带正文与附件，模型当轮就看到图", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        // 回声抢在前面落库的同一张图（同 id）：同发后它不该再作为独立历史行重复送模型
    const echoed: Message = {
      ...msg("m9", "@和小鸣 这张图里有什么", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "@和小鸣 这张图里有什么",
        file: { id: "f9", name: "cat.png", mime: "image/png", size: 4, key: "k9" },
      },
    };
    mockMessagesFetch([echoed], undefined, {
      uploadMeta: {
        id: "f9",
        owner: "alice",
        name: "cat.png",
        mime: "image/png",
        size: 4,
        updatedAt: "2026-10-17T00:00:00.000Z",
      },
    });
    render(<ChatPage />);
    await act(async () => {});
    useLlmStore.setState({
      profiles: [{ ...testProfile, model: "gpt-4o" }],
      bindings: { "system-assistant": "p1" },
      prompts: { "system-assistant": "你是和小鸣" },
    });

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), {
      target: { value: "@和小鸣 这张图里有什么" },
    });
    captureFilePicker().pick("image/*", new File(["img"], "cat.png", { type: "image/png" }));

    // ① 同发 = 一条消息同时带正文与附件（不是「正文一条 + 附件一条」两步）
    const plain = await lastSealed(send);
    expect(plain.kind).toBe("file");
    expect(plain.text).toBe("@和小鸣 这张图里有什么");
    expect((plain.file as { id: string }).id).toBe("f9");

    // ② 模型这一轮就读到图：当前 user 行自带内容片
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen!.at(-1)).toEqual({
      role: "user",
      content: "@和小鸣 这张图里有什么",
      contentParts: [
        { type: "text", text: "@和小鸣 这张图里有什么" },
        { type: "image", mime: "image/png", data: "aW1n" },
      ],
    });
    // ③ 同一轮不因「回声已入库」而重复出现
    expect(seen!.filter((r) => r.content.includes("这张图里有什么"))).toHaveLength(1);
    // ④ 同发即发送：草稿与 @ chip 一并清空
    expect(screen.getByPlaceholderText("输入消息…")).toHaveValue("");
  });


  it("输入区有表情/图片/文件/语音/发送按钮（工具行 + 输入行两行布局）", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {}); // 冲刷挂载 effects

    expect(screen.getByLabelText("表情")).toBeInTheDocument();
    expect(screen.getByLabelText("图片")).toBeInTheDocument();
    expect(screen.getByLabelText("文件")).toBeInTheDocument();
    expect(screen.getByLabelText("语音输入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();

    // 工具行（表情/图片/文件）与输入行（输入框/语音/发送）是两个相邻容器
    const tool = screen.getByLabelText("表情").parentElement!;
    const input = screen.getByPlaceholderText("输入消息…");
    expect(tool).toContainElement(screen.getByLabelText("图片"));
    expect(tool).toContainElement(screen.getByLabelText("文件"));
    const inputRow = input.parentElement!;
    expect(inputRow).toContainElement(screen.getByLabelText("语音输入"));
    expect(inputRow).toContainElement(screen.getByRole("button", { name: "发送" }));
    expect(tool).not.toBe(inputRow);
  });


  it("点语音输入：无 Web Speech API 的环境提示不支持，不静默", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    // mic 按钮改弹双选项浮层：先开菜单，再选「转文字」走原 STT 路径
    fireEvent.click(screen.getByLabelText("语音输入"));
    fireEvent.click(screen.getByRole("button", { name: "语音输入（转文字）" }));
    expect(screen.getByRole("status")).toHaveTextContent("当前环境不支持语音输入");
  });

  it("切 convId 清发送提示：A 会话的语音提示不带进 B 会话", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("语音输入"));
    fireEvent.click(screen.getByRole("button", { name: "语音输入（转文字）" }));
    expect(screen.getByRole("status")).toHaveTextContent("当前环境不支持语音输入");

    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    expect(screen.queryByText("当前环境不支持语音输入")).not.toBeInTheDocument(); // 提示随会话清理
  });

  it("切会话停掉旧识别器：convId 切换调其 stop 并清实例，旧 onend 不清新会话指示", async () => {
    mockMessagesFetch([]);
    const instances: FakeSR[] = [];
    class FakeSR {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult?: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend?: () => void;
      onerror?: () => void;
      start = vi.fn();
      stop = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeSR;
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音输入（转文字）" }));
      expect(instances).toHaveLength(1);
      expect(instances[0].start).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("语音输入")).toHaveClass("bg-ink"); // 识别中

      // 切会话：旧识别器必须立即停（否则其 onresult 继续回填新会话草稿）
      act(() => {
        useUiStore.setState({ activeConversationId: "c2" });
      });
      expect(instances[0].stop).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("语音输入")).not.toHaveClass("bg-ink"); // 识别态复位

      // 实例已清空：再切会话/卸载不重复 stop 旧实例
      act(() => {
        useUiStore.setState({ activeConversationId: "c3" });
      });
      expect(instances[0].stop).toHaveBeenCalledTimes(1);

      // 新会话重开识别后，旧实例晚到的 onend 不得误清新会话的指示
      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音输入（转文字）" }));
      expect(instances).toHaveLength(2);
      expect(screen.getByLabelText("语音输入")).toHaveClass("bg-ink");
      act(() => {
        instances[0].onend?.();
      });
      expect(screen.getByLabelText("语音输入")).toHaveClass("bg-ink");
      expect(instances[1].start).toHaveBeenCalledTimes(1); // 新实例确在识别
    } finally {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    }
  });

  it("渲染带 file 的消息为附件卡：非图片显示文件名，链接指向带鉴权取到的 objectURL", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    mockMessagesFetch([m]);

    render(<ChatPage />);
    expect(await screen.findByText("报告.pdf")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /报告\.pdf/ });
    // content 路由裸链接会 401 → 组件带 Authorization fetch 后落 objectURL 桩
    expect(link).toHaveAttribute("href", "blob:mock-1");
    expect(link).toHaveAttribute("download", "报告.pdf"); // objectURL 上 download 属性仍可用
    expect(link).toHaveTextContent("0.0 KB"); // 10 字节 → 0.0 KB（size 口径）
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); // 非图片不出缩略图
  });

  it("图片附件渲染为缩略图（src 为鉴权 fetch 得到的 objectURL，非裸 content 地址）", async () => {
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f9", name: "a.png", mime: "image/png", size: 1024 },
      },
    };
    mockMessagesFetch([m]);

    render(<ChatPage />);
    const img = (await screen.findByRole("img", { name: "a.png" })) as HTMLImageElement;
    expect(img).toHaveAttribute("src", "blob:mock-1");
    expect(screen.getByText("看这张图")).toBeInTheDocument(); // 文本与附件共存
  });

  it("附件 objectURL：卸载时 revoke（防泄漏），卸载前不销", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    mockMessagesFetch([m]);

    const view = render(<ChatPage />);
    const link = await screen.findByRole("link", { name: /报告\.pdf/ });
    expect(link).toHaveAttribute("href", "blob:mock-1");
    expect(vi.mocked(URL.revokeObjectURL)).not.toHaveBeenCalled(); // 仍在用

    view.unmount();
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith("blob:mock-1");
  });

  it("附件 objectURL 竞态：content fetch 未回即卸载 → 晚到结果取到即销（不渲染不泄漏）", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    // content 请求悬停：由用例掌控 resolve 时机，模拟「fetch 还没回来就已卸载」
    let resolveContent!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveContent = res;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (/\/messages$/.test(url)) return Promise.resolve(jsonRes([m]));
      if (/\/(reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));
      if (/\/files\/[^/]+\/content$/.test(url)) return pending;
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    const view = render(<ChatPage />);
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes("/files/f1/content")),
      ).toBe(true), // 附件 effect 已发起 content fetch（响应仍挂起）
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument(); // 取 blob 期间不渲染

    view.unmount(); // effect cleanup：alive=false，owned 尚空 → 卸载本身不销
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    // 晚到的响应：取到即销（无人再用，不 setUrl、不留 objectURL）
    await act(async () => {
      resolveContent({
        ok: true,
        status: 200,
        blob: async () => new Blob(["bin"]),
      } as unknown as Response);
      await new Promise((r) => setTimeout(r, 0)); // 冲刷 fetchFileBlobUrl 的多跳微任务
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
  });

  it("附件 content 拉取失败（401）：给「加载失败」占位，不出断链 img/链接，可重试", async () => {
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f9", name: "a.png", mime: "image/png", size: 1024 },
      },
    };
    mockMessagesFetch([m], undefined, { contentFail: true });

    render(<ChatPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("加载失败");
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); // 不渲染 src 指向裸地址的断图
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    // ③-3：失败不能只能干看着——给「重试」入口
    expect(within(alert).getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("附件加载失败后点「重试」：重新拉取成功并渲染", async () => {
    let contentAttempt = 0;
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f9", name: "a.png", mime: "image/png", size: 1024 },
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (/\/messages$/.test(url)) return Promise.resolve(jsonRes([m]));
      if (/\/(reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));
      if (/\/files\/[^/]+\/content$/.test(url)) {
        contentAttempt += 1;
        if (contentAttempt === 1) return Promise.resolve(jsonRes({ error: "denied" }, 401));
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob(["bin"]),
        } as unknown as Response);
      }
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("img", { name: "a.png" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * 会话历史 + 自定义附件 content 的 fetch 面（E2E Task 5 渲染组）：
   * content 返回什么字节由用例决定（密文/明文/坏字节），其余端点与 mockMessagesFetch 同口径。
   */
  function mockAttachmentFetch(messages: Message[], content: () => Blob) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (/\/messages$/.test(url)) return Promise.resolve(jsonRes(messages));
      if (/\/(reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));
      if (/\/files\/[^/]+\/content$/.test(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => content(),
        } as unknown as Response);
      }
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });
  }

  /** objectURL 桩最近一次喂进去的 Blob 字节（断言「渲染的是解密明文还是服务端原字节」）。 */
  async function servedBytes(index = 0): Promise<string> {
    const calls = vi.mocked(URL.createObjectURL).mock.calls;
    const blob = calls.at(-(index + 1))![0] as Blob;
    return new TextDecoder().decode(await blob.arrayBuffer());
  }

  // —— E2E Task 5：附件解密渲染 ——

  it("带 key 的图片附件：解密后渲染 img，objectURL 拿到的是解密明文", async () => {
    const plaintext = "PNG-FAKE-BYTES-端到端附件";
    const key = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const cipher = await sealAttachment(key, plaintext);
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f1", name: "图.png", mime: "image/png", size: 48, key },
      },
    };
    mockAttachmentFetch([m], () => cipher);

    render(<ChatPage />);
    const img = await screen.findByRole("img", { name: "图.png" });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(img).toHaveAttribute("src", "blob:mock-1");
    expect(await servedBytes()).toBe(plaintext); // 解密回原文，而非服务端密文字节
    expect(await servedBytes()).not.toBe(new TextDecoder().decode(await cipher.arrayBuffer()));
  });

  it("带 key 的音频附件：AudioBubble 解密后渲染播放器", async () => {
    const plaintext = "audio-bytes";
    const key = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const cipher = await sealAttachment(key, plaintext);
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f-a", name: "语音.webm", mime: "audio/webm", size: 11, key },
      },
    };
    mockAttachmentFetch([m], () => cipher);

    render(<ChatPage />);
    const audio = (await screen.findByTestId("audio-bubble")) as HTMLAudioElement;
    expect(audio).toHaveAttribute("src", "blob:mock-1");
    expect(await servedBytes()).toBe(plaintext);
    expect(screen.queryByRole("link", { name: /语音\.webm/ })).not.toBeInTheDocument();
  });

  it("带 key 但密钥不匹配：解密失败给「加载失败」占位，不建 objectURL不出断链", async () => {
    const good = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const wrong = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const cipher = await sealAttachment(good, "解不开的内容");
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "图.png", mime: "image/png", size: 48, key: wrong },
      },
    };
    mockAttachmentFetch([m], () => cipher);

    render(<ChatPage />);
    expect(await screen.findByText("加载失败")).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("无 key 的 legacy 明文附件照旧显示：服务端原字节直通 objectURL（不走解密）", async () => {
    const plain = "LEGACY-PLAIN-BYTES";
    const m: Message = {
      ...msg("m1", "旧附件", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "旧附件",
        file: { id: "f-old", name: "旧.pdf", mime: "application/pdf", size: 18 },
      },
    };
    mockAttachmentFetch([m], () => new Blob([plain], { type: "application/pdf" }));

    render(<ChatPage />);
    const link = await screen.findByRole("link", { name: /旧\.pdf/ });
    expect(link).toHaveAttribute("href", "blob:mock-1");
    expect(await servedBytes()).toBe(plain); // 原样直通：没有 key 就没有解密步骤
  });

  /**
   * 工具行选文件走 document.createElement("input") 弹系统选择器（jsdom 无文件 UI）：
   * 拦下创建的 input、塞 files、手动触 onchange，等价于「用户选中了文件」。
   */
  function captureFilePicker() {
    const created: HTMLInputElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      ((tag: string) => {
        const el = orig(tag);
        if (tag === "input") created.push(el as HTMLInputElement);
        return el;
      }) as typeof document.createElement,
    );
    return {
      pick(accept: string | undefined, file: File | Partial<File>) {
        fireEvent.click(screen.getByLabelText(accept ? "图片" : "文件"));
        const input = created[0];
        expect(input).toBeDefined();
        expect(input.type).toBe("file");
        expect(input.accept).toBe(accept ?? "");
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.onchange?.call(input, new Event("change"));
        return input;
      },
    };
  }

  /** 附件用例的 fetch 面：POST /api/files 回 meta，会话只读端点回空表（其余 404）。 */
  function mockUploadFetch(
    meta = { id: "f1", owner: "alice", name: "a.txt", mime: "text/plain", size: 2, updatedAt: "2026-10-17T00:00:00.000Z" },
  ) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/files") return Promise.resolve(jsonRes(meta, 201));
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));

      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });
  }

  it("选中文件 → 密文上传共享库 → 发纯附件消息（file.key 随密文，POST 体非明文）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick(
      undefined,
      new File(["HEMING-SECRET"], "a.txt", { type: "text/plain" }),
    );

    const plain = await lastSealed(send);
    // 消息侧保留原名/原 mime（气泡按它路由与展示），密钥 key 随明文进密文
    expect(plain).toEqual({
      kind: "file",
      text: "",
      file: {
        id: "f1",
        name: "a.txt",
        mime: "text/plain",
        size: 13, // 原文件字节数（f.size），非服务端密文长度
        key: expect.any(String),
        // 文档解析：txt 直接读出原文，随密文上行供模型使用
        text: "HEMING-SECRET",
      },
    });
    expect(fromB64((plain.file as { key: string }).key)).toHaveLength(32);
    const post = fetchSpy.mock.calls.find(
      (c) => String(c[0]) === "/api/files" && c[1]?.method === "POST",
    );
    expect(post).toBeDefined(); // 附件已落共享库
    const body = JSON.parse(String((post![1] as RequestInit).body)) as {
      name: string;
      mime: string;
      contentBase64: string;
    };
    // 服务端只见密文：mime 降级 octet-stream、name 加 .enc 前缀、正文无原文字节
    expect(body.mime).toBe("application/octet-stream");
    expect(body.name).toBe(".enca.txt");
    const raw = fromB64(body.contentBase64);
    expect(String.fromCharCode(...raw.subarray(12))).not.toContain("HEMING-SECRET");
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 成功路径不报错
  });

  it("附件超 6MB：不上传不发送，提示「文件需小于 6MB」；图片入口限定 image/*", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick("image/*", {
      name: "huge.png",
      type: "image/png",
      size: 7 * 1024 * 1024,
    } as unknown as File);

    expect(await screen.findByRole("alert")).toHaveTextContent("文件需小于 6MB");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false); // 未发起上传
  });

  it("非视觉模型发图片：照常发送，但当场提示「模型读不到内容」", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            owner_id: null,
            name: "和小鸣",
            avatar: null,
            description: "官方",
          },
          unreadCount: 0,
        },
      ],
    });
    mockUploadFetch({
      id: "f9",
      owner: "alice",
      name: "cat.png",
      mime: "image/png",
      size: 4,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });

    render(<ChatPage />);
    await act(async () => {});
    bindAssistant(); // model "m" → 能力未知，按不支持视觉处理

    captureFilePicker().pick("image/*", new File(["img"], "cat.png", { type: "image/png" }));

    const status = await screen.findByText(/不支持图片输入/);
    expect(status).toHaveTextContent("绑定的模型不支持图片输入");
    expect(status).toHaveTextContent("和小鸣");
    // 图片照常发出（只是模型读不到），不是拦截
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" })),
    );
  });

  it("视觉模型发图片：不出现「不支持图片输入」提示", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            owner_id: null,
            name: "和小鸣",
            avatar: null,
            description: "官方",
          },
          unreadCount: 0,
        },
      ],
    });
    mockUploadFetch({
      id: "f9",
      owner: "alice",
      name: "cat.png",
      mime: "image/png",
      size: 4,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });

    render(<ChatPage />);
    await act(async () => {});
    useLlmStore.setState({
      profiles: [{ ...testProfile, model: "gpt-4o" }],
      bindings: { "system-assistant": "p1" },
      prompts: { "system-assistant": "你是和小鸣" },
    });

    captureFilePicker().pick("image/*", new File(["img"], "cat.png", { type: "image/png" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" })),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("已授权工具但绑定的模型不会调工具：输入区当场说明这次不调工具", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            owner_id: null,
            name: "和小鸣",
            avatar: null,
            description: "官方",
          },
          unreadCount: 0,
        },
      ],
    });
    for (const srv of [...mcpRegistry.servers()]) mcpRegistry.remove(srv.id);
    const server = mcpRegistry.add({
      id: "srv-notice",
      name: "echo-svc",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
    });
    mcpRegistry.setTools(server.id, [{ name: "echo", description: "回声工具" }]);
    mcpRegistry.setToolEnabled(server.id, "echo", true);
    mockMessagesFetch([]);
    // 能力表 + 覆盖层是判定唯一来源：这里用覆盖层模拟「模型不支持函数调用」
    setOverride("openai", "m", { supportsTools: false });

    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    expect(await screen.findByText(/不支持工具调用（和小鸣）/)).toBeInTheDocument();
    // 覆盖层是全局 localStorage：不清掉会串到别的用例（那里默认按支持工具算）
    localStorage.removeItem(MODEL_CAPS_KEY);
    mcpRegistry.remove(server.id);
  });

  it("模型支持工具时，输入区不出现工具降级提示", async () => {
    localStorage.removeItem(MODEL_CAPS_KEY);
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            owner_id: null,
            name: "和小鸣",
            avatar: null,
            description: "官方",
          },
          unreadCount: 0,
        },
      ],
    });
    for (const srv of [...mcpRegistry.servers()]) mcpRegistry.remove(srv.id);
    const server = mcpRegistry.add({
      id: "srv-notice2",
      name: "echo-svc",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
    });
    mcpRegistry.setTools(server.id, [{ name: "echo", description: "回声工具" }]);
    mcpRegistry.setToolEnabled(server.id, "echo", true);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});
    // 绑定要包在 act 里：不冲刷的话，提示仍按「无绑定 → 能力未知」算，负向断言会假阴
    await act(async () => {
      bindAssistant();
    });

    expect(screen.queryByText(/不支持工具调用/)).not.toBeInTheDocument();
    mcpRegistry.remove(server.id);
  });

  it("上传失败：提示上传失败原因，不发消息", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/files") return Promise.resolve(jsonRes({ error: "too large" }, 413));
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));

      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick(undefined, new File(["ab"], "a.txt", { type: "text/plain" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("上传失败：too large");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
  });

  it("上传悬停期间切会话：await 后丢弃不发送，提示「已切换会话，文件未发送」", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    // 上传响应由用例掌控：先悬停（模拟慢网络），期间切会话，再让 uploadFile 落定
    let resolveUpload!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveUpload = res;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/files") return pending;
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));

      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick(undefined, new File(["ab"], "a.txt", { type: "text/plain" }));
    act(() => {
      useUiStore.setState({ activeConversationId: "c2" }); // await 未返回前已切会话
    });

    await act(async () => {
      resolveUpload(
        jsonRes(
          {
            id: "f1",
            owner: "alice",
            name: "a.txt",
            mime: "text/plain",
            size: 2,
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
          201,
        ),
      );
      await new Promise((r) => setTimeout(r, 0)); // 冲刷 uploadFile → sendFile 收尾
    });

    // 旧闭包的 convId/handle 都过期：不得把附件发进 B 会话
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已切换会话，文件未发送");
  });

  it("消费 pendingAttachment：切到目标会话后经 WS 发送 file 消息", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />); // 挂在 c1（beforeEach 口径）
    await act(async () => {});

    // 槽指向 c2：本会话（c1）不发、槽保留
    const file = { id: "f-share", name: "共享.md", mime: "text/markdown", size: 3 };
    act(() => {
      useUiStore.setState({ pendingAttachment: { conversationId: "c2", file } });
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(useUiStore.getState().pendingAttachment).toEqual({ conversationId: "c2", file });

    // 切到目标会话 → 消费槽，封 e2e 信封发出（file 进密文，事件 conversationId=target）
    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    const plain = await lastSealed(send);
    expect(plain).toMatchObject({ kind: "file", file });
    // 规格 §2.4 文件边界：右栏 FileTree 的上传与投递保持明文——不带 key、不走附件加密
    expect((plain.file as { key?: string }).key).toBeUndefined();
    const ev = send.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(ev.conversationId).toBe("c2");
    expect(useUiStore.getState().pendingAttachment).toBeNull();
  });

  it("pendingAttachment 目标不是本会话时不发送", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    const file = { id: "f-other", name: "别会话.txt", mime: "text/plain", size: 1 };
    act(() => {
      useUiStore.setState({ pendingAttachment: { conversationId: "c-other", file } });
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(useUiStore.getState().pendingAttachment).toEqual({
      conversationId: "c-other",
      file,
    }); // 槽保留，等目标会话激活时再消费
  });

  // —— 二期 IM Task 4：消息转发 ——




  // —— 二期 IM Task 5：语音消息（录音 → 上传 → audio 气泡） ——

  /**
   * MediaRecorder + getUserMedia 桩（jsdom 均不实现）：实例表供 start/state 断言，
   * track.stop 句柄供「停录必停轨」断言；restore 摘掉 stubGlobal 与 navigator 覆盖
   * （navigator.mediaDevices 是文件级单例，不恢复会跨用例泄漏）。
   * defer：getUserMedia 挂起不 resolve，由 resolveMedia() 手动放行——覆盖「授权等待期」竞态。
   */
  function installFakeMedia(opts: { deny?: boolean; defer?: boolean } = {}) {
    const instances: FakeMediaRecorder[] = [];
    class FakeMediaRecorder {
      state: "inactive" | "recording" = "inactive";
      mimeType = "audio/webm";
      ondataavailable?: (e: { data: Blob }) => void;
      onstop?: () => void;
      constructor() {
        instances.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
        this.onstop?.(); // 浏览器里异步到事件循环；mock 同步触发收尾（onstop 内是幂等收口）
      }
    }
    const trackStop = vi.fn();
    let resolveMedia: (() => void) | null = null;
    const orig = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const getUserMedia = vi.fn((): Promise<{ getTracks: () => { stop: () => void }[] }> => {
      if (opts.deny) return Promise.reject(new Error("denied"));
      const stream = { getTracks: () => [{ stop: trackStop }] };
      if (opts.defer) return new Promise((res) => {
        resolveMedia = () => res(stream);
      });
      return Promise.resolve(stream);
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    return {
      instances,
      trackStop,
      getUserMedia,
      resolveMedia: () => resolveMedia?.(),
      restore() {
        vi.unstubAllGlobals();
        if (orig) Object.defineProperty(navigator, "mediaDevices", orig);
        else Reflect.deleteProperty(navigator, "mediaDevices");
      },
    };
  }

  it("语音按钮弹双选项浮层", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    expect(screen.queryByText("语音消息（录音）")).not.toBeInTheDocument(); // 未点开不出浮层
    fireEvent.click(screen.getByLabelText("语音输入"));
    expect(await screen.findByText("语音输入（转文字）")).toBeInTheDocument();
    expect(await screen.findByText("语音消息（录音）")).toBeInTheDocument();
  });

  it("无 MediaRecorder 时语音消息选项禁用并给提示，转文字入口不受影响", async () => {
    vi.stubGlobal("MediaRecorder", undefined); // 锁死「无该 API」环境（不依赖 jsdom 版本是否自带）
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("语音输入"));
    expect(screen.getByRole("button", { name: "语音消息（录音）" })).toBeDisabled();
    expect(screen.getByText("当前环境不支持录音")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "语音输入（转文字）" })).toBeEnabled();
  });

  it("录音流程：开始→停止→上传→发送 file 消息", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch({
      id: "f-a",
      owner: "alice",
      name: "语音.webm",
      mime: "audio/webm",
      size: 11,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
    const media = installFakeMedia();
    // 发送判定按 Date.now 差值（<1s 拒发）：用 now 桩把「录了 2 秒」钉成确定值
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {}); // getUserMedia → MediaRecorder.start 落定
      expect(screen.getByRole("status")).toHaveTextContent("录音中…（最长 60 秒）");
      expect(screen.getByLabelText("停止录音")).toBeInTheDocument();
      expect(screen.getByLabelText("取消录音")).toBeInTheDocument();
      expect(media.instances).toHaveLength(1);
      expect(media.instances[0].state).toBe("recording");

      now += 2000; // 录满 2 秒（越过 <1s 拒发线）
      fireEvent.click(screen.getByLabelText("停止录音"));
      // 上传链含 FileReader 宏任务（jsdom setImmediate 两跳）：单次 act 冲不干净，waitFor 到 send 落定
      const plain = await lastSealed(send);
      // payload 保留录音原名/原 mime（AudioBubble 按 audio/* 路由），key 随密文；
      // 服务端存的则是 .enc 名 + octet-stream 密文（见下方 body 断言）
      expect(plain).toEqual({
        kind: "file",
        text: "",
        file: {
          id: "f-a",
          name: expect.stringMatching(/^语音-\d{6}\.webm$/),
          mime: "audio/webm",
          size: 11, // fake 录音字节（"audio-bytes"）
          key: expect.any(String),
        },
      });
      expect(fromB64((plain.file as { key: string }).key)).toHaveLength(32);
      const post = fetchSpy.mock.calls.find(
        (c) => String(c[0]) === "/api/files" && c[1]?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body)) as {
        name: string;
        mime: string;
      };
      expect(body.mime).toBe("application/octet-stream"); // 语音同样密文上传，不落 audio/webm
      expect(body.name).toMatch(/^\.enc语音-\d{6}\.webm$/); // .enc 前缀 + 原文件名
      expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 录音态退出、无错误提示
      expect(media.trackStop).toHaveBeenCalledTimes(1); // 停录必停麦克风轨
    } finally {
      media.restore();
    }
  });

  it("录音 <1s 停止拒发：不上传不发送，提示录音太短", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();
    const media = installFakeMedia();
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {});
      fireEvent.click(screen.getByLabelText("停止录音")); // 开始后立即停：真实时差远小于 1s
      await act(async () => {});

      expect(screen.getByRole("alert")).toHaveTextContent("录音太短，未发送");
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
      expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false);
      expect(media.trackStop).toHaveBeenCalledTimes(1); // 拒发也停轨
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument();
    } finally {
      media.restore();
    }
  });

  it("取消录音：停录停轨、不上传不发送、静默退出录音态", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();
    const media = installFakeMedia();
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {});
      expect(screen.getByRole("status")).toHaveTextContent("录音中");

      fireEvent.click(screen.getByLabelText("取消录音"));
      await act(async () => {});

      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 取消是静默的（不弹提示行）
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
      expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false);
      expect(media.instances[0].state).toBe("inactive");
      expect(media.trackStop).toHaveBeenCalledTimes(1);
    } finally {
      media.restore();
    }
  });

  it("录音达 60 秒上限自动停止并按正常路径发送", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockUploadFetch({
      id: "f-b",
      owner: "alice",
      name: "语音.webm",
      mime: "audio/webm",
      size: 11,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
    const media = installFakeMedia();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {});
      expect(screen.getByRole("status")).toHaveTextContent("录音中");

      act(() => {
        now += 60_000;
        vi.advanceTimersByTime(60_000); // 60s 上限到点 → 自动 stop
      });
      // 上传链的 file.arrayBuffer() 走 jsdom FileReader 的两跳 setImmediate（被假时钟接管）：
      // 有界推进 10ms 冲刷这两跳 + 其后的微任务，否则 send 永远到不了（假 setImmediate 不会被 await act 冲掉）。
      // d.38 起 ChatPage 常驻 1s 的 typing 过期 interval，runAllTimersAsync 会把它当成永不收敛的
      // 循环（10000 次后中止）——故不用 runAllTimers，改用有界推进。
      // crypto.subtle 走 I/O 阶段（非微任务），假时钟下不自动完成 → 切回真时钟让 WebCrypto 落地
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      vi.useRealTimers();
      await act(async () => {});

      const ev = send.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((e) => e.type === "send_message");
      expect(ev).toBeDefined();
      expect(ev!.enc).toBe("e2e"); // 有界推进 + 切回真时钟后封发链已冲刷
      expect(decodePlain(ev!.cipher as string)).toMatchObject({
        kind: "file",
        file: {
          id: "f-b",
          name: expect.stringMatching(/^语音-\d{6}\.webm$/),
          mime: "audio/webm",
          size: 11,
          key: expect.any(String),
        },
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 录音态已退出
      expect(media.trackStop).toHaveBeenCalledTimes(1);
      expect(media.instances[0].state).toBe("inactive");
    } finally {
      media.restore();
      vi.useRealTimers();
    }
  });

  it("录音中切会话：中止录音（停轨、放弃发送）并退出录音态", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();
    const media = installFakeMedia();
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {});
      expect(screen.getByRole("status")).toHaveTextContent("录音中");

      act(() => {
        useUiStore.setState({ activeConversationId: "c2" });
      });
      expect(media.instances[0].state).toBe("inactive"); // 旧会话录音已停
      expect(media.trackStop).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument();
      // 「放弃发送不落提示」：按错误提示位断言（role=status 现在也被骨架/流式气泡使用）
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => {});
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
      expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false);
    } finally {
      media.restore();
    }
  });

  it("有 MediaRecorder 但麦克风不可用（getUserMedia 失败）：提示无法访问麦克风", async () => {
    const media = installFakeMedia({ deny: true });
    try {
      mockMessagesFetch([]);
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {});

      expect(screen.getByRole("alert")).toHaveTextContent("无法访问麦克风");
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument();
      expect(media.instances).toHaveLength(0); // 未创建 recorder，也无需停轨
    } finally {
      media.restore();
    }
  });

  it("授权挂起期间切会话：resolve 后不启动录音、tracks 被 stop、无上传（授权等待期竞态）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();
    const media = installFakeMedia({ defer: true }); // getUserMedia 挂起，等 resolveMedia 手动放行
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {}); // 停在 await getUserMedia（授权弹窗未决）
      expect(media.instances).toHaveLength(0); // 尚未创建 recorder
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument(); // 也未进录音态 UI

      act(() => {
        useUiStore.setState({ activeConversationId: "c2" }); // 授权等待期切会话
      });
      await act(async () => {
        media.resolveMedia(); // 此刻才授权 resolve
      });

      expect(media.instances).toHaveLength(0); // 已取消：不得创建 recorder、不得启动录音
      expect(media.trackStop).toHaveBeenCalledTimes(1); // 半途拿到的麦克风轨必须停
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument(); // 新会话不冒出录音态
      expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 静默放弃，不落提示
      await act(async () => {});
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
      expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false); // 未上传
    } finally {
      media.restore();
    }
  });

  it("授权挂起期间再次触发录音：第二次立即返回、不并行开两条、首个取消链仍完整", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();
    const media = installFakeMedia({ defer: true });
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {}); // 停在 await getUserMedia（授权弹窗挂起，录音态仍为 false）
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument(); // 危险窗口：浮层未禁用

      // 授权挂起期再开浮层点「录音」：第二次必须原地返回（连 getUserMedia 都不该调）
      fireEvent.click(screen.getByLabelText("语音输入"));
      fireEvent.click(screen.getByRole("button", { name: "语音消息（录音）" }));
      await act(async () => {});
      expect(media.getUserMedia).toHaveBeenCalledTimes(1); // 第二次被 pending 位挡在门外

      await act(async () => {
        media.resolveMedia(); // 首个授权放行
      });
      expect(media.instances).toHaveLength(1); // 仍是唯一 recorder（未并行开第二条）

      act(() => {
        useUiStore.setState({ activeConversationId: "c2" }); // 首实例 cancel 链必须仍完整
      });
      expect(media.instances[0].state).toBe("inactive");
      expect(media.trackStop).toHaveBeenCalledTimes(1); // 麦克风轨被停（无「录音中」泄漏）
      expect(screen.queryByText(/录音中/)).not.toBeInTheDocument();
      await act(async () => {});
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
      expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false);
    } finally {
      media.restore();
    }
  });

  it("有 MediaRecorder 但缺 mediaDevices.getUserMedia：录音选项照样禁用（特性检测双条件）", async () => {
    vi.stubGlobal("MediaRecorder", class {} as unknown as typeof MediaRecorder); // 有构造器
    const orig = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    try {
      mockMessagesFetch([]);
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      expect(screen.getByRole("button", { name: "语音消息（录音）" })).toBeDisabled();
      expect(screen.getByText("当前环境不支持录音")).toBeInTheDocument();
    } finally {
      if (orig) Object.defineProperty(navigator, "mediaDevices", orig);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      vi.unstubAllGlobals();
    }
  });


  it("音频消息气泡渲染 audio 元素：鉴权 blob src、不出文件卡、卸载 revoke", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: { text: "", file: { id: "f-a", name: "语音.webm", mime: "audio/webm", size: 11 } },
    };
    mockMessagesFetch([m]);

    const view = render(<ChatPage />);
    const audio = (await screen.findByTestId("audio-bubble")) as HTMLAudioElement;
    expect(audio.tagName).toBe("AUDIO");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("aria-label", "语音消息"); // 无障碍可访问名
    expect(audio).toHaveAttribute("src", "blob:mock-1"); // fetchFileBlobUrl 取到的鉴权 objectURL
    expect(screen.queryByRole("link", { name: /语音\.webm/ })).not.toBeInTheDocument(); // 非通用文件卡

    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1"); // 同附件的卸载即销
  });

  // —— 二期 IM Task 6：表情回应 UI ——




  // —— 二期 IM Task 7：重连补已读 · 群头像 · 定时清扫 ——



  it("定时清扫：15s 后过期他机流变 error 行（阈值内不动）", async () => {
    vi.useFakeTimers();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {}); // 挂载 effects 落定（含 I1 孤儿清扫，避免误清注入项）

    // 挂载后注入一条 lastAt=0（远古）的他机流，绕开挂载清扫
    act(() => {
      useChatStore.setState({
        streaming: {
          s1: {
            conversationId: "c1",
            agentId: "system-assistant",
            text: "半句",
            status: "streaming",
            lastAt: 0,
          },
        },
      });
    });
    expect(screen.getByText(/半句/)).toBeInTheDocument();
    expect(useChatStore.getState().streaming["s1"].status).toBe("streaming");

    act(() => {
      vi.advanceTimersByTime(15_000); // 清扫 interval 到点
    });

    expect(useChatStore.getState().streaming["s1"].status).toBe("error");
    expect(screen.getByText("长时间无响应，生成可能已中断")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("watchdog 门控：仅 error 残留（无 streaming 项）不挂 interval，出现 streaming 项才挂", async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(useChatStore.getState(), "sweepStaleStreams");
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    // 纯 error 残留（本机流 error 行保留、无任何 streaming 项）：门为假 → 不得挂表
    act(() => {
      useChatStore.setState({
        streaming: {
          err: {
            conversationId: "c1",
            agentId: "system-assistant",
            text: "半",
            status: "error",
            errorMessage: "旧原因",
            lastAt: 0,
          },
        },
      });
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(sweep).not.toHaveBeenCalled(); // 无 streaming 项 → 不起表（不空转、不重复误报）

    // 补一条 streaming 项 → 起表并到点清扫
    act(() => {
      useChatStore.setState({
        streaming: {
          err: {
            conversationId: "c1",
            agentId: "system-assistant",
            text: "半",
            status: "error",
            errorMessage: "旧原因",
            lastAt: 0,
          },
          live: {
            conversationId: "c1",
            agentId: "system-assistant",
            text: "在飞",
            status: "streaming",
            lastAt: Date.now(),
          },
        },
      });
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(sweep).toHaveBeenCalled();

    sweep.mockRestore();
    vi.useRealTimers();
  });

  it("他机流 watchdog 误报后收到 chunk 自愈：error 行消失、文本续上", async () => {
    await setupAgentChat();
    // 注入被他机 watchdog 误判为中断的流（error 状态 + 文案）
    act(() => {
      useChatStore.setState({
        streaming: {
          "remote-1": {
            conversationId: "c1",
            agentId: "system-assistant",
            text: "半",
            status: "error",
            errorMessage: "长时间无响应，生成可能已中断",
            lastAt: 0,
          },
        },
      });
    });
    expect(screen.getByText("长时间无响应，生成可能已中断")).toBeInTheDocument();

    // 下个 chunk 到达 → 回到 streaming 并清 errorMessage（自愈）
    act(() => {
      lastHandlers().onEvent({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId: "remote-1",
        text: "续",
      });
    });
    expect(useChatStore.getState().streaming["remote-1"].status).toBe("streaming");
    expect(useChatStore.getState().streaming["remote-1"].errorMessage).toBeUndefined();
    expect(screen.queryByText("长时间无响应，生成可能已中断")).not.toBeInTheDocument();
    expect(screen.getByText(/半续/)).toBeInTheDocument();
  });

  // —— 智能体记忆 + 技能池接线（Task 5）：只验证接线本身，不重复记忆/技能内部逻辑 ——


  it("记忆/技能异常静默降级：系统提示词仍是原提示词，发送与流式渲染不受影响", async () => {
    const send = await setupAgentChat();
    bindAssistant();
    // 记忆读设置即抛错（模拟 localStorage 损坏/隐私模式）：注入与写入都必须被吞掉
    vi.spyOn(memoryStore, "getSettings").mockImplementation(() => {
      throw new Error("storage boom");
    });

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages, o) => {
      seen = messages;
      o.onDelta("你");
      o.onDelta("好");
      return "你好";
    });

    await pickAndSend("@和小鸣 打个招呼");
    // E2E 合入后发送与三事件上行都要先封信封（异步 sealAndSend → sealMessage），
    // 故先冲刷一次微任务队列再断言（本文件既有风格）
    await act(async () => {});

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" })); // 消息照发
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen![0]).toEqual({ role: "system", content: "你是和小鸣" }); // 组装失败 → 原提示词（零注入）
    // finish 同走信封（帧上 text 置空），故按信封内明文断言「回复全文已上行」
    await waitFor(() => expect(sealedOf(send, "agent_finish")).toHaveLength(1));
    expect(sealedOf(send, "agent_finish")[0].plain).toMatchObject({ kind: "text", text: "你好" });
    await waitFor(() => expect(screen.getByText(/你好/)).toBeInTheDocument()); // 打字机正常
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent_error" })); // 写入异常不上行
  });

  // —— 上下文预算接线（Task B）：只验证接线本身，不重复 agentContext 内部逻辑 ——

  /** 本机上下文设置（@ 触发链路读 `heming.context.v1`）：缺省关 LLM 摘要 → 零额外请求的确定性摘要。 */
  function setContextSettings(patch: Partial<ContextSettings>) {
    localStorage.setItem(
      CONTEXT_KEYS.settings,
      JSON.stringify({
        enabled: true,
        budgetTokens: 6000,
        keepRecentTurns: 8,
        llmSummary: false,
        ...patch,
      }),
    );
    localStorage.removeItem(CONTEXT_KEYS.summaries);
  }

  /** 长历史群会话底座（count 条「历史N」+ 已绑定「和小鸣」），返回 ws send。 */
  async function setupLongHistoryChat(count = 6) {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        const history = Array.from({ length: count }, (_, i) =>
      msg(`m${i + 1}`, `历史${i + 1}`, `2026-10-14T01:00:${String(i).padStart(2, "0")}.000Z`),
    );
    mockMessagesFetch(history);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();
    return send;
  }

  /** 某类上行事件（断言「只发一次」「完全没有」）。 */
  const framesOf = (send: ReturnType<typeof vi.fn>, type: string) =>
    send.mock.calls.map((c) => c[0]).filter((e) => e.type === type);

  it("上下文预算开启：历史按预算切分，早期对话以摘要 system 段前置（确定性摘要 = 零额外请求）", async () => {
    await setupLongHistoryChat(6);
    setContextSettings({ keepRecentTurns: 2 }); // 只保留近 2 轮：历史1..4 进 older

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 查下上下文");
    await waitFor(() => expect(seen).toBeDefined());

    expect(streamChat).toHaveBeenCalledTimes(1); // 确定性摘要不发额外请求
    expect(seen).toHaveLength(5); // 系统提示词 + 摘要 system 段 + 近 2 轮 + 本条 user 轮
    expect(seen![0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(seen![1].role).toBe("system");
    expect(seen![1].content).toContain("【早期对话摘要】");
    expect(seen![1].content).toContain("意图：历史1；历史2；历史3");
    expect(seen![2]).toEqual({ role: "user", content: "历史5" });
    expect(seen![3]).toEqual({ role: "user", content: "历史6" });
    expect(seen![4]).toEqual({ role: "user", content: "@和小鸣 查下上下文" });
    expect(seen!.map((r) => r.content)).not.toContain("历史4"); // 早期原文不直发
  });

  it("LLM 摘要：用该 agent 绑定的 profile 调 streamChat（提示词为摘要骨架），结果作背景段且不上行", async () => {
    const send = await setupLongHistoryChat(6);
    setContextSettings({ keepRecentTurns: 2, llmSummary: true });

    const calls: { profile: LlmProfile; messages: Parameters<typeof streamChat>[1] }[] = [];
    vi.mocked(streamChat).mockImplementation(async (profile, messages, o) => {
      calls.push({ profile, messages });
      if (messages[0].content.includes("压缩成背景摘要")) {
        // 摘要请求（非 event-stream 分支整段返回）：只输出三段骨架
        return "【早期对话摘要】\n意图：模型摘要意图\n结论：模型摘要结论\n待办：（未提及）";
      }
      o.onDelta("好");
      return "好";
    });

    await pickAndSend("@和小鸣 查下上下文");
    await waitFor(() => expect(calls).toHaveLength(2)); // 先摘要、再主请求

    expect(calls[0].profile).toEqual(testProfile); // 摘要走该 agent 绑定的连接（Key 不出设备）
    expect(calls[0].messages[0].content).toContain("压缩成背景摘要");
    expect(calls[0].messages[1].content).toContain("用户：历史1");

    const main = calls[1].messages;
    expect(main[0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(main[1].role).toBe("system");
    expect(main[1].content).toContain("【早期对话摘要】");
    expect(main[1].content).toContain("意图：模型摘要意图");

    // 摘要不落 WS：chunk / finish 各一次（都是主请求的），也没有错误上行
    await waitFor(() => expect(framesOf(send, "agent_finish")).toHaveLength(1));
    expect(framesOf(send, "agent_chunk")).toHaveLength(1);
    expect(framesOf(send, "agent_error")).toHaveLength(0);
  });

  it("溢出重试接线：首次 400 上下文超限 → 用收紧后的设置重装历史，重试成功只 finish 一次", async () => {
    const send = await setupLongHistoryChat(12);
    setContextSettings({ keepRecentTurns: 8 });

    const seen: Parameters<typeof streamChat>[1][] = [];
    vi.mocked(streamChat).mockImplementation(async (_profile, messages, o) => {
      seen.push(messages);
      if (seen.length === 1) {
        o.onDelta("半"); // 首次尝试的部分文本（已上行）
        throw new Error("provider_error: HTTP 400 maximum context length exceeded");
      }
      o.onDelta("好");
      return "好";
    });

    await pickAndSend("@和小鸣 查下上下文");

    await waitFor(() => expect(framesOf(send, "agent_finish")).toHaveLength(1));
    expect(seen).toHaveLength(2);
    // 首次：保留 8 轮（摘要段 + 近 8 轮 + 系统提示词 + 本条 user 轮）
    expect(seen[0]).toHaveLength(11);
    // 重试：aggressive=1 收紧（预算减半、保留轮数 8→4），系统提示词重新前置
    expect(seen[1]).toHaveLength(7);
    expect(seen[1][0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(seen[1][1].role).toBe("system");
    expect(seen[1].at(-1)).toEqual({ role: "user", content: "@和小鸣 查下上下文" });
    // 重试期间不重复上行 chunk；finish 只发一次且是重试成功的全文（无首次尝试的「半」）。
    // E2E 合入后 chunk/finish 帧是信封（帧上 text 置空、正文进 cipher），故帧数查形状、
    // 正文按「被封的明文」断言意图（sealMessage 桩的入参即明文）。
    const sealedTexts = (kind: string) =>
      vi
        .mocked(sealMessage)
        .mock.calls.map((c) => c[1] as { kind?: string; text?: string })
        .filter((p) => p.kind === kind)
        .map((p) => p.text);
    // 工具轮下首次尝试的文字**不上行**（它是「我这就去查」这类中间话术的候选，
    // 失败了也未必是答案）。重试成功后 finish 全文是干净的「好」，
    // 用户不会先看到半截话再被覆盖——这比无工具路径更干净。
    expect(framesOf(send, "agent_chunk")).toHaveLength(0);
    expect(sealedTexts("chunk")).toEqual([]);
    expect(framesOf(send, "agent_finish")).toHaveLength(1); // finish 只发一次
    expect(sealedTexts("text")).toEqual(["@和小鸣 查下上下文", "好"]); // 本条 user 轮 + 重试成功全文
    expect(framesOf(send, "agent_error")).toHaveLength(0);
  });

  // —— E2E Task 4：无 subtle 拦截 / 公钥上云 / 无法解密占位 ——

  it("无 subtle：输入区常驻横幅 + 文本/附件发送拦截（不发不降级，草稿保留）", async () => {
    vi.mocked(hasSubtle).mockReturnValue(false);
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    // 常驻横幅（硬验收⑤ / 设计 §2.1）
    expect(screen.getByRole("alert")).toHaveTextContent(
      "当前环境无法加密消息，请在桌面端打开，或使用以 https 开头的网址访问",
    );

    // 文本发送拦截：不发帧、草稿保留；不再叠第二条同文案提示（横幅已是 role=alert）
    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "偷偷发" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(input).toHaveValue("偷偷发");

    // 附件发送拦截：上传前即拦（不 POST /api/files、不发帧）
    captureFilePicker().pick(undefined, new File(["ab"], "a.txt", { type: "text/plain" }));
    await act(async () => {});
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files" && c[1]?.method === "POST"),
    ).toBe(false);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
  });

  it("挂载即上云身份公钥 PUT /api/e2e/keys（硬验收①：对端 fetchPeerKeys 依赖）", async () => {
    const fetchSpy = mockMessagesFetch([]);
    render(<ChatPage />);
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === "/api/e2e/keys" && (c[1] as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(true),
    );
    // 公钥体 = exportOwnDeviceKeys 形状（双公钥 + 签名预键）
    const put = fetchSpy.mock.calls.find(
      (c) => String(c[0]) === "/api/e2e/keys" && (c[1] as RequestInit | undefined)?.method === "PUT",
    )!;
    const body = JSON.parse(String((put[1] as RequestInit).body)) as Record<string, unknown>;
    expect(typeof body.ikEcdh).toBe("string");
    expect(typeof body.ikSign).toBe("string");
    expect(body.spk).toMatchObject({ pub: expect.any(String), sig: expect.any(String) });
    expect(typeof (body.spk as { createdAt: unknown }).createdAt).toBe("number"); // epoch ms 约定
  });

  it("解不开的 e2e 信封渲染「本机解不开」占位并写全可能原因（不吞不崩，pending 等 chaindist）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    // 无 chaindist 的孤儿信封：真 handler → 缺链 defer → 占位（渲染面断言）
    const sealed: Message = {
      ...msg("e-orphan", "", "2026-10-14T01:00:00.000Z"),
      senderId: "u2",
      enc: "e2e",
      cipher: btoa(JSON.stringify({ v: 1, nonce: "AA==", data: "BB==" })),
      chainKid: "no-such-chain",
      n: 0,
    };
    mockMessagesFetch([sealed]);

    render(<ChatPage />);
    await waitFor(() =>
      expect(screen.getByText(/本机解不开这条消息/)).toBeInTheDocument(),
    );
    // 原因要写全（换设备 / 本机清过缓存 / 生成被中断），不能只留一句「无法解密」
    expect(screen.getByText(/本机缓存被清理/)).toBeInTheDocument();
    expect(screen.getByText(/本机解不开这条消息/).closest("div")?.getAttribute("title")).toMatch(
      /本机缓存被清理过/,
    );
    // 挂起等待 chaindist（硬验收③场景的前半段；重试补齐由 chat store 测试覆盖）
    expect(useChatStore.getState().pendingE2e.c1).toEqual(["e-orphan"]);
  });

  it("fetchHistory：解不开的 e2e 信封不进 LLM 提示词（硬验收⑤），明文照常入 prompt", async () => {
    const send = await setupAgentChat();
    bindAssistant();
    const undecryptable: Message = {
      ...msg("e-x", "", "2026-10-14T01:00:00.000Z"),
      senderId: "u2",
      enc: "e2e",
      cipher: btoa(JSON.stringify({ v: 1, nonce: "AA==", data: "BB==" })),
      chainKid: "no-such-chain",
      n: 0,
    };
    mockMessagesFetch([
      msg("m1", "明文历史", "2026-10-14T00:59:00.000Z"),
      undecryptable, // 缺链信封 → handler defer → 占位（payload 恒空）
    ]);

    await pickAndSend("@和小鸣 看历史");
    await waitFor(() => expect(vi.mocked(streamChat)).toHaveBeenCalled());
    const rows = vi.mocked(streamChat).mock.calls.at(-1)![1];
    const contents = rows.map((r) => r.content);
    expect(contents).toContain("明文历史");
    expect(contents).toContain("@和小鸣 看历史");
    expect(contents).not.toContain(""); // 占位行（空 content）被过滤，不外发模型供应商
    // 本地渲染面同步出占位（提示词与 UI 两面口径一致）
    expect(screen.getByText(/本机解不开这条消息/)).toBeInTheDocument();
  });

  it("挂载后台自迁移：本会话自己 plain 消息 PUT reencrypt，成功后换 e2e 形态且明文仍可渲染", async () => {
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    const mine: Message = {
      ...msg("mig-w", "旧明文待重封", "2026-10-14T01:00:00.000Z"),
      senderId: "u1",
    };
    const fetchSpy = mockMessagesFetch([mine]);

    render(<ChatPage />);
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes("/api/messages/mig-w/reencrypt")),
      ).toBe(true),
    );
    // 本地替换为 e2e 形态 + 明文回填（plainById/缓存，见 store migrate 实现）
    await waitFor(() =>
      expect(useChatStore.getState().messages.c1?.find((m) => m.id === "mig-w")?.enc).toBe("e2e"),
    );
    expect(screen.getByText("旧明文待重封")).toBeInTheDocument(); // 不退化成占位
    expect(useChatStore.getState().plainById.c1?.["mig-w"]).toMatchObject({ text: "旧明文待重封" });
  });

  it("fix I2：密文 agent_error 回声解不开 → 降级通用文案 + code 保留（原文不显示）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    act(() => {
      lastHandlers().onEvent({
        type: "agent_error",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId: "s-err",
        code: "provider_error",
        message: "",
        cipher: btoa(unescape(encodeURIComponent(JSON.stringify({ kind: "error", text: "供应商把请求片段吐出来了" })))),
        chainKid: "test-kid",
        n: 0,
      });
    });
    // 桩 cipher 非真信封：真 openMessage 走缺链 defer → handler 非 ok → 通用降级文案
    await waitFor(() =>
      expect(screen.getByText("生成出错（内容无法解密）")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/供应商把请求片段吐出来了/)).not.toBeInTheDocument();
    expect(useChatStore.getState().streaming["s-err"]).toMatchObject({
      status: "error",
      errorMessage: "生成出错（内容无法解密）",
    });
  });

  it("硬验收②：他设备的定向 chaindist 经 isForMe 过滤——不入列不占位不报错", async () => {
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    // 外层带 ek/to 的定向信封（to 指向他人身份指纹）：isForMe → skip
    const foreign = btoa(
      JSON.stringify({ v: 1, ek: "BBB", ik: "CCC", to: "someone-else-kid", nonce: "AAA", data: "DDD" }),
    );
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: {
          ...msg("dist-x", "", "2026-10-14T01:00:00.000Z"),
          senderId: "u2",
          enc: "e2e",
          cipher: foreign,
          chainKid: "someone-else-kid",
          n: 0,
        },
      });
    });
    await act(async () => {});
    expect(useChatStore.getState().messages.c1 ?? []).toHaveLength(0); // 不入列
    expect(useChatStore.getState().pendingE2e.c1 ?? []).toHaveLength(0); // 不挂起
    expect(screen.queryByText(/本机解不开这条消息/)).not.toBeInTheDocument(); // 不占位
  });

  it("硬验收③：同一信封 echo 重放——(chainKid,n) 去重经出站箱/缓存补齐，不重复入列", async () => {
    bindAssistant();
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: "只出一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const plain = await lastSealed(send);
    expect(plain).toMatchObject({ kind: "text", text: "只出一条" });
    // 取最后一条 send_message（绑定后有 chunk/finish 回声，末次调用不一定是正文）
    const ev = send.mock.calls
      .map((c) => c[0] as { type?: string; cipher: string; chainKid: string; n: number })
      .filter((e) => e.type === "send_message")
      .at(-1)!;
    const echo = {
      type: "message_new" as const,
      message: {
        ...msg("m-replay", "", "2026-10-14T01:10:00.000Z"),
        senderId: "u1",
        enc: "e2e" as const,
        cipher: ev.cipher,
        chainKid: ev.chainKid,
        n: ev.n,
      },
    };
    act(() => {
      lastHandlers().onEvent(echo);
    });
    await waitFor(() => expect(screen.getByText("只出一条")).toBeInTheDocument());
    act(() => {
      lastHandlers().onEvent(echo); // 服务端重放同一条信封
    });
    await act(async () => {});
    expect(screen.queryAllByText("只出一条")).toHaveLength(1); // 仍只一条气泡
    expect(useChatStore.getState().messages.c1).toHaveLength(1);
  });

  it("自己发送的 e2e 消息：echo 走出站箱自解渲染并落明文缓存（自发消息无 recv 链）", async () => {
    bindAssistant();
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: "自发密文" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const plain = await lastSealed(send);
    expect(plain).toMatchObject({ kind: "text", text: "自发密文" });
    // 取最后一条 send_message（绑定后有 chunk/finish 回声，末次调用不一定是正文）
    const ev = send.mock.calls
      .map((c) => c[0] as { type?: string; cipher: string; chainKid: string; n: number })
      .filter((e) => e.type === "send_message")
      .at(-1)!;

    // 服务端回声（信封形态）：自己没有 recv 链 → openMessage 必 defer，须由出站箱接住
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: {
          ...msg("m-mine", "", "2026-10-14T01:10:00.000Z"),
          senderId: "u1",
          enc: "e2e",
          cipher: ev.cipher,
          chainKid: ev.chainKid,
          n: ev.n,
        },
      });
    });
    await waitFor(() => expect(screen.getByText("自发密文")).toBeInTheDocument());
    expect(screen.queryByText(/本机解不开这条消息/)).not.toBeInTheDocument();
    expect(useChatStore.getState().plainById.c1!["m-mine"]).toMatchObject({ text: "自发密文" });
    // §6 明文缓存落盘：重载后无出站箱也能靠缓存优先自解
    const cached = JSON.parse(localStorage.getItem("heming.msgCache.c1") ?? "[]") as {
      plain: { text?: string };
    }[];
    expect(cached.some((c) => c.plain.text === "自发密文")).toBe(true);
  });

  // —— d.35.1.9.0 UX 修补 · A 路（聊天主界面）行为用例 ——

  it("A1 历史三态：加载中出骨架；失败给「加载失败+重试」；重试成功渲染消息", async () => {
    let attempt = 0;
    let releaseRetry: ((r: Response) => void) | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (/^\/api\/conversations\/[^/]+\/messages$/.test(url)) {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("网络中断"));
        if (attempt === 2) return new Promise<Response>((r) => (releaseRetry = r));
        return Promise.resolve(jsonRes([msg("m1", "重试后回来", "2026-10-14T01:00:00.000Z")]));
      }
      if (/\/(reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    // 首屏：历史没回来时是骨架，不是「还没有消息」
    expect(screen.getByTestId("messages-skeleton")).toBeInTheDocument();
    expect(await screen.findByText(/加载失败：网络中断/)).toBeInTheDocument();
    expect(screen.queryByText("还没有消息")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByTestId("messages-skeleton")).toBeInTheDocument(); // 重试期间回到加载态
    expect(releaseRetry).not.toBeNull();
    act(() => releaseRetry!(jsonRes([msg("m1", "重试后回来", "2026-10-14T01:00:00.000Z")])));
    expect(await screen.findByText("重试后回来")).toBeInTheDocument();
    expect(screen.queryByTestId("messages-skeleton")).not.toBeInTheDocument();
  });

  it("A1 真空态：只有「加载成功且为空」才显示「还没有消息」", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    expect(screen.getByTestId("messages-skeleton")).toBeInTheDocument();
    expect(await screen.findByText("还没有消息")).toBeInTheDocument();
    expect(screen.queryByTestId("messages-skeleton")).not.toBeInTheDocument();
  });

  it("A3 贴底跟随、上滑不拽底：浮动「↓ 新消息」点回底部", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    const list = screen.getByTestId("message-list");
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    list.scrollTop = 1000; // 贴底
    fireEvent.scroll(list);

    // 贴底（默认）时新消息继续跟随：只改消息容器的 scrollTop，不调用 scrollIntoView
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: msg("m8", "贴底新消息", "2026-10-14T01:00:00.000Z"),
      });
    });
    expect(await screen.findByText("贴底新消息")).toBeInTheDocument();
    expect(list.scrollTop).toBe(1000);
    // 关键回归：贴底跟随只改消息容器的 scrollTop，绝不调用 scrollIntoView——
    // 后者会连带滚动 App 里 overflow-hidden 的包裹层，把整页往上顶（「页面异常抬高」）。
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    // 用户上滑：距底 500px（>80）→ 不再贴在底部
    list.scrollTop = 100;
    fireEvent.scroll(list);

    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: msg("m9", "离底新消息", "2026-10-14T02:00:00.000Z"),
      });
    });
    expect(await screen.findByText("离底新消息")).toBeInTheDocument();
    expect(list.scrollTop).toBe(100); // 不强行拽底
    const jump = screen.getByRole("button", { name: "滚动到最新消息" });

    fireEvent.click(jump);
    expect(list.scrollTop).toBe(1000); // 点浮动按钮才回到底部
    expect(screen.queryByRole("button", { name: "滚动到最新消息" })).not.toBeInTheDocument();
  });



  it("d.83 刷新/切回会话恢复上次阅读位置；写盘只记位置不记内容", async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      msg(`s${i}`, `行 ${i}`, `2026-10-14T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`),
    );
    mockMessagesFetch(many);
    // 上次停在中段（不是贴底）
    writeChatScroll("c1", { top: 420, atBottom: false, windowCount: 60 });

    render(<ChatPage />);
    const list = screen.getByTestId("message-list");
    Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });

    await waitFor(() => expect(screen.getByText("行 119")).toBeInTheDocument());
    await waitFor(() => expect(list.scrollTop).toBe(420));

    // 滚动会把新位置写回；存的东西只有位置，没有消息正文
    fireEvent.scroll(list);
    await waitFor(() => {
      const saved = readChatScroll("c1");
      expect(saved).toMatchObject({ atBottom: false });
      expect(saved!.top).toBe(420);
    });
    expect(sessionStorage.getItem("heming.chatScroll.v1:c1")).not.toMatch(/行 119/);
  });

  it("d.83 上次贴着最新消息：切回来仍然从最新看起（不回放旧像素位置）", async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      msg(`b${i}`, `第 ${i} 条`, `2026-10-14T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`),
    );
    mockMessagesFetch(many);
    writeChatScroll("c1", { top: 900, atBottom: true, windowCount: 60 });
    render(<ChatPage />);
    await act(async () => {});
    await waitFor(() => expect(screen.getByText("第 119 条")).toBeInTheDocument());
    // 贴底状态：不恢复旧像素位置（既不设 900，也不该把「↓ 新消息」浮出来）
    expect(screen.queryByRole("button", { name: "滚动到最新消息" })).toBeNull();
    expect(readChatScroll("c1")?.atBottom).toBe(true);
  });

  // —— d.37 连续性对抗用例（adversarial QA 2026-10-28）——










  it("A4 气泡时间戳：每条带 HH:mm；间隔 ≥5 分钟插分隔、连续消息不插", async () => {
    const m1 = msg("m1", "第一条", "2026-10-14T01:00:00.000Z");
    const m2 = msg("m2", "第二条", "2026-10-14T01:02:00.000Z");
    const m3 = msg("m3", "第三条", "2026-10-14T02:00:00.000Z");
    mockMessagesFetch([m1, m2, m3]);

    render(<ChatPage />);
    await screen.findByText("第三条");
    // 气泡内时间（HH:mm / 跨天 MM-DD HH:mm 的口径由 formatClock 决定）
    expect(screen.getAllByText(formatClock(m1.createdAt)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(formatClock(m3.createdAt)).length).toBeGreaterThan(0);
    // 首条插分隔；m2 距 m1 2 分钟不插；m3 距 m2 58 分钟再插
    expect(screen.getByText(formatDayClock(m1.createdAt))).toBeInTheDocument();
    expect(screen.queryByText(formatDayClock(m2.createdAt))).not.toBeInTheDocument();
    expect(screen.getByText(formatDayClock(m3.createdAt))).toBeInTheDocument();
  });

  it("A5 复制整条消息：写剪贴板并短暂显示「已复制」", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockMessagesFetch([msg("m1", "要复制的内容", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    await screen.findByText("要复制的内容");
    fireEvent.click(screen.getByLabelText("复制消息"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("要复制的内容"));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("A6 图片附件点击放大：lightbox 显示原图，Esc 关闭", async () => {
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f9", name: "a.png", mime: "image/png", size: 1024 },
      },
    };
    mockMessagesFetch([m]);

    render(<ChatPage />);
    await screen.findByRole("img", { name: "a.png" });
    fireEvent.click(screen.getByRole("button", { name: "查看图片 a.png" }));

    const dialog = screen.getByRole("dialog", { name: "查看图片" });
    const big = within(dialog).getByTestId("image-lightbox") as HTMLImageElement;
    expect(big).toHaveAttribute("src", "blob:mock-1");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "查看图片" })).not.toBeInTheDocument(),
    );
  });

  it("A7 粘贴截图：走 sendFile 同一套上传与 file 消息发送", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch({
      id: "f-paste",
      owner: "alice",
      name: "shot.png",
      mime: "image/png",
      size: 3,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });

    render(<ChatPage />);
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.paste(input, {
      clipboardData: { files: [new File(["img"], "shot.png", { type: "image/png" })] },
    });

    const plain = await lastSealed(send);
    expect(plain).toMatchObject({
      kind: "file",
      file: { id: "f-paste", name: "shot.png", mime: "image/png" },
    });
    expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(true);
  });

  it("A7 拖拽文件到消息区：即上传并发送", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockUploadFetch({
      id: "f-drop",
      owner: "alice",
      name: "拖入.txt",
      mime: "text/plain",
      size: 2,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });

    render(<ChatPage />);
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.keyDown(input, { key: "Escape" }); // 焦点无关，仅确保页面稳定
    fireEvent.drop(screen.getByTestId("message-list"), {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["ab"], "拖入.txt", { type: "text/plain" })],
      },
    });

    const plain = await lastSealed(send);
    expect(plain).toMatchObject({ kind: "file", file: { id: "f-drop", name: "拖入.txt" } });
  });

  it("A8 上传中：图片/文件/语音/发送禁用并提示「上传中…（≤6MB）」，完成后恢复", async () => {
    let releaseUpload: ((r: Response) => void) | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/files") return new Promise<Response>((r) => (releaseUpload = r));
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (url === "/api/e2e/keys") return Promise.resolve(jsonRes({}));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    bindAssistant();
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText("输入消息…"), {
      target: { value: "一起传" },
    });
    captureFilePicker().pick("image/*", new File(["img"], "cat.png", { type: "image/png" }));

    expect(await screen.findByText("上传中…（≤6MB）")).toBeInTheDocument();
    expect(screen.getByLabelText("图片")).toBeDisabled();
    expect(screen.getByLabelText("文件")).toBeDisabled();
    expect(screen.getByLabelText("语音输入")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("图片").getAttribute("title")).toContain("6MB");
    await waitFor(() => expect(releaseUpload).not.toBeNull()); // 等加密/上传真正发起

    act(() =>
      releaseUpload!(
        jsonRes(
          {
            id: "f1",
            owner: "alice",
            name: "cat.png",
            mime: "image/png",
            size: 3,
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
          201,
        ),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("上传中…（≤6MB）")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("图片")).not.toBeDisabled();
  });

  it("A9 文本发送失败：红色 alert + 「重试」；重试成功后清空草稿", async () => {
    bindAssistant();
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    vi.mocked(sealMessage).mockRejectedValueOnce(new Error("封条失败"));

    render(<ChatPage />);
    await act(async () => {});
    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "发不出去的话" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("消息发送失败");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));

    const plain = await lastSealed(send);
    expect(plain).toMatchObject({ kind: "text", text: "发不出去的话" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("A9 info 提示 3 秒自动消失", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "导出会话" }));
    fireEvent.click(screen.getByText("导出 Markdown"));
    expect(screen.getByRole("status")).toHaveTextContent("没有可导出的明文消息");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("A10 空草稿发送禁用；无浮层无草稿时 Esc 停止生成", async () => {
    const send = await setupAgentChat();
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(
      (_p, _m, o) =>
        new Promise<string>((_res, rej) => {
          o.onDelta("半");
          o.signal.addEventListener("abort", () =>
            rej(new DOMException("AbortError", "AbortError")),
          );
        }),
    );

    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled(); // 空草稿

    await pickAndSend("@和小鸣 写段文字");
    await waitFor(() => expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" }); // 无浮层、草稿已清空
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_error", code: "aborted" }),
      ),
    );
  });

  // —— d.126-C：对话去头像 + 思考/工具调用转录（历史可展开） ——

  it("d.126-C 消息区不再渲染头像（智能体/用户都不出图片或首字圆底）", async () => {
    // 两端都配了头像：万一还渲染 Avatar，就会在 DOM 里出现图片
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            name: "和小鸣",
            avatar: "data:image/png;base64,AGENTAVATAR",
            owner_id: null,
            description: "",
          },
          unreadCount: 0,
        },
      ],
    });
    useAuthStore.setState({ user: { ...me, avatar: "data:image/png;base64,MEAVATAR" } });
    mockMessagesFetch([
      { ...msg("u-1", "用户的话", "2026-10-14T01:00:00.000Z"), senderId: "u1" },
      agentMsg("a-1", "助手的话", "2026-10-14T01:01:00.000Z"),
    ]);

    const { container } = render(<ChatPage />);
    expect(await screen.findByText("助手的话")).toBeInTheDocument();
    expect(screen.getByText("用户的话")).toBeInTheDocument();
    // 无头像：整棵消息树里没有任何图片（历史消息没有附件）
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector('img[src*="AGENTAVATAR"]')).toBeNull();
    expect(container.querySelector('img[src*="MEAVATAR"]')).toBeNull();
  });

  it("d.126-C 历史消息：思考块/工具块默认折叠成一行摘要，点击展开（会话结束后仍可见）", async () => {
    // 模拟「上一次会话收口时已落盘」的转录：历史拉取时按消息 id 贴回
    useChatStore.getState().recordTranscript("c1", "a-1", {
      thinking: "先在资料里查一下发布计划",
      tools: [
        {
          id: "t1",
          name: "wiki_search",
          args: '{"q":"发布计划"}',
          status: "ok",
          result: "找到 3 条相关页",
          startedAt: 1000,
          endedAt: 1120,
        },
      ],
    });
    mockMessagesFetch([
      { ...msg("u-1", "帮我查发布计划", "2026-10-14T01:00:00.000Z"), senderId: "u1" },
      agentMsg("a-1", "查到了，共三条", "2026-10-14T01:01:00.000Z"),
    ]);

    render(<ChatPage />);
    expect(await screen.findByText("查到了，共三条")).toBeInTheDocument();

    // 思考块：默认折叠（正文不在 DOM），一行摘要可展开
    const thinking = screen.getByRole("button", { name: "思考过程" });
    expect(thinking).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先在资料里查一下发布计划")).not.toBeInTheDocument();
    fireEvent.click(thinking);
    expect(screen.getByText("先在资料里查一下发布计划")).toBeInTheDocument();

    // 工具块：默认折叠成「工具调用 · 1 次 / 1 完成」，展开看工具名与结果
    const tools = screen.getByRole("button", { name: "工具调用" });
    expect(tools).toHaveAttribute("aria-expanded", "false");
    expect(tools.textContent).toContain("工具调用 · 1 次");
    expect(tools.textContent).toContain("1 完成");
    expect(screen.queryByText("wiki_search")).not.toBeInTheDocument();
    fireEvent.click(tools);
    expect(screen.getByText("wiki_search")).toBeInTheDocument();
    expect(screen.getByText(/找到 3 条相关页/)).toBeInTheDocument();
    // 落盘仍在：切走再回来还能展开
    expect(localStorage.getItem("heming.transcript.c1")).toContain("先在资料里查一下发布计划");
  });

  it("d.126-C 流式结束后：思考写入该条消息（折叠可展开）并落盘，流气泡收口", async () => {
    const send = await setupAgentChat();
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onReasoning?.("先想一下怎么答");
      o.onDelta("答案");
      return "答案";
    });

    await pickAndSend("@和小鸣 答一下");
    const finish = await waitFor(() => {
      const f = framesOf(send, "agent_finish")[0];
      expect(f?.streamId).toBeTruthy();
      return f as { streamId: string };
    });

    // 服务端入库后的 message_new（带 streamId）：ChatPage 在移除流项前快照转录
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        streamId: finish.streamId,
        message: agentMsg("a-new", "答案", "2026-10-14T01:05:00.000Z"),
      });
    });
    await waitFor(() => expect(screen.getAllByText("答案").length).toBeGreaterThan(0));
    expect(screen.queryByText("生成中…")).not.toBeInTheDocument(); // 流气泡已收口

    // 转录写进消息：默认折叠，展开可见；且已落盘（刷新后拉历史仍能贴回）
    const thinking = screen.getByRole("button", { name: "思考过程" });
    expect(thinking).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先想一下怎么答")).not.toBeInTheDocument();
    fireEvent.click(thinking);
    expect(screen.getByText("先想一下怎么答")).toBeInTheDocument();
    expect(localStorage.getItem("heming.transcript.c1")).toContain("先想一下怎么答");
    // 消息对象本身带上字段（store 侧口供：渲染层读的就是它）
    const stored = useChatStore.getState().messages.c1.find((m) => m.id === "a-new");
    expect((stored as { thinking?: string } | undefined)?.thinking).toBe("先想一下怎么答");
  });

  it("d.126-C 旧消息没有思考/工具字段：正常渲染、不显示折叠块（向后兼容）", async () => {
    mockMessagesFetch([msg("m1", "旧消息，没有转录", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    expect(await screen.findByText("旧消息，没有转录")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "思考过程" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "工具调用" })).not.toBeInTheDocument();
  });


});



describe("输入栏高度（clampComposerHeight）", () => {
  it("默认 132，夹在 72–360 之间并取整", () => {
    expect(clampComposerHeight(Number.NaN)).toBe(132);
    expect(clampComposerHeight(10)).toBe(72);
    expect(clampComposerHeight(999)).toBe(360);
    expect(clampComposerHeight(150.6)).toBe(151);
  });
});


describe("ChatPage 工具轮可视化接线", () => {
  /** 本 describe 不继承主 describe 的 beforeEach：助手会话与流式状态各就位。 */
  beforeEach(() => {
    useUiStore.setState({ page: "chat", activeConversationId: "c1" });
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: {
            id: "system-assistant",
            name: "和小鸣",
            avatar: null,
            owner_id: null,
            description: "",
          },
          unreadCount: 0,
        },
      ],
      messages: {},
      streaming: {},
      streamOwner: {},
      plainById: {},
      pendingE2e: {},
    });
    vi.mocked(hasSubtle).mockReturnValue(true);
    vi.mocked(streamChat).mockReset(); // 调用计数跨用例累积会误伤「第 2 轮」断言
    // 每次清掉上一个用例可能留下的 MCP 服务（含预置的），保证 armEchoServer 独占
    for (const s of [...mcpRegistry.servers()]) mcpRegistry.remove(s.id);
  });

  /** 与 ChatPage describe 内同名助手等价（那个是块内私有，这里用局部版）。 */
  async function pickAndSend(text: string) {
    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
  }

  /** 起一个已连接、工具已授权的 MCP 服务（用完即删，避免污染其他用例）。 */
  function armEchoServer() {
    const server = mcpRegistry.add({
      id: "srv-viz",
      name: "echo-svc",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
    });
    mcpRegistry.setTools(server.id, [{ name: "echo", description: "回声工具" }]);
    mcpRegistry.setToolEnabled(server.id, "echo", true);
    return () => mcpRegistry.remove(server.id);
  }

  it("工具轮：思考过程与工具轨迹进流气泡，最终答案照常上行", async () => {
    const dispose = armEchoServer();
    try {
      const send = vi.fn();
      vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
            mockMessagesFetch([]);
      render(<ChatPage />);
      // 等 WS 句柄就绪：输入栏在 connected 之后才渲染。
      // 单次 act 可能不足以冲掉队列里的连接回调，故显式等它出现。
      await waitFor(() =>
        expect(screen.getByPlaceholderText("输入消息…")).toBeInTheDocument(),
      );
      bindAssistant();

      // 第 1 轮：只思考 + 要工具（无正文）；第 2 轮：给答案
      let round = 0;
      vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
        if (round++ === 0) {
          o.onReasoning?.("先确认要查什么");
          o.onToolCalls?.([
            {
              id: "call-1",
              type: "function",
              function: { name: "echo-svc__echo", arguments: '{"text":"hi"}' },
            },
          ]);
          return "";
        }
        o.onDelta("回声：hi");
        return "回声：hi";
      });

      await pickAndSend("@和小鸣 用 echo 查一下");

      // 思考过程即时可见
      await waitFor(() => expect(screen.getByText("思考过程")).toBeInTheDocument());
      expect(screen.getByText("先确认要查什么")).toBeInTheDocument();

      // 工具轨迹：命名空间化工具名 + 成功态
      //（HITL 闸门会先弹确认框，同一工具名在框里也出现一次，故用 getAllByText）
      await waitFor(() =>
        expect(screen.getAllByText("echo-svc · echo").length).toBeGreaterThanOrEqual(1),
      );
      // 确认框出现 = 未知工具按 write 处理、必问（设计 T01「未知工具 = write」）
      await waitFor(() =>
        expect(screen.getByRole("dialog", { name: /请求调用工具/ })).toBeInTheDocument(),
      );
      // 放行：只有勾上的项才执行
      fireEvent.click(screen.getByLabelText("允许 echo-svc · echo"));
      fireEvent.click(screen.getByRole("button", { name: "仅本次允许" }));
      await waitFor(() => expect(screen.getByText("完成")).toBeInTheDocument());

      // 工具结果与最终答案都出现（同一句文本，故用 getAllByText）
      await waitFor(() => expect(screen.getAllByText(/回声：hi/).length).toBeGreaterThanOrEqual(2));

      // 工具轮的中间话术没有上行，最终只发答案
      // （密文会话下 finish 的 text 置空、内容在 cipher 里，两种都收）
      const finishes = send.mock.calls
        .map(([e]) => e as { type: string; text?: string; cipher?: string })
        .filter((e) => e.type === "agent_finish");
      expect(finishes.length).toBeGreaterThan(0);
      const last = finishes[finishes.length - 1];
      const finalText = last.text || (last.cipher ? String(decodePlain(last.cipher).text) : "");
      expect(finalText).toBe("回声：hi");
    } finally {
      dispose();
    }
  });

  it("闸门异常：不弹确认框、工具不执行，回灌文案不说「用户拒绝」", async () => {
    const dispose = armEchoServer();
    try {
      const send = vi.fn();
      vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
            mockMessagesFetch([]);
      render(<ChatPage />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText("输入消息…")).toBeInTheDocument(),
      );
      bindAssistant();

      gateState.failReview = true;
      const seen: { role: string; content: unknown }[][] = [];
      let round = 0;
      vi.mocked(streamChat).mockImplementation(async (_p, messages, o) => {
        seen.push(messages as { role: string; content: unknown }[]);
        if (round++ === 0) {
          o.onToolCalls?.([
            {
              id: "call-err",
              type: "function",
              function: { name: "echo-svc__echo", arguments: '{"text":"hi"}' },
            },
          ]);
          return "";
        }
        o.onDelta("好的");
        return "好的";
      });

      await pickAndSend("@和小鸣 用 echo 查一下");

      // 闸门抛错 → UI 不应弹窗（用户根本没被问到）
      await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("dialog", { name: /请求调用工具/ })).not.toBeInTheDocument();

      // 第二轮请求里必须有等长的 tool 消息，且文案说明「确认流程异常」而非「用户拒绝」
      const toolMsg = seen[1]?.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("确认流程异常");
      expect(String(toolMsg?.content)).not.toContain("用户拒绝");

      // 轨迹显式标「已拒绝」，对话本身继续（第二轮请求已断言）
      await waitFor(() => expect(screen.getByText("已拒绝")).toBeInTheDocument());
    } finally {
      gateState.failReview = false;
      dispose();
    }
  });

  /**
   * d.34：待确认不再「切会话 = 拒绝」，且跨会话请求进通知中心。
   */

  it("确认超时 → 按拒绝收口、审计写明「超时未确认」、通知换成超时提示（d.34）", async () => {
    localStorage.removeItem("heming.selfAudit.v1");
    const dispose = armEchoServer();
    try {
      const send = vi.fn();
      vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
      mockMessagesFetch([]);
      // 超时注入成极短值：生产 60 分钟，测试没必要等。
      render(<ChatPage hitlTimeoutMs={60} />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText("输入消息…")).toBeInTheDocument(),
      );
      bindAssistant();

      let round = 0;
      vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
        if (round++ === 0) {
          o.onToolCalls?.([
            {
              id: "call-t1",
              type: "function",
              function: { name: "echo-svc__echo", arguments: '{"text":"hi"}' },
            },
          ]);
          return "";
        }
        o.onDelta("好的");
        return "好的";
      });

      await pickAndSend("@和小鸣 用 echo 查一下");
      await waitFor(() =>
        expect(screen.getByRole("dialog", { name: /请求调用工具/ })).toBeInTheDocument(),
      );

      // 不点任何按钮，等它超时。
      await waitFor(
        () =>
          expect(
            screen.queryByRole("dialog", { name: /请求调用工具/ }),
          ).not.toBeInTheDocument(),
        { timeout: 3000 },
      );

      // 审计：拒绝 + 原因写明超时（与用户手动拒绝可区分）。
      const audit = JSON.parse(localStorage.getItem("heming.selfAudit.v1") ?? "[]") as {
        action: string;
        rejected?: string;
        target?: string;
      }[];
      expect(audit.some((e) => e.action === "deny" && e.rejected === "超时未确认")).toBe(true);
      // 留痕里的工具名与确认弹窗同一口径：`服务__工具` → `服务 · 工具`
      const audited = audit.find((e) => e.action === "deny");
      expect(audited?.target).toContain("echo-svc · echo");
      expect(audited?.target ?? "").not.toContain("__");

      // 通知：原来的「待确认」被替换成超时提示（不会留一个已经结束的请求）。
      const keys = useNotificationStore.getState().items.map((n) => n.key);
      expect(keys.some((k) => k.startsWith("approval:"))).toBe(false);
      expect(keys.some((k) => k.startsWith("approval-timeout:"))).toBe(true);
      await act(async () => {});
    } finally {
      dispose();
    }
  });

  /** 取出指定类型的上行帧（主 describe 里的同名助手是块内私有，这里用局部版）。 */
  const framesOf = (send: ReturnType<typeof vi.fn>, type: string) =>
    send.mock.calls.map((c) => c[0]).filter((e) => e.type === type);

  it("工具轮下最终答案仍逐片上行（打字机效果不丢）", async () => {
    // 回归：工具轮曾把模型输出拼成一整段再发，用户看到的是「文字突然整块蹦出来」。
    // 现在按片攒、按片发，chunk 数与模型的分片数一致。
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    const callsBefore = vi.mocked(streamChat).mock.calls.length;
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onDelta("你");
      o.onDelta("好");
      return "你好";
    });

    await pickAndSend("@和小鸣 打个招呼");
    await waitFor(() => expect(screen.getByText(/你好/)).toBeInTheDocument());

    const mine = vi.mocked(streamChat).mock.calls.slice(callsBefore);
    expect(mine.length).toBeGreaterThan(0);
    // 确实带了 tools（走的是工具轮路径）
    const tools = (mine[0][2] as { tools?: unknown[] }).tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    // 但文本仍逐片上行：两片 → 两个 chunk
    await waitFor(() => expect(framesOf(send, "agent_chunk")).toHaveLength(2));
  });

  it("工具轮中断时已产出的文字不丢（partial 兜底）", async () => {
    // 回归：工具轮里模型的输出先进缓冲、不上行；中断时若不兜底，
    // 用户一个字都看不到（模型明明已经吐了「半」）。
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    vi.mocked(streamChat).mockImplementation(
      (_p, _m, o) =>
        new Promise<string>((_res, rej) => {
          o.onDelta("半");
          o.signal.addEventListener("abort", () =>
            rej(new DOMException("AbortError", "AbortError")),
          );
        }),
    );

    await pickAndSend("@和小鸣 写段文字");
    await waitFor(() => expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));

    await waitFor(() => expect(framesOf(send, "agent_finish")).toHaveLength(1));
    const sealedTexts = (kind: string) =>
      vi
        .mocked(sealMessage)
        .mock.calls.map((c) => c[1] as { kind?: string; text?: string })
        .filter((p) => p.kind === kind)
        .map((p) => p.text);
    // partial 里带着「半」——一个字都没丢；工具轮的缓冲不能当最终答案落库，
    // 因此会补一句「以上是中断前的过程说明」（P1-5）。
    const sealed = sealedTexts("text");
    expect(sealed.some((t) => (t ?? "").includes("半"))).toBe(true);
    expect(sealed.some((t) => (t ?? "").includes("不是最终答案"))).toBe(true);
  });

  it("未授权自我优化时不注入 self 工具，但 chart 工具照常在（两者授权是独立的）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    // 记录窗口起点：上一个用例的触发是即发即忘，收尾可能落在本用例里
    const callsBefore = vi.mocked(streamChat).mock.calls.length;
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onDelta("直接回答");
      return "直接回答";
    });

    await pickAndSend("@和小鸣 打个招呼");
    await waitFor(() => expect(screen.getByText(/直接回答/)).toBeInTheDocument());

    // 只看本用例窗口内的调用：上一个用例的触发是「即发即忘」，其收尾可能落在本用例里
    const mine = vi.mocked(streamChat).mock.calls.slice(callsBefore);
    expect(mine.length).toBeGreaterThan(0);
    const namesOf = (call: (typeof mine)[number]): string[] =>
      ((call[2] as { tools?: { function?: { name?: string } }[] }).tools ?? []).map(
        (t) => t.function?.name ?? "",
      );
    for (const call of mine) {
      const names = namesOf(call);
      // 自我优化未授权 → 一个 self_* 工具都不该出现
      expect(names.filter((n) => n.startsWith("self_"))).toEqual([]);
      // 图表工具是内容产出、无副作用，默认提供
      expect(names.filter((n) => n.startsWith("chart_")).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
    expect(screen.queryByText("调用中")).not.toBeInTheDocument();
  });

});


describe("ChatPage 复盘分身接线", () => {
  /** 与文件内既有的群会话底座一致：本群含「和小鸣」，绑定 LLM 后 @ 可触发。 */
  async function setup() {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
        mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();
    return send;
  }

  async function pickAndSendLocal(text: string) {
    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
  }

  it("成功轮次收尾后触发一次复盘，并带上本轮内容与工具调用数", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(maybeRunReview).mockClear();
    memoryStore.updateSettings({ enabled: true }); // 前面的用例关过总开关，这里显式复原
    await setup();
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onDelta("跑完了");
      return "跑完了";
    });

    await pickAndSendLocal("帮我生成周报");
    await waitFor(() => expect(vi.mocked(maybeRunReview)).toHaveBeenCalledTimes(1));

    const payload = vi.mocked(maybeRunReview).mock.calls[0][0];
    expect(payload.agentId).toBe("system-assistant");
    expect(payload.userText).toContain("帮我生成周报");
    expect(payload.assistantText).toContain("跑完了");
    expect(payload.conversationId).toBe("c1");
    expect(payload.toolCallCount).toBe(0);
    // 复盘素材带上最近若干轮工作记忆
    expect(Array.isArray(payload.recentTurns)).toBe(true);
    expect(payload.profile?.id).toBe("p1");
  });

  it("记忆总开关关着：不触发复盘", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(maybeRunReview).mockClear();
    await setup();
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onDelta("跑完了");
      return "跑完了";
    });
    memoryStore.updateSettings({ enabled: false });
    try {
      await pickAndSendLocal("再跑一次");
      await waitFor(() => expect(screen.getByText(/跑完了/)).toBeInTheDocument());
      expect(vi.mocked(maybeRunReview)).not.toHaveBeenCalled();
    } finally {
      memoryStore.updateSettings({ enabled: true });
    }
  });
});

describe("ChatPage 任务区接线", () => {
  const agentConv = {
    id: "c1",
    type: "agent",
    agent: { id: "system-assistant", owner_id: null, name: "和小鸣", avatar: null, description: "官方" },
    unreadCount: 0,
  };

  // 本 describe 在主 describe 之外，不继承它的 beforeEach：封条/WS/流式桩各就位。
  beforeEach(() => {
    localStorage.removeItem(TASKS_KEY);
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(sealMessage).mockReset();
    vi.mocked(sealMessage).mockImplementation(stubSeal as never);
    vi.mocked(hasSubtle).mockReturnValue(true);
    vi.mocked(connectWs).mockReset();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() });
    vi.mocked(streamChat).mockReset();
    vi.mocked(streamChat).mockResolvedValue("");
    vi.mocked(migrateMsgCache).mockReset();
    vi.mocked(migrateMsgCache).mockReturnValue(0);
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useTaskStore.setState({ tasks: [] });
    useChatStore.setState({
      conversations: [agentConv] as never,
      messages: {},
      messagesLoading: {},
      messagesError: {},
      streaming: {},
      streamOwner: {},
      plainById: {},
      pendingE2e: {},
    });
    // 任务视图已并入智能体页：页 = chat，视图 = tasks
    useUiStore.setState({ page: "chat", pageView: "tasks", activeConversationId: "c1", taskDraft: null });
    setNotificationStorage(createMemoryStorage());
    useNotificationStore.setState({ items: [] });
    bindAssistant();
    mockMessagesFetch([]);
  });

  it("任务投递：自动发送目标、工具步骤落档、完成时收口 done", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    // 第 1 轮要一个只读工具（chart_types 默认可放行），第 2 轮给最终答案
    let round = 0;
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      if (round++ === 0) {
        o.onToolCalls?.([
          {
            id: "call-t1",
            type: "function",
            function: { name: "chart_types", arguments: "{}" },
          },
        ]);
        return "";
      }
      o.onDelta("任务完成");
      return "任务完成";
    });

    const taskId = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "system-assistant",
      agentName: "和小鸣",
      prompt: "看看有哪些图表",
    });
    useUiStore.getState().setTaskDraft({
      taskId,
      conversationId: "c1",
      text: "看看有哪些图表",
      mentions: [{ agentId: "system-assistant", name: "和小鸣" }],
    });

    render(<ChatPage />);
    await act(async () => {});
    // 首次挂载 connected 为 false，任务投递要等 WS 就绪
    act(() => lastHandlers().onOpen?.());

    await waitFor(() =>
      expect(send.mock.calls.some(([e]) => (e as { type?: string }).type === "send_message")).toBe(
        true,
      ),
    );
    // 目标走 e2e 密文，payload 只留占位
    expect(await lastSealed(send)).toMatchObject({ kind: "text", text: "看看有哪些图表" });

    await waitFor(() => {
      expect(useTaskStore.getState().tasks.find((t) => t.id === taskId)?.status).toBe("done");
    });
    const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)!;
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]).toMatchObject({ name: "chart_types", status: "ok" });
    expect(task.result).toContain("任务完成");
    expect(useUiStore.getState().taskDraft).toBeNull();
    // 任务收尾进通知中心：发起后切去别处的用户回来能在铃铛看到结果
    const notes = useNotificationStore.getState().items;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "task", taskId, conversationId: "c1" });
    expect(notes[0].title).toContain("已完成");
    expect(notes[0].body).toContain("任务完成");
  });

  it("分叉投递：来源回合的前缀被重建进请求（assistant.tool_calls + 等长 tool 结果）", async () => {
    type WireMessage = {
      role: string;
      content: string;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
    };
    const requests: WireMessage[][] = [];
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    vi.mocked(streamChat).mockImplementation(async (_p, messages, o) => {
      requests.push(messages as unknown as WireMessage[]);
      o.onDelta("继续");
      return "继续";
    });

    // 来源回合（v2 日志）：一次工具调用 + 结果，然后被中断 → 可从那条结果之后分叉
    const sourceStream = "s-fork-source";
    rolloutLog.append({
      type: "turn_start",
      conversationId: "c1",
      streamId: sourceStream,
      agentId: "system-assistant",
      userText: "梳理依赖",
    });
    rolloutLog.append({ type: "tool_call", streamId: sourceStream, id: "t1", name: "chart_types", args: "{}" });
    rolloutLog.append({
      type: "tool_result",
      streamId: sourceStream,
      id: "t1",
      name: "chart_types",
      ok: true,
      text: "图表目录",
    });
    rolloutLog.append({ type: "turn_end", streamId: sourceStream, status: "aborted" });

    const originId = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "system-assistant",
      agentName: "和小鸣",
      prompt: "梳理依赖",
    });
    useTaskStore.getState().bindStream(originId, sourceStream);
    useTaskStore.getState().settle(originId, { status: "cancelled" });
    const forkedId = useTaskStore
      .getState()
      .forkFrom(originId, { streamId: sourceStream, seq: 2 })!;
    useUiStore.getState().setTaskDraft({
      taskId: forkedId,
      conversationId: "c1",
      text: "梳理依赖",
      mentions: [{ agentId: "system-assistant", name: "和小鸣" }],
    });

    render(<ChatPage />);
    await act(async () => {});
    act(() => lastHandlers().onOpen?.());

    // 请求里带上了重建前缀，且形状合法：tool_calls 与 tool 消息等长同序、在 user 轮之前
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    const first = requests[0]!;
    const toolCalls = first.flatMap((m) => m.tool_calls ?? []);
    const toolMessages = first.filter((m) => m.role === "tool");
    expect(toolCalls.map((c) => c.id)).toEqual(["t1"]);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["t1"]);
    expect(toolMessages[0]!.content).toBe("图表目录");
    expect(first.findIndex((m) => m.role === "tool")).toBeLessThan(
      first.findIndex((m) => m.role === "user"),
    );

    // 新回合的日志首条带上来源：任务卡与回放都能看出「这是从哪分叉出来的」
    await waitFor(() =>
      expect(useTaskStore.getState().tasks.find((t) => t.id === forkedId)?.streamId).toBeTruthy(),
    );
    const newStream = useTaskStore.getState().tasks.find((t) => t.id === forkedId)!.streamId!;
    expect(rolloutLog.read(newStream)[0]).toMatchObject({
      type: "turn_start",
      forkedFrom: { streamId: sourceStream, seq: 2 },
    });
  });

  it("分叉降级：来源日志读不到时按普通重跑执行，并显示原因（不静默）", async () => {
    type WireMessage = { role: string; content: string; tool_calls?: { id: string }[] };
    const requests: WireMessage[][] = [];
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    vi.mocked(streamChat).mockImplementation(async (_p, messages, o) => {
      requests.push(messages as unknown as WireMessage[]);
      o.onDelta("好的");
      return "好的";
    });

    const originId = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "system-assistant",
      agentName: "和小鸣",
      prompt: "梳理依赖",
    });
    // 来源回合日志不存在（被清理/换设备）：分叉记录还在，但前缀重建不出来
    useTaskStore.getState().bindStream(originId, "s-fork-missing");
    useTaskStore.getState().settle(originId, { status: "cancelled" });
    const forkedId = useTaskStore
      .getState()
      .forkFrom(originId, { streamId: "s-fork-missing", seq: 2 })!;
    useUiStore.getState().setTaskDraft({
      taskId: forkedId,
      conversationId: "c1",
      text: "梳理依赖",
      mentions: [{ agentId: "system-assistant", name: "和小鸣" }],
    });

    render(<ChatPage />);
    await act(async () => {});
    act(() => lastHandlers().onOpen?.());

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    // 不伪造前缀：请求里没有任何 tool 消息
    expect(requests[0]!.some((m) => m.role === "tool")).toBe(false);
    expect(requests[0]!.some((m) => (m.tool_calls ?? []).length > 0)).toBe(false);
    // 明确告知降级原因，而不是静默变成重跑
    expect(screen.getByText(/本次按普通重跑执行/)).toBeInTheDocument();
    // 来源仍如实记录（任务卡/日志表达「这是一次分叉尝试」）
    await waitFor(() =>
      expect(useTaskStore.getState().tasks.find((t) => t.id === forkedId)?.streamId).toBeTruthy(),
    );
    const newStream = useTaskStore.getState().tasks.find((t) => t.id === forkedId)!.streamId!;
    expect(rolloutLog.read(newStream)[0]).toMatchObject({
      forkedFrom: { streamId: "s-fork-missing", seq: 2 },
    });
  });

  it("打开会话触发一次 msgCache 明文迁移（P0-5b 接线）", async () => {
    render(<ChatPage />);
    await act(async () => {});
    expect(vi.mocked(migrateMsgCache)).toHaveBeenCalledWith("c1");
    expect(vi.mocked(migrateMsgCache)).toHaveBeenCalledTimes(1);
  });

  it("迁移抛错不影响消息渲染与输入", async () => {
    mockMessagesFetch([msg("m1", "历史消息", "2026-10-14T01:00:00.000Z")]);
    vi.mocked(migrateMsgCache).mockImplementation(() => {
      throw new Error("迁移失败");
    });

    render(<ChatPage />);
    await act(async () => {});

    expect(screen.getByText("历史消息")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入消息…")).toBeInTheDocument();
  });

  it("两处缓存读取都走定点 get，不再全量 list（P0-5b）", async () => {
    render(<ChatPage />);
    await act(async () => {});
    const handler = useChatStore.getState().openHandler!;
    expect(handler).toBeTruthy();

    const cachedPlain = { kind: "text", text: "缓存命中", senderId: "u1", at: 0 } as never;
    const getSpy = vi.spyOn(msgCache, "get");
    const listSpy = vi.spyOn(msgCache, "list");
    listSpy.mockClear(); // 忽略渲染期其它读，只看下面两条补齐路径

    try {
      // ① 缓存优先命中：只按 id 取一条
      getSpy.mockReturnValueOnce({ id: "m-get", senderId: "u1", at: 0, plain: cachedPlain });
      const hit = await handler(
        { id: "m-get", senderId: "u1", cipher: "坏密文", chainKid: "k", n: 1 } as never,
        undefined,
      );
      expect(hit).toMatchObject({ status: "ok" });
      expect(getSpy).toHaveBeenCalledWith("c1", "m-get");

      // ② duplicate 补齐分支：缓存 miss → openMessage 返回 duplicate → 再定点 get 一次
      vi.mocked(openMessage).mockResolvedValueOnce("duplicate");
      getSpy.mockReturnValueOnce(null);
      getSpy.mockReturnValueOnce({ id: "m-dup", senderId: "u1", at: 0, plain: cachedPlain });
      const dup = await handler(
        { id: "m-dup", senderId: "u1", cipher: "坏密文", chainKid: "k", n: 2 } as never,
        undefined,
      );
      expect(dup).toMatchObject({ status: "ok" });
      expect(getSpy).toHaveBeenCalledWith("c1", "m-dup");

      // 这两条路径不再全量读（list 只留给迁移/调试入口）
      expect(listSpy.mock.calls.filter(([id]) => id === "c1")).toHaveLength(0);
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
    }
  });
});

/**
 * UX-A：未绑定模型前置提示、禁用发送、空态示例（只填不发）与快捷键提示。
 * 单独一个 describe：复用文件级 helper，但状态独立，避免污染既有 100+ 用例。
 */
describe("UX-A 未绑定模型与对话空态", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(connectWs).mockReset();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() });
    vi.mocked(hasSubtle).mockReturnValue(true);
    vi.mocked(sealMessage).mockReset();
    vi.mocked(sealMessage).mockImplementation(stubSeal as never);
    vi.mocked(streamChat).mockReset();
    vi.mocked(streamChat).mockResolvedValue("");
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useUiStore.setState({ page: "chat", activeConversationId: "c1", taskDraft: null });
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "agent",
          agent: { id: "system-assistant", name: "和小鸣", avatar: null, owner_id: null, description: "" },
          unreadCount: 0,
        },
      ] as never,
      messages: {},
      messagesLoading: {},
      messagesError: {},
      streaming: {},
      streamOwner: {},
      plainById: {},
      pendingE2e: {},
    });
    useNotificationStore.setState({ items: [] });
    mockMessagesFetch([]);
  });

  it("未绑定模型：输入区上方出现统一提示、发送禁用、点「去设置」跳设置页", async () => {
    render(<ChatPage />);
    await act(async () => {});

    const notice = await screen.findByText(/当前智能体还没有绑定模型连接/);
    expect(notice.textContent).toContain("和小鸣");
    const noticeBox = document.getElementById("unbound-model-notice")!;
    expect(noticeBox).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: "你好" } });
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
    expect(send.getAttribute("title") ?? "").toContain("还没有绑定模型连接");

    fireEvent.click(within(noticeBox).getByRole("button", { name: "去设置" }));
    expect(useUiStore.getState().page).toBe("model");
  });

  it("本机已有连接但未绑定：提示条里直接选一个就能绑上（d.82）", async () => {
    useLlmStore.setState({ profiles: [testProfile], bindings: {}, prompts: {} });
    render(<ChatPage />);
    await act(async () => {});

    const noticeBox = document.getElementById("unbound-model-notice")!;
    expect(noticeBox).not.toBeNull();
    const picker = within(noticeBox).getByLabelText("选择要绑定的模型连接");
    fireEvent.change(picker, { target: { value: "p1" } });

    // 绑定写进本机绑定表，提示条随之消失（同一判定驱动）
    expect(useLlmStore.getState().bindings["system-assistant"]).toBe("p1");
    await waitFor(() =>
      expect(screen.queryByText(/当前智能体还没有绑定模型连接/)).toBeNull(),
    );
    // 拿不准管理连接时仍可去设置：按钮改叫「管理连接」
    expect(screen.queryByRole("button", { name: "去设置" })).toBeNull();
  });

  it("通道状态只描述实时通道，不与「未绑定模型」互相矛盾（P1-3）", async () => {
    render(<ChatPage />);
    await act(async () => {});

    // 未绑定：橙色提示条出现、发送禁用
    expect(await screen.findByText(/当前智能体还没有绑定模型连接/)).toBeInTheDocument();
    act(() => {
      lastHandlers().onOpen?.();
    });
    // 通道连上是事实，但措辞必须点明是「通道」，不能被读成「智能体已连上模型」
    expect(screen.getByText("通道已连接")).toBeInTheDocument();
    // 旧文案「已连接」（裸说法）不再出现，避免与模型就绪混淆
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("绑定模型后提示消失、发送可用（同一判定驱动提示与禁用）", async () => {
    bindAssistant();
    render(<ChatPage />);
    await act(async () => {});
    expect(screen.queryByText(/当前智能体还没有绑定模型连接/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: "你好" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("对话空态：3 条示例可点，只填入输入框、不发任何请求", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    render(<ChatPage />);
    await act(async () => {});

    const list = await screen.findByRole("list", { name: "对话示例" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(3);

    fireEvent.click(buttons[1]!);
    const input = screen.getByPlaceholderText("输入消息…") as HTMLTextAreaElement;
    expect(input.value).toBe(buttons[1]!.textContent);
    // 没发请求：没有 send_message、也没启动模型流
    expect(send.mock.calls.some(([e]) => (e as { type?: string }).type === "send_message")).toBe(
      false,
    );
    expect(streamChat).not.toHaveBeenCalled();
    expect(screen.getByText("还没有消息")).toBeInTheDocument();
  });

  it("输入区常驻弱化快捷键提示（Enter / Shift+Enter / Esc）", async () => {
    bindAssistant();
    render(<ChatPage />);
    await act(async () => {});
    const hints = screen.getByLabelText("输入快捷键提示");
    expect(hints).toHaveTextContent("Enter");
    expect(hints).toHaveTextContent("Shift+Enter");
    expect(hints).toHaveTextContent("Esc");
  });
});
