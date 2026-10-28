# d.39 全域消息感知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 离开聊天页也能实时收到未读与通知；桌面窗口不在前台时弹系统通知；按会话可免打扰。

**Architecture:** App 壳在非聊天页持有一条后台 WS，只做「未读 + 最近活跃 + 提醒」，不解密正文；消息按 id 去重。桌面端新增系统通知桥（preload → 主进程 `Notification`，点击聚焦并回传会话 id）。本机 `heming.convPrefs.v1` 记录按会话免打扰。

**Tech Stack:** React + zustand、既有 `connectWs`、Electron `Notification`/IPC、vitest/jsdom、node:test。

**Spec:** `docs/superpowers/specs/2026-10-28-d39-global-message-awareness.md`

## Global Constraints

- 后台**不解密正文**；系统通知正文固定「你有一条新消息」，不显示消息内容。
- 同一条消息只计一次未读、只提醒一次（进程内 500 条 id 去重）。
- 免打扰只抑制提醒，不抑制未读、不丢消息、不影响最近活跃排序。
- 自己发送的消息不提醒、不涨未读。
- 不改服务端 WS 协议、不改 E2E、不引第三方依赖。
- 视觉规范：无 emoji、细线 SVG、中文文案。
- 版本：`node scripts/bump-version.mjs auto feature`（`d.38.1.10.0` ⇒ **`d.39.1.10.0`**）。
- 门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`（桌面包改动含 `node --check` / 新增测试）。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `web/src/lib/convPrefs.ts` | 新建 | 本机会话偏好（免打扰）+ 订阅 |
| `web/src/lib/conversationTitle.ts` | 新建 | 三态会话显示名（通知标题） |
| `web/src/lib/desktopNotify.ts` | 新建 | 系统通知桥的渲染侧封装（聚焦判定/静默降级） |
| `web/src/lib/messageNotify.ts` | 新建 | 应用内通知 + 系统通知的唯一入口（含免打扰） |
| `web/src/lib/backgroundMessages.ts` | 新建 | 后台事件处理函数 + `useBackgroundMessages` hook |
| `web/src/store/chat.ts` | 修改 | `bumpUnread` 去重与 `lastMessageAt` |
| `web/src/components/ChatPage.tsx` | 修改 | 复用共享 `notifyIncomingMessage`；传入 id/at |
| `web/src/App.tsx` | 修改 | 非聊天页启用后台连接；系统通知点击回跳 |
| `web/src/components/ChatInfoCard.tsx` | 修改 | 免打扰开关 |
| `web/src/components/icons.tsx` | 修改 | `BellIcon` |
| `web/src/types/heming.d.ts` | 修改 | `window.__heming_notify` 类型 |
| `desktop/notify-bridge.js` | 新建 | 系统通知 IPC（点击聚焦/回传会话） |
| `desktop/notify-bridge.test.js` | 新建 | 注入假 Notification/BrowserWindow |
| `desktop/preload.js` | 修改 | 暴露 `__heming_notify` |
| `desktop/preload.test.js` | 修改 | 桥形状与取消订阅 |
| `desktop/main.js` | 修改 | 注册通知 IPC |
| `desktop/package.json` | 修改 | 打包白名单 + 测试脚本 |
| 文档/版本 | 修改 | CHANGELOG、HANDOFF、INDEX、spec/plan |

---

### Task 1: Web 基础（去重 / 通知入口 / 免打扰 / 会话标题）

**Files:**
- Create: `packages/web/src/lib/convPrefs.ts`
- Create: `packages/web/src/lib/conversationTitle.ts`
- Create: `packages/web/src/lib/desktopNotify.ts`
- Create: `packages/web/src/lib/messageNotify.ts`
- Modify: `packages/web/src/store/chat.ts`（`bumpUnread`）
- Modify: `packages/web/src/components/ChatPage.tsx`（复用共享通知；删除本地 `convTitleOf`/`notifyIncomingMessage`）
- Modify: `packages/web/src/types/heming.d.ts`
- Test: `packages/web/src/lib/convPrefs.test.ts`（新建）、`packages/web/src/lib/messageNotify.test.ts`（新建）、`packages/web/src/store/chat.test.ts`

**Interfaces:**
- Produces: `isMuted(convId)`, `setMuted(convId, muted)`, `subscribeConvPrefs`, `convPrefsVersion`, `resetConvPrefsForTest`;
  `conversationTitle(conv)`;
  `notifyIncomingMessage(message)`;
  `notifyDesktop({title, body, conversationId?})`;
  `bumpUnread(convId, at?, messageId?): boolean`。
- `window.__heming_notify?: { message(payload): void; onOpen(cb: (id: string|null)=>void): () => void }`。

- [ ] **Step 1: 写失败的测试**

`convPrefs.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  CONV_PREFS_KEY,
  convPrefsVersion,
  isMuted,
  resetConvPrefsForTest,
  setMuted,
  subscribeConvPrefs,
} from "./convPrefs.js";

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
});

