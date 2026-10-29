/**
 * d.39 深度对抗 + 压测（QA 独立复检）。
 *
 * 只做验证，不改生产代码。所有用例都用独立消息 id 前缀：seenIncoming /
 * workspaceRefreshing 都是模块级状态，跨用例存活（见 backgroundMessages.test.ts 注释）。
 *
 * 计时用例只做宽松上界断言，数字以 console.info 输出为准。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "@heming/shared";
import { handleBackgroundEvent } from "./backgroundMessages.js";
import { notifyIncomingMessage, resetMessageNotifyForTest } from "./messageNotify.js";
import { resetConvPrefsForTest, setMuted } from "./convPrefs.js";
import {
  CONV_PREFS_KEY,
  isMuted,
} from "./convPrefs.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import {
  NOTIFICATIONS_BYTE_LIMIT,
  NOTIFICATIONS_KEY,
  setNotificationStorage,
  useNotificationStore,
  type AppNotification,
} from "../store/notifications.js";
import { createMemoryStorage, utf8Length } from "./memory/storage.js";
import type { StorageLike } from "./memory/types.js";

const ME = { id: "u1", username: "alice", displayName: "爱丽丝" } as const;
const PEER = { id: "u2", username: "bob", displayName: "鲍勃" } as const;

const direct = (id: string, unreadCount = 0): Conversation => ({
  id,
  type: "direct",
  peer: { ...PEER },
  unreadCount,
  lastMessageAt: null,
});

let idSeq = 0;
/** 全局唯一的消息 id（含用例前缀），避免模块级去重表串味。 */
const msg = (prefix: string, over: Partial<Message> = {}): Message => ({
  id: `${prefix}-${++idSeq}`,
  conversationId: "c-stress",
  senderType: "user",
  senderId: PEER.id,
  payload: { text: "你好" },
  replyTo: null,
  createdAt: "2026-10-28T02:00:00.000Z",
  recalledAt: null,
  enc: "plain",
  ...over,
});

function bridge(): ReturnType<typeof vi.fn> {
  return window.__heming_notify!.message as unknown as ReturnType<typeof vi.fn>;
}

function byteLenOfPersisted(storage: StorageLike): number {
  const raw = storage.getItem(NOTIFICATIONS_KEY) ?? "";
  return utf8Length(raw);
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetConvPrefsForTest();
  resetMessageNotifyForTest();
  setNotificationStorage(null);
  useNotificationStore.setState({ items: [] });
  useAuthStore.setState({ user: { ...ME } as never });
  useChatStore.setState({
    conversations: [direct("c-stress")],
    messages: {},
    plainById: {},
    loadWorkspace: vi.fn(async () => {}),
  });
  window.__heming_notify = {
    message: vi.fn(),
    onOpen: vi.fn(() => () => {}),
  };
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  setNotificationStorage(null);
});

// ---------------------------------------------------------------- A. 去重/风暴