describe("convPrefs（按会话免打扰）", () => {
  it("默认不静音；开启后持久化；关闭后删键", () => {
    expect(isMuted("c1")).toBe(false);
    setMuted("c1", true);
    expect(isMuted("c1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONV_PREFS_KEY)!)).toEqual({ c1: { muted: true } });
    setMuted("c1", false);
    expect(isMuted("c1")).toBe(false);
    expect(JSON.parse(localStorage.getItem(CONV_PREFS_KEY)!)).toEqual({});
  });

  it("变更通知订阅者；坏 JSON 回退空", () => {
    const calls: number[] = [];
    const off = subscribeConvPrefs(() => calls.push(convPrefsVersion()));
    setMuted("c1", true);
    expect(calls).toHaveLength(1);
    off();
    localStorage.setItem(CONV_PREFS_KEY, "{oops");
    resetConvPrefsForTest();
    expect(isMuted("c1")).toBe(false);
  });
});
```

`messageNotify.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Message } from "@heming/shared";
import { notifyIncomingMessage } from "./messageNotify.js";
import { setMuted, resetConvPrefsForTest } from "./convPrefs.js";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  conversationId: "c1",
  senderType: "user",
  senderId: "u2",
  payload: { text: "你好" },
  replyTo: null,
  createdAt: "2026-10-28T01:00:00.000Z",
  recalledAt: null,
  enc: "plain",
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
  useNotificationStore.getState().clearAll();
  useChatStore.setState({
    conversations: [{ id: "c1", type: "direct", peer: { id: "u2", username: "bob", displayName: "鲍勃" }, unreadCount: 0 }],
  });
  (window as unknown as { __heming_notify?: unknown }).__heming_notify = {
    message: vi.fn(),
    onOpen: vi.fn(() => () => {}),
  };
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

describe("messageNotify", () => {
  it("应用内通知 + 系统通知：标题为会话名，系统正文固定，不带消息内容", () => {
    notifyIncomingMessage(msg());
    const item = useNotificationStore.getState().items[0];
    expect(item.title).toBe("鲍勃");
    expect(item.body).toBe("你好");
    expect(window.__heming_notify!.message).toHaveBeenCalledWith({
      title: "鲍勃",
      body: "你有一条新消息",
      conversationId: "c1",
    });
  });

  it("E2E 消息应用内不带正文；系统通知仍固定文案", () => {
    notifyIncomingMessage(msg({ enc: "e2e", payload: { text: "" } }));
    expect(useNotificationStore.getState().items[0].body).toBe("");
    expect(window.__heming_notify!.message).toHaveBeenCalled();
  });

  it("免打扰：应用内与系统通知都不发", () => {
    setMuted("c1", true);
    notifyIncomingMessage(msg());
    expect(useNotificationStore.getState().items).toHaveLength(0);
    expect(window.__heming_notify!.message).not.toHaveBeenCalled();
  });

  it("窗口聚焦时不请求系统通知；桥缺失时静默", () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    notifyIncomingMessage(msg());
    expect(window.__heming_notify!.message).not.toHaveBeenCalled();
    delete (window as unknown as { __heming_notify?: unknown }).__heming_notify;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(() => notifyIncomingMessage(msg({ id: "m2" }))).not.toThrow();
  });
});
```

`chat.test.ts` 追加：

```ts
  it("bumpUnread：同一条消息只计一次，带 at 更新 lastMessageAt", () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 0, lastMessageAt: null }],
    });
    expect(useChatStore.getState().bumpUnread("c1", "2026-10-28T01:00:00.000Z", "m1")).toBe(true);
    expect(useChatStore.getState().bumpUnread("c1", "2026-10-28T01:00:00.000Z", "m1")).toBe(false);
    const c = useChatStore.getState().conversations[0];
    expect(c.unreadCount).toBe(1);
    expect(c.lastMessageAt).toBe("2026-10-28T01:00:00.000Z");
  });

  it("bumpUnread：会话不在本地列表时仍返回「新消息」", () => {
    useChatStore.setState({ conversations: [] });
    expect(useChatStore.getState().bumpUnread("ghost", "2026-10-28T01:00:00.000Z", "m2")).toBe(true);
    expect(useChatStore.getState().bumpUnread("ghost", "2026-10-28T01:00:00.000Z", "m2")).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/convPrefs.test.ts src/lib/messageNotify.test.ts src/store/chat.test.ts --no-file-parallelism`
Expected: FAIL —— 模块不存在 / `bumpUnread` 无返回值与去重。

- [ ] **Step 3: 实现 convPrefs**

`packages/web/src/lib/convPrefs.ts`：

```ts
/**
 * 本机会话偏好（d.39）：目前只有「免打扰」。
 *
 * 不跟设备、不上云：这是本机的提醒偏好，不是会话数据。
 * 免打扰只抑制提醒，不抑制未读——消息照常计数，只是不响。
 */
export const CONV_PREFS_KEY = "heming.convPrefs.v1";

export interface ConvPref {
  muted?: boolean;
}

let cache: Record<string, ConvPref> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): Record<string, ConvPref> {
  if (cache) return cache;
  const out: Record<string, ConvPref> = {};
  try {
    const raw = storage()?.getItem(CONV_PREFS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === "object" && (value as ConvPref).muted === true) {
          out[id] = { muted: true };
        }
      }
    }
  } catch {
    /* 坏 JSON / 隐私模式 → 空表 */
  }
  cache = out;
  return out;
}

function persist(next: Record<string, ConvPref>): void {
  cache = next;
  version += 1;
  try {
    storage()?.setItem(CONV_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* 配额/隐私模式：本次会话生效，刷新丢失 */
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅者异常不影响其它订阅 */
    }
  }
}

export function isMuted(convId: string): boolean {
  return read()[convId]?.muted === true;
}

export function setMuted(convId: string, muted: boolean): void {
  const current = read();
  const next = { ...current };
  if (muted) next[convId] = { muted: true };
  else delete next[convId];
  persist(next);
}

export function convPrefsVersion(): number {
  return version;
}

export function subscribeConvPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试隔离：清掉内存缓存与版本（不动 localStorage）。 */
export function resetConvPrefsForTest(): void {
  cache = null;
  version = 0;
}
```

- [ ] **Step 4: 实现会话标题与桌面通知封装**

`packages/web/src/lib/conversationTitle.ts`：

```ts
import type { Conversation } from "@heming/shared";

/** 三态会话的显示名（通知标题用；与 ChatPage 头部口径一致）。 */
export function conversationTitle(conv: Conversation): string {
  if (conv.type === "direct") return conv.peer.displayName;
  if (conv.type === "agent") return conv.agent.name;
  return `${conv.name}（${conv.memberCount} 人）`;
}
```

`packages/web/src/lib/desktopNotify.ts`：

```ts
export interface DesktopNotifyPayload {
  title: string;
  body: string;
  conversationId?: string;
}

/**
 * 请求桌面主进程弹系统通知。
 *
 * 三个前提缺一不可：有桥（桌面端）、窗口不在前台、调用不抛。
 * 窗口聚焦时应用内通知已经足够，再弹系统通知是噪音。
 */
export function notifyDesktop(payload: DesktopNotifyPayload): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.__heming_notify;
  if (!bridge || typeof bridge.message !== "function") return false;
  if (typeof document !== "undefined" && document.hasFocus()) return false;
  try {
    bridge.message(payload);
    return true;
  } catch {
    return false;
  }
}
```

`packages/web/src/lib/messageNotify.ts`：

```ts
import type { Message } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";
import { isMuted } from "./convPrefs.js";
import { conversationTitle } from "./conversationTitle.js";
import { notifyDesktop } from "./desktopNotify.js";

/**
 * 新消息的唯一提醒入口（聊天页其它会话 / 后台连接共用）。
 *
 * - 免打扰：应用内与系统通知都不发；未读由调用方照常计数；
 * - 应用内通知按 `message:<id>` 去重（push 返回 null 即已存在）；
 * - 系统通知正文固定，不泄露消息内容（E2E 尤其如此）。
 */
export function notifyIncomingMessage(m: Message): void {
  if (isMuted(m.conversationId)) return;
  const conv = useChatStore.getState().conversations.find((c) => c.id === m.conversationId);
  const title = conv ? conversationTitle(conv) : "新消息";
  const pushed = useNotificationStore.getState().push({
    kind: "message",
    key: `message:${m.id}`,
    title,
    ...(m.enc === "e2e" ? {} : m.payload.text ? { body: m.payload.text } : {}),
    conversationId: m.conversationId,
  });
  if (!pushed) return; // 重复提醒已在通知中心存在
  notifyDesktop({ title, body: "你有一条新消息", conversationId: m.conversationId });
}
```

`packages/web/src/types/heming.d.ts` 的 `interface Window` 里加：

```ts
    /** 内部：桌面端系统通知桥（preload 暴露；浏览器里 undefined）。 */
    __heming_notify?: {
      message: (payload: { title: string; body: string; conversationId?: string }) => void;
      onOpen: (cb: (conversationId: string | null) => void) => () => void;
    };