describe("A. 后台提醒去重与风暴", () => {
  it("A1: 同一条消息投递 1000 次 → 未读 +1、通知 1、系统桥 1 次", () => {
    const m = msg("a1");
    for (let i = 0; i < 1000; i += 1) handleBackgroundEvent({ type: "message_new", message: m });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(bridge()).toHaveBeenCalledTimes(1);
  });

  it("A2: 501 个唯一 id → 未读 501；再投首个 id 被重放（500 上限淘汰最旧）→ 502", () => {
    const first = msg("a2");
    const list = [first];
    for (let i = 1; i < 501; i += 1) list.push(msg("a2"));
    for (const m of list) handleBackgroundEvent({ type: "message_new", message: m });

    expect(useChatStore.getState().conversations[0].unreadCount).toBe(501);
    // 501 > 500，最旧的 first 在加入第 501 条时被淘汰
    handleBackgroundEvent({ type: "message_new", message: first });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(502);
    // 再次投递同一条（这次刚入表）应被去重
    handleBackgroundEvent({ type: "message_new", message: first });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(502);
  });

  it("A3: 200 条未知会话消息同 tick → 在途 loadWorkspace 只调一次；落定后可再刷", async () => {
    useChatStore.setState({ conversations: [] });
    const releases: Array<() => void> = [];
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    useChatStore.setState({ loadWorkspace: load });

    try {
      for (let i = 0; i < 200; i += 1) {
        handleBackgroundEvent({
          type: "message_new",
          message: msg("a3", { conversationId: `a3-unknown-${i}` }),
        });
      }
      expect(load).toHaveBeenCalledTimes(1);
      expect(releases.length).toBe(1);

      releases.shift()!();
      await new Promise<void>((r) => setTimeout(r, 0));

      handleBackgroundEvent({
        type: "message_new",
        message: msg("a3", { conversationId: "a3-another" }),
      });
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      for (const release of releases.splice(0)) release();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  });

  it("A4: 两条消息之间切换免打扰 → 第一条提醒，第二条不提醒；未读两条都加", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("a4", { conversationId: "c-stress" }) });
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(bridge()).toHaveBeenCalledTimes(1);

    setMuted("c-stress", true);
    handleBackgroundEvent({ type: "message_new", message: msg("a4", { conversationId: "c-stress" }) });

    expect(useChatStore.getState().conversations[0].unreadCount).toBe(2);
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(bridge()).toHaveBeenCalledTimes(1);
  });

  it("A5: read_update 他人忽略；自己清零并写 lastReadAt", () => {
    useChatStore.setState({
      conversations: [{ ...direct("c-stress", 5), lastReadAt: null }],
    });
    handleBackgroundEvent({
      type: "read_update",
      conversationId: "c-stress",
      userId: PEER.id,
      at: "2026-10-28T03:00:00.000Z",
    });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(5);
    expect(useChatStore.getState().conversations[0].lastReadAt).toBeNull();

    handleBackgroundEvent({
      type: "read_update",
      conversationId: "c-stress",
      userId: ME.id,
      at: "2026-10-28T03:00:00.000Z",
    });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(0);
    expect(useChatStore.getState().conversations[0].lastReadAt).toBe("2026-10-28T03:00:00.000Z");
  });

  it("A6: 未知会话里自己发的消息 → 无未读、无通知、不触发 loadWorkspace", () => {
    useChatStore.setState({ conversations: [] });
    const load = vi.fn(async () => {});
    useChatStore.setState({ loadWorkspace: load });

    handleBackgroundEvent({
      type: "message_new",
      message: msg("a6", { conversationId: "a6-unknown", senderId: ME.id }),
    });
    expect(load).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().items).toHaveLength(0);
    expect(bridge()).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations).toHaveLength(0);
  });

  it("A7: 非自己的 agent 消息按普通来消息处理（未读 + 提醒）", () => {
    handleBackgroundEvent({
      type: "message_new",
      message: msg("a7", { senderType: "agent", senderId: "agent-1" }),
    });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    const item = useNotificationStore.getState().items[0];
    expect(item.title).toBe("鲍勃");
    expect(bridge()).toHaveBeenCalledTimes(1);
  });

  it("A8: E2E 空正文 → 应用内正文空、系统正文固定、缺会话时标题回落「新消息」", () => {
    useChatStore.setState({ conversations: [] });
    handleBackgroundEvent({
      type: "message_new",
      message: msg("a8", {
        conversationId: "a8-unknown",
        enc: "e2e",
        payload: { text: "" },
      }),
    });
    const item = useNotificationStore.getState().items[0];
    expect(item.body).toBe("");
    expect(item.title).toBe("新消息");
    expect(bridge()).toHaveBeenCalledWith({
      title: "新消息",
      body: "你有一条新消息",
      conversationId: "a8-unknown",
    });
  });
});

// ---------------------------------------------------------------- B1. 计数

describe("B1. 连接计数注册/注销", () => {
  it("200 轮 register/unregister → 归零、永不为负、每次转换都通知", async () => {
    const { registerChatSocket, chatSocketCount, subscribeChatSocket, resetChatSocketPresenceForTest } =
      await import("./chatSocketPresence.js");
    resetChatSocketPresenceForTest();
    let notifications = 0;
    const off = subscribeChatSocket(() => {
      notifications += 1;
    });
    let min = 0;
    for (let i = 0; i < 200; i += 1) {
      const release = registerChatSocket();
      min = Math.min(min, chatSocketCount());
      expect(chatSocketCount()).toBe(1);
      release();
      min = Math.min(min, chatSocketCount());
      expect(chatSocketCount()).toBe(0);
      release(); // 幂等：重复注销不再减
    }
    off();
    expect(chatSocketCount()).toBe(0);
    expect(min).toBe(0);
    expect(notifications).toBe(400);
  });
});

// ---------------------------------------------------------------- C. 通知 store

describe("C. 通知中心负载", () => {
  it("C1: 2000 条不同通知 → 条数上限 50、字节上限内、持久化可解析", () => {
    const mem = createMemoryStorage();
    setNotificationStorage(mem);
    const push = useNotificationStore.getState().push;
    for (let i = 0; i < 2000; i += 1) {
      expect(
        push({
          kind: "message",
          key: `c1-key-${i}`,
          title: `标题${i}`,
          body: `正文${i}`,
          conversationId: "c-stress",
        }),
      ).toBeTypeOf("string");
    }
    const items = useNotificationStore.getState().items;
    expect(items).toHaveLength(50);
    expect(byteLenOfPersisted(mem)).toBeLessThanOrEqual(NOTIFICATIONS_BYTE_LIMIT);
    const persisted = JSON.parse(mem.getItem(NOTIFICATIONS_KEY)!) as AppNotification[];
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted).toHaveLength(50);
  });

  it("C1b: 超长 conversationId 触发字节淘汰（条数 < 50 且字节 <= 上限）", () => {
    const mem = createMemoryStorage();
    setNotificationStorage(mem);
    const push = useNotificationStore.getState().push;
    const hugeId = "x".repeat(4000);
    for (let i = 0; i < 50; i += 1) {
      push({ kind: "message", key: `c1b-${i}`, title: `T${i}`, conversationId: hugeId });
    }
    const items = useNotificationStore.getState().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(50);
    expect(byteLenOfPersisted(mem)).toBeLessThanOrEqual(NOTIFICATIONS_BYTE_LIMIT);
    expect(() => JSON.parse(mem.getItem(NOTIFICATIONS_KEY)!)).not.toThrow();
  });

  it("C2: 同一 key 推 2000 次 → 只留 1 条、不抛", () => {
    const mem = createMemoryStorage();
    setNotificationStorage(mem);
    const push = useNotificationStore.getState().push;
    for (let i = 0; i < 2000; i += 1) {
      push({ kind: "message", key: "c2-same", title: "同一条", conversationId: "c-stress" });
    }
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(JSON.parse(mem.getItem(NOTIFICATIONS_KEY)!)).toHaveLength(1);
  });

  it("C3: 2000 次 push 计时；每次同步写 storage（记录 setItem 占比）", () => {
    const mem = createMemoryStorage();
    let setItemMs = 0;
    let setItemCount = 0;
    const timed: StorageLike = {
      getItem: (k) => mem.getItem(k),
      setItem: (k, v) => {
        const t = performance.now();
        mem.setItem(k, v);
        setItemMs += performance.now() - t;
        setItemCount += 1;
      },
      removeItem: (k) => mem.removeItem(k),
    };
    setNotificationStorage(timed);
    const push = useNotificationStore.getState().push;
    const t0 = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      push({ kind: "message", key: `c3-${i}`, title: `标题${i}`, body: `正文${i}`, conversationId: "c3" });
    }
    const total = performance.now() - t0;
    console.info(
      `[C3] 2000 pushes total=${total.toFixed(1)}ms setItem=${setItemMs.toFixed(1)}ms ` +
        `(${((setItemMs / total) * 100).toFixed(1)}%) writes=${setItemCount}`,
    );
    // 每次 push 都同步落盘一次（setItem 计数 == 成功 push 次数）
    expect(setItemCount).toBe(2000);
    expect(total).toBeLessThan(15_000);
  });
});

// ---------------------------------------------------------------- E. 性能

describe("E. 性能计量", () => {
  it("E1: 5000 条同会话消息（distinct id）墙钟；每 bump 为 O(会话数)", () => {
    const list: Message[] = [];
    for (let i = 0; i < 5000; i += 1) list.push(msg("e1"));
    const t0 = performance.now();
    for (const m of list) handleBackgroundEvent({ type: "message_new", message: m });
    const total = performance.now() - t0;
    console.info(
      `[E1] 5000 messages (1 conv) total=${total.toFixed(1)}ms ` +
        `per-msg=${(total / 5000).toFixed(3)}ms unread=${useChatStore.getState().conversations[0].unreadCount} ` +
        `toasts=${bridge().mock.calls.length}`,
    );
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(5000);
    // 系统通知按会话 5s 合并：5000 条突发只弹第一声（应用内仍逐条去重入通知中心）
    expect(bridge()).toHaveBeenCalledTimes(1);
    expect(total).toBeLessThan(15_000);

    // 补充：同一批消息量下 200 个会话的单条成本（体现 O(conversations) 的数组重映射）。
    idSeq = 0;
    useChatStore.setState({
      conversations: Array.from({ length: 200 }, (_, i) => direct(`e1-many-${i}`)),
    });
    const list2 = Array.from({ length: 5000 }, (_, i) =>
      msg("e1b", { conversationId: `e1-many-${i % 200}` }),
    );
    const tb = performance.now();
    for (const m of list2) handleBackgroundEvent({ type: "message_new", message: m });
    const totalB = performance.now() - tb;
    console.info(
      `[E1b] 5000 messages (200 convs) total=${totalB.toFixed(1)}ms ` +
        `per-msg=${(totalB / 5000).toFixed(3)}ms`,
    );
  });

  it("E2: 50 个会话各 20 条（共 1000 条）墙钟", () => {
    const convs = Array.from({ length: 50 }, (_, i) => direct(`e2-c${i}`));
    useChatStore.setState({ conversations: convs });
    const list = Array.from({ length: 1000 }, (_, i) =>
      msg("e2", { conversationId: `e2-c${i % 50}` }),
    );
    const t0 = performance.now();
    for (const m of list) handleBackgroundEvent({ type: "message_new", message: m });
    const total = performance.now() - t0;
    const sum = useChatStore
      .getState()
      .conversations.reduce((n, c) => n + (c.unreadCount ?? 0), 0);
    console.info(`[E2] 1000 messages / 50 convs total=${total.toFixed(1)}ms unreadSum=${sum}`);
    expect(sum).toBe(1000);
    expect(total).toBeLessThan(15_000);
  });

  it("E3: 通知 store 2000 次 push 墙钟（真实 localStorage）；持久化同步成本", () => {
    // 不注入 storage → 走 jsdom 的 localStorage，与浏览器/Electron 同路径（同步 API）。
    let writes = 0;
    const origSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k, v) {
      // 只数通知键：createDefaultStorage 首次会写一次探针键（heming.memory.probe）
      if (k === NOTIFICATIONS_KEY) writes += 1;
      origSetItem.call(this, k, v);
    });
    const push = useNotificationStore.getState().push;
    const t0 = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      push({ kind: "message", key: `e3-${i}`, title: `标题${i}`, body: `正文${i}`, conversationId: "e3" });
    }
    const total = performance.now() - t0;
    // 结论：每次 push 同步调用一次 setItem（序列化在 store 内部做两遍：prune + writeJson）
    console.info(
      `[E3] 2000 pushes total=${total.toFixed(1)}ms per-push=${(total / 2000).toFixed(3)}ms ` +
        `sync setItem=${writes}`,
    );
    expect(writes).toBe(2000);
    expect(total).toBeLessThan(15_000);
  });
});