```

- [ ] **Step 5: 改 `bumpUnread`**

`store/chat.ts` 接口：

```ts
  /** 未读 +1；返回「这条消息是否第一次被处理」（按 messageId 去重）。 */
  bumpUnread: (convId: string, at?: string, messageId?: string) => boolean;
```

模块级（`create` 之前）加：

```ts
/** 进程内已处理的入站消息 id（多连接/页面切换重叠时防止重复计未读）。 */
const seenIncoming = new Set<string>();
const SEEN_INCOMING_CAP = 500;
```

实现：

```ts
  bumpUnread(convId, at, messageId) {
    if (messageId) {
      if (seenIncoming.has(messageId)) return false;
      seenIncoming.add(messageId);
      if (seenIncoming.size > SEEN_INCOMING_CAP) {
        const oldest = seenIncoming.values().next().value;
        if (oldest !== undefined) seenIncoming.delete(oldest);
      }
    }
    const list = get().conversations;
    if (!list.some((c) => c.id === convId)) return true; // 列表未加载：交给 loadWorkspace 补未读
    set({
      conversations: list.map((c) =>
        c.id === convId
          ? {
              ...c,
              unreadCount: (c.unreadCount ?? 0) + 1,
              ...(at !== undefined ? { lastMessageAt: at } : {}),
            }
          : c,
      ),
    });
    return true;
  },
```

- [ ] **Step 6: ChatPage 复用共享通知**

- 删除本地 `convTitleOf` 与 `notifyIncomingMessage`。
- 顶部 import `notifyIncomingMessage`。
- 其它会话分支改为：

```tsx
        } else if (e.type === "message_new") {
          // 他会话的新消息：未读 +1（A12：自己发的不算）+ 进通知中心
          if (e.message.senderId !== useAuthStore.getState().user?.id) {
            if (useChatStore.getState().bumpUnread(e.message.conversationId, e.message.createdAt, e.message.id)) {
              notifyIncomingMessage(e.message);
            }
          }
        }
```

- 若 `convTitleOf` 仍被其它代码引用则保留；本计划假定只有通知使用（实现前 grep 确认）。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/convPrefs.test.ts src/lib/messageNotify.test.ts src/store/chat.test.ts --no-file-parallelism`
Expected: PASS。

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism`
Expected: PASS（既有通知用例仍绿）。

- [ ] **Step 8: 提交**

```bash
git add packages/web/src/lib/convPrefs.ts packages/web/src/lib/conversationTitle.ts packages/web/src/lib/desktopNotify.ts packages/web/src/lib/messageNotify.ts packages/web/src/store/chat.ts packages/web/src/components/ChatPage.tsx packages/web/src/types/heming.d.ts packages/web/src/lib/convPrefs.test.ts packages/web/src/lib/messageNotify.test.ts packages/web/src/store/chat.test.ts
git commit -m "feat(web): 消息提醒入口收敛到共享层，含去重与免打扰（d.39）"
```

---

### Task 2: 后台连接与系统通知点击回跳

**Files:**
- Create: `packages/web/src/lib/backgroundMessages.ts`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/src/lib/backgroundMessages.test.ts`（新建）、`packages/web/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `bumpUnread` / `notifyIncomingMessage` / `clearUnread`。
- Produces: `handleBackgroundEvent(e)`（纯函数）与 `useBackgroundMessages(active)`。

- [ ] **Step 1: 写失败的测试**

`backgroundMessages.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Message } from "@heming/shared";
import { handleBackgroundEvent } from "./backgroundMessages.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";
import { resetConvPrefsForTest } from "./convPrefs.js";

const msg = (id: string, text: string): Message => ({
  id,
  conversationId: "c1",
  senderType: "user",
  senderId: "u2",
  payload: { text },
  replyTo: null,
  createdAt: "2026-10-28T02:00:00.000Z",
  recalledAt: null,
  enc: "plain",
});

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
  useNotificationStore.getState().clearAll();
  useAuthStore.setState({ user: { id: "u1", username: "alice", displayName: "爱丽丝" } });
  useChatStore.setState({
    conversations: [{ id: "c1", type: "direct", peer: { id: "u2", username: "bob", displayName: "鲍勃" }, unreadCount: 0, lastMessageAt: null }],
    loadWorkspace: vi.fn(async () => {}),
  });
});

describe("backgroundMessages", () => {
  it("他人消息：未读 +1、最近活跃更新、通知一次", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("m1", "你好") });
    const c = useChatStore.getState().conversations[0];
    expect(c.unreadCount).toBe(1);
    expect(c.lastMessageAt).toBe("2026-10-28T02:00:00.000Z");
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });

  it("重复消息 id 不重复提醒；自己发的消息忽略", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("m1", "你好") });
    handleBackgroundEvent({ type: "message_new", message: msg("m1", "你好") });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);

    handleBackgroundEvent({ type: "message_new", message: { ...msg("m2", "我发的"), senderId: "u1" } });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
  });

  it("read_update（自己）清零并写 lastReadAt", () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer: { id: "u2", username: "bob", displayName: "鲍勃" }, unreadCount: 3, lastReadAt: null }],
    });
    handleBackgroundEvent({ type: "read_update", conversationId: "c1", userId: "u1", at: "2026-10-28T03:00:00.000Z" });
    const c = useChatStore.getState().conversations[0];
    expect(c.unreadCount).toBe(0);
    expect(c.lastReadAt).toBe("2026-10-28T03:00:00.000Z");
  });

  it("未知会话：触发一次 loadWorkspace", () => {
    useChatStore.setState({ conversations: [] });
    const load = vi.fn(async () => {});
    useChatStore.setState({ loadWorkspace: load });
    handleBackgroundEvent({ type: "message_new", message: { ...msg("m3", "新会话"), conversationId: "c9" } });
    expect(load).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });
});
```

`App.test.tsx`：顶部加

```ts
vi.mock("./lib/ws.js", () => ({
  connectWs: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
}));
```

新增用例（放在合适位置，复用文件内 `mockFetch`）：

```tsx
  it("非聊天页启用后台连接；系统通知点击回跳到会话", async () => {
    const { connectWs } = await import("./lib/ws.js");
    const onOpenCallbacks: Array<(id: string | null) => void> = [];
    (window as unknown as { __heming_notify?: unknown }).__heming_notify = {
      message: vi.fn(),
      onOpen: (cb: (id: string | null) => void) => {
        onOpenCallbacks.push(cb);
        return () => {};
      },
    };
    mockFetch({ me: alice });
    render(<App />);
    await waitFor(() => expect(vi.mocked(connectWs)).toHaveBeenCalled());
    // 模拟主进程点击通知 → 回传会话 id
    act(() => {
      for (const cb of onOpenCallbacks) cb("c9");
    });
    expect(useUiStore.getState().activeConversationId).toBe("c9");
  });
```

（实际渲染与登录态按 App.test 既有用例的方式准备；若既有用例已把 page 设为 chat，先 `useUiStore.setState({ page: "home" })`。Mock 的连接句柄会贯穿所有既有用例，新增 mock 后需确认原有用例仍绿。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/backgroundMessages.test.ts src/App.test.tsx --no-file-parallelism`
Expected: FAIL —— 模块/hook 不存在。

- [ ] **Step 3: 实现后台事件与 hook**

`packages/web/src/lib/backgroundMessages.ts`：

```ts
import { useEffect } from "react";
import type { WsServerEvent } from "@heming/shared";
import { connectWs } from "./ws.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { notifyIncomingMessage } from "./messageNotify.js";

/**
 * 后台连接的事件处理（非聊天页）：只做感知，不解密正文。
 *
 * 未读/最近活跃/通知三件事与聊天页「其它会话」路径共用同一套 store 与提醒入口，
 * 避免两处口径分叉。
 */
export function handleBackgroundEvent(e: WsServerEvent): void {
  const me = useAuthStore.getState().user?.id;
  if (e.type === "message_new") {
    const m = e.message;
    if (m.senderId === me) return;
    const fresh = useChatStore.getState().bumpUnread(m.conversationId, m.createdAt, m.id);
    if (fresh) notifyIncomingMessage(m);
    if (!useChatStore.getState().conversations.some((c) => c.id === m.conversationId)) {
      void useChatStore.getState().loadWorkspace().catch(() => {});
    }
  } else if (e.type === "read_update") {
    if (e.userId === me) useChatStore.getState().clearUnread(e.conversationId, e.at);
  }
}

/** 非聊天页驻留的后台连接：进入聊天页即关闭，交给 ChatPage 自己的连接。 */
export function useBackgroundMessages(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const handle = connectWs({
      onEvent: (e) => {
        if (alive) handleBackgroundEvent(e);
      },
      onOpen: () => {
        void useChatStore.getState().loadWorkspace().catch(() => {});
      },
    });
    return () => {
      alive = false;
      handle.close();
    };
  }, [active]);
}
```

- [ ] **Step 4: 接到 AppShell**

`App.tsx` import `useBackgroundMessages`；在 `const page = ...` 之后调用：

```tsx
  // 非聊天页时由 App 壳保持一条后台连接：离开聊天页也能收到未读与提醒。
  useBackgroundMessages(Boolean(authUser) && page !== "chat");

  // 系统通知点击 → 主进程回传会话 id → 打开会话
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_notify : undefined;
    if (!bridge?.onOpen) return;
    return bridge.onOpen((id) => {
      if (id) useUiStore.getState().openConversation(id);
    });
  }, []);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/backgroundMessages.test.ts src/App.test.tsx --no-file-parallelism`