// ---------------------------------------------------------------- F. UX 漏洞排查

describe("F. UX 漏洞排查（可测部分）", () => {
  it("F-mute: 偏好里深嵌套 / 超大 / 坏 JSON 不抛，非 true 的 muted 不生效", () => {
    // 深嵌套（muted 不是 true）
    let deep: unknown = { muted: false };
    for (let i = 0; i < 5000; i += 1) deep = { muted: deep };
    localStorage.setItem(CONV_PREFS_KEY, JSON.stringify({ "c-deep": deep }));
    resetConvPrefsForTest();
    expect(() => isMuted("c-deep")).not.toThrow();
    expect(isMuted("c-deep")).toBe(false);

    // 极深嵌套可能让 JSON.parse 抛 RangeError——必须被吞掉
    let s = "";
    const depth = 100_000;
    s += '{"muted":'.repeat(depth) + "true" + "}".repeat(depth);
    localStorage.setItem(CONV_PREFS_KEY, `{"c-too-deep":${s}}`);
    resetConvPrefsForTest();
    expect(() => isMuted("c-too-deep")).not.toThrow();

    // 超大附属字段但 muted 为 true：照常识别，且内存表只保留 muted
    localStorage.setItem(
      CONV_PREFS_KEY,
      JSON.stringify({ "c-big": { muted: true, junk: "x".repeat(1_000_000) } }),
    );
    resetConvPrefsForTest();
    expect(isMuted("c-big")).toBe(true);
    expect(() => setMuted("c-big", true)).not.toThrow();
  });

  it("F-seen: seenIncoming 跨账号不清空（同一消息 id 换账号后被抑制）", () => {
    const m = msg("f-seen");
    handleBackgroundEvent({ type: "message_new", message: m });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);

    // 换账号（同一 web 进程内）：seenIncoming 是模块级，不随登出/登录清空
    useAuthStore.setState({ user: { id: "u9", username: "carol", displayName: "卡罗尔" } as never });
    useChatStore.setState({ conversations: [direct("c-stress")] });
    handleBackgroundEvent({ type: "message_new", message: m });
    // 观察：同一 id 被抑制 → 未读不计。真实服务端 id 全局唯一时风险低，但集合确实是跨账号共享的。
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(0);
  });

  it("F-toast: 同一会话 50 条不同消息 → 未读 50、系统通知合并为 1 次", () => {
    for (let i = 0; i < 50; i += 1) {
      handleBackgroundEvent({ type: "message_new", message: msg("f-toast", { conversationId: "c-stress" }) });
    }
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(50);
    expect(bridge()).toHaveBeenCalledTimes(1);
  });

  it("F-coalesce: 同一 key 的重复事件不重复弹系统通知（仅应用内去重路径）", () => {
    const m = msg("f-coalesce");
    for (let i = 0; i < 10; i += 1) handleBackgroundEvent({ type: "message_new", message: m });
    expect(bridge()).toHaveBeenCalledTimes(1);
  });
});

// 让 notifyIncomingMessage 的默认导出路径也至少被直接调用一次（避免未使用告警）
describe("直接入口自检", () => {
  it("notifyIncomingMessage 直调：聚焦时不弹系统通知", () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    notifyIncomingMessage(msg("direct-entry"));
    expect(bridge()).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });
});