Expected: PASS（既有 App 用例不被后台连接 mock 破坏）。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/lib/backgroundMessages.ts packages/web/src/lib/backgroundMessages.test.ts packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "feat(web): 非聊天页后台消息通道与通知回跳（d.39）"
```

---

### Task 3: 桌面系统通知桥

**Files:**
- Create: `packages/desktop/notify-bridge.js`
- Create: `packages/desktop/notify-bridge.test.js`
- Modify: `packages/desktop/preload.js`
- Modify: `packages/desktop/preload.test.js`
- Modify: `packages/desktop/main.js`
- Modify: `packages/desktop/package.json`（`build.files` + `test`/`typecheck` 脚本）

**Interfaces:**
- Consumes: Task 1 的 `window.__heming_notify` 类型。
- Produces: `registerNotifyIpc(ipcMain, { Notification, BrowserWindow })`；IPC `notify:message` / `notify:open`。

- [ ] **Step 1: 写失败的测试**

`notify-bridge.test.js`：

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { registerNotifyIpc } = require("./notify-bridge");

function fakeEnv(opts = {}) {
  const shown = [];
  const sent = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => opts.minimized === true,
    restore: () => { win.restored = true; },
    show: () => { win.shown = true; },
    focus: () => { win.focused = true; },
    webContents: { send: (...args) => sent.push(args) },
  };
  class FakeNotification {
    constructor(payload) { this.payload = payload; this.handlers = {}; this.shown = false; }
    static isSupported() { return opts.supported !== false; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { this.shown = true; shown.push(this); }
  }
  const ipcMain = { on: (ch, fn) => { ipcMain[ch] = fn; } };
  return {
    shown, sent, win,
    ipcMain,
    deps: { Notification: FakeNotification, BrowserWindow: { getAllWindows: () => (opts.noWindow ? [] : [win]) } },
  };
}

test("合法通知：显示、点击聚焦并回传会话 id", () => {
  const env = fakeEnv({ minimized: true });
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" });
  assert.equal(env.shown.length, 1);
  assert.deepEqual(env.shown[0].payload, { title: "鲍勃", body: "你有一条新消息" });
  env.shown[0].handlers.click();
  assert.equal(env.win.restored, true);
  assert.equal(env.win.shown, true);
  assert.equal(env.win.focused, true);
  assert.deepEqual(env.sent[0], ["notify:open", "c1"]);
});

test("不支持通知时跳过；无窗口时点击不崩", () => {
  const env = fakeEnv({ supported: false });
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "x", body: "y" });
  assert.equal(env.shown.length, 0);

  const env2 = fakeEnv({ noWindow: true });
  registerNotifyIpc(env2.ipcMain, env2.deps);
  env2.ipcMain["notify:message"]({}, { title: "x", body: "y" });
  assert.doesNotThrow(() => env2.shown[0].handlers.click());
});

test("脏输入被清洗：缺标题用默认、超长截断、非字符串忽略", () => {
  const env = fakeEnv();
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "  ".repeat(100), body: 123, conversationId: 7 });
  const p = env.shown[0].payload;
  assert.equal(p.title, "新消息");
  assert.equal(p.body, "你有一条新消息");
  env.shown[0].handlers.click();
  assert.deepEqual(env.sent, []);
});

test("源码不引入任何网络能力（红线）", () => {
  const src = fs.readFileSync(path.join(__dirname, "notify-bridge.js"), "utf8");
  assert.ok(!/require\(\s*["'](node:)?(http|https|net|dgram|tls)["']\s*\)/.test(src));
});
```

`preload.test.js` 增加：

```js
test("preload 暴露 __heming_notify（系统通知桥）并可取消订阅", () => {
  const listeners = [];
  const exposed = loadExposed({
    "notify:message": () => {},
  });
  // 现有 loadExposed 的 ipc 桩需要支持 on/removeListener；按文件内桩形状补齐
  assert.ok(exposed.__heming_notify);
  assert.equal(typeof exposed.__heming_notify.message, "function");
  assert.equal(typeof exposed.__heming_notify.onOpen, "function");
});
```

（`loadExposed` 的 `stubIpc` 目前没有 `on/removeListener`；在测试桩里补上，保存监听器以断言 `onOpen` 注册与取消。不要改生产实现迁就测试。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && node --test notify-bridge.test.js preload.test.js`
Expected: FAIL —— 模块不存在 / 无桥。

- [ ] **Step 3: 实现主进程桥**

`packages/desktop/notify-bridge.js`：

```js
"use strict";
/**
 * 系统通知桥（d.39）。
 *
 * 渲染层只传「标题 / 固定正文 / 会话 id」，主进程负责显示与点击聚焦；
 * 通知正文不包含消息内容（锁屏被别人看到也不泄露）。
 * 红线：本模块只碰系统通知，不引入任何网络能力（测试钉死）。
 */

const TITLE_MAX = 80;
const BODY_MAX = 160;

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param ipcMain Electron ipcMain
 * @param {{Notification: any, BrowserWindow: any}} deps 注入以便纯 node 测试
 */
function registerNotifyIpc(ipcMain, { Notification, BrowserWindow }) {
  ipcMain.on("notify:message", (_event, payload) => {
    const title = cleanText(payload && payload.title, TITLE_MAX) || "新消息";
    const body = cleanText(payload && payload.body, BODY_MAX) || "你有一条新消息";
    const conversationId =
      typeof payload?.conversationId === "string" && payload.conversationId
        ? payload.conversationId
        : null;
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      notification.on("click", () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (conversationId) win.webContents.send("notify:open", conversationId);
      });
      notification.show();
    } catch {
      /* 通知失败不影响消息主流程 */
    }
  });
}

module.exports = { registerNotifyIpc, cleanText };
```

- [ ] **Step 4: 主进程接线**

`main.js` 顶部 require 区加 `const { registerNotifyIpc } = require("./notify-bridge");`；
`app.whenReady` 内、`createWindow()` 之前（与其它 IPC 一起）加：

```js
    // 系统通知桥（d.39）：消息提醒只在窗口不在前台时由渲染层请求
    registerNotifyIpc(ipcMain, { Notification, BrowserWindow });
```

`package.json`：
- `build.files` 在 `export-fs.js` 后加 `"notify-bridge.js",`；
- `typecheck` 加 `node --check notify-bridge.js &&`；
- `test` 加 `node --test notify-bridge.test.js &&`（位置与既有文件一致）。

- [ ] **Step 5: preload 暴露**

`preload.js` 末尾加：

```js
// —— 系统通知桥（d.39）——
// 消息提醒：窗口不在前台时由渲染层请求主进程弹系统通知；点击主进程聚焦窗口并回传会话 id。
contextBridge.exposeInMainWorld("__heming_notify", {
  message: (payload) => {
    ipcRenderer.send("notify:message", payload);
  },
  onOpen: (callback) => {
    const listener = (_event, conversationId) => callback(conversationId ?? null);
    ipcRenderer.on("notify:open", listener);
    return () => ipcRenderer.removeListener("notify:open", listener);
  },
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/desktop && pnpm test`
Expected: PASS（含 notify-bridge 4 例与 preload 新例）。

- [ ] **Step 7: 提交**

```bash
git add packages/desktop/notify-bridge.js packages/desktop/notify-bridge.test.js packages/desktop/preload.js packages/desktop/preload.test.js packages/desktop/main.js packages/desktop/package.json
git commit -m "feat(desktop): 系统通知桥与点击回跳（d.39）"
```

---

### Task 4: 会话信息卡的免打扰开关

**Files:**
- Modify: `packages/web/src/components/ChatInfoCard.tsx`
- Modify: `packages/web/src/components/icons.tsx`
- Test: `packages/web/src/components/ChatInfoCard.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `isMuted` / `setMuted` / 订阅。
- Produces: `role="switch"`、`aria-checked`、文案「免打扰」/「已开启免打扰」。

- [ ] **Step 1: 写失败的测试**

`ChatInfoCard.test.tsx` 追加：

```tsx
  it("免打扰开关：读写本机偏好，aria-checked 与文案随动", () => {
    localStorage.clear();
    resetConvPrefsForTest();
    const { unmount } = render(<ChatInfoCard conv={conv} onClose={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "免打扰" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("免打扰")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("已开启免打扰")).toBeInTheDocument();
    expect(isMuted("c1")).toBe(true);

    unmount();
    resetConvPrefsForTest();
    localStorage.clear();
  });
```

（`conv` 用文件内既有夹具；`isMuted`/`resetConvPrefsForTest` 从 lib 导入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/ChatInfoCard.test.tsx --no-file-parallelism`
Expected: FAIL —— 无开关。

- [ ] **Step 3: 图标**

`icons.tsx` 加：

```tsx
/** 铃铛：免打扰开关。 */
export const BellIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
  </svg>
);
```

- [ ] **Step 4: 信息卡开关**

`ChatInfoCard.tsx`：
- import `useSyncExternalStore`、`BellIcon`、`convPrefsVersion/subscribeConvPrefs/isMuted/setMuted`。
- 组件内：

```tsx
  // 偏好变更时刷新（开关状态不是 React state，订阅版本号驱动重渲染）
  useSyncExternalStore(subscribeConvPrefs, convPrefsVersion, () => 0);
  const muted = isMuted(conv.id);
```

- 在底部说明上方加一行：

```tsx
      <button
        type="button"
        role="switch"
        aria-checked={muted}
        aria-label="免打扰"
        onClick={() => setMuted(conv.id, !muted)}
        className={`mt-2.5 flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-[12px] transition-colors ${
          muted ? "border-[#f0d58c] bg-[#fff7e6] text-[#b45309]" : "border-line text-[#555] hover:bg-[#fafafa]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <BellIcon width={15} height={15} />
          免打扰
        </span>
        <span className="text-[11px]">{muted ? "已开启免打扰" : "关闭"}</span>
      </button>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/ChatInfoCard.test.tsx --no-file-parallelism`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/components/ChatInfoCard.tsx packages/web/src/components/icons.tsx packages/web/src/components/ChatInfoCard.test.tsx
git commit -m "feat(chat): 会话信息卡按会话免打扰（d.39）"
```

---

### Task 5: 版本、日志、文档与门禁

**Files:**
- Modify: 五个 `package.json`、`README.md`（脚本）
- Modify: `CHANGELOG.md`、`packages/web/src/generated/changelog.ts`
- Modify: `docs/HANDOFF.md`、`docs/INDEX.md`

- [ ] **Step 1: 全量门禁**

Run:

```bash
pnpm -r build && pnpm -r --workspace-concurrency=1 test
```

Expected: 全绿（desktop 的 `node --check` 会覆盖 notify-bridge）。

- [ ] **Step 2: 升版本**

Run: `node scripts/bump-version.mjs auto feature`
Expected: `d.38.1.10.0 → d.39.1.10.0`。

- [ ] **Step 3: CHANGELOG（单行 bullet）**

```markdown
## d.39.1.10.0（2026-10-28）— 离开聊天页，也不再失联

补齐 IM 最基础的一层信任：消息在哪个页面都能被感知到。

- **后台消息通道**：非聊天页由 App 壳保持一条 WS，只做未读、最近活跃与提醒；进入聊天页自动让位给聊天页连接，消息按 id 去重。
- **桌面系统通知**：窗口不在前台时弹系统通知，正文固定「你有一条新消息」，不显示内容；点击聚焦窗口并打开对应会话。
- **按会话免打扰**：会话信息卡新增免打扰开关；只抑制提醒，不抑制未读、不丢消息。
- **隐私边界**：后台不解密正文；系统通知不显示消息内容；偏好只存本机。
- 明确未做：完整会话列表、全局消息搜索、presence、托盘常驻（下一轮）。
```

- [ ] **Step 4: 生成更新日志**

Run: `node scripts/build-changelog.mjs`

- [ ] **Step 5: 文档**

- HANDOFF：头部版本 d.39.1.10.0；§2 版本/测试行用实际门禁数字；里程碑追加第 37 条（后台通道/系统通知/免打扰/隐私边界/未做项）；§5 下一轮指向会话列表与全局搜索；§6 补「后台只感知不解密」「系统通知不含正文」「免打扰只抑制提醒」三条边界。
- INDEX：设计规格表加 d.39 spec 行；调研表加 `research/2026-10-28-ai-im-ux-pain-points.md`。

- [ ] **Step 6: 再跑门禁**

Run: `pnpm -r build && pnpm -r --workspace-concurrency=1 test`
Expected: 全绿（version-sync / changelog-sync）。

- [ ] **Step 7: 提交**

```bash
git add package.json packages/*/package.json README.md CHANGELOG.md packages/web/src/generated/changelog.ts docs/HANDOFF.md docs/INDEX.md docs/superpowers/specs/2026-10-28-d39-global-message-awareness.md docs/superpowers/plans/2026-10-28-d39-global-message-awareness.md docs/research/2026-10-28-ai-im-ux-pain-points.md
git commit -m "docs(release): d.39.1.10.0 全域消息感知，门禁全绿"
```

---

## 自检

- 规格 A/B/C/D 分别落到 Task 2 / Task 3 / Task 1+4 / Task 1。
- 后台不解密、系统通知不含正文、免打扰只抑制提醒——三条隐私/语义边界在代码与文档都有落点。
- 去重：`bumpUnread` 同 id 只处理一次，聊天页与后台共用；通知中心本身按 `message:<id>` 二次兜底。
- 版本 d.39.1.10.0；desktop 新文件进打包白名单与门禁。
- 已知边界：页面切换瞬间两条 WS 短暂重叠，由消息 id 去重；后台连接不解密，进入聊天页后补齐正文。
