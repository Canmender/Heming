# d.40 会话中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加持久「会话」页：全部未归档会话按置顶 + 最近活跃排序，未读/草稿/免打扰一眼可见，行内可置顶、免打扰、归档。

**Architecture:** 纯前端。`convPrefs` 增加 `pinned`；新 `ConversationsPage` 读取 chat store + 本机明文缓存生成预览；导航新增 `conversations` 页（Alt+9）并接入 App/NavRail/设置区；首页「最近会话」加「全部会话」入口。

**Tech Stack:** React + zustand + `useSyncExternalStore`、现有 `archiveConversation`、`msgCache`、vitest/jsdom。

**Spec:** `docs/superpowers/specs/2026-10-29-d40-conversation-center.md`

## Global Constraints

- 只读本机数据生成预览；**不上传偏好、不新增服务端接口、不把正文送到云端**。
- 置顶/免打扰只存本机 `heming.convPrefs.v1`；免打扰只抑制提醒，不影响未读。
- 归档沿用现有 `archiveConversation` 与归档页；归档后本页移除，归档页可见。
- 老页快捷键数字不动；新页固定 **Alt+9**；个性化导航顺序缺项自动补末尾。
- 视觉规范：无 emoji、细线 SVG、浅灰分割线、中文文案。
- 版本：`node scripts/bump-version.mjs auto feature`（`d.39.1.11.0` ⇒ **`d.40.1.11.0`**）。
- 门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `web/src/lib/convPrefs.ts` | 修改 | 增加 `pinned`；muted/pinned 字段互不覆盖 |
| `web/src/lib/convPrefs.test.ts` | 修改 | pinned 读写、互不覆盖、订阅 |
| `web/src/components/ConversationsPage.tsx` | 新建 | 会话列表、搜索、排序、预览、行操作 |
| `web/src/components/ConversationsPage.test.tsx` | 新建 | 列表/排序/预览/搜索/操作/归档/打开 |
| `web/src/components/icons.tsx` | 修改 | `SessionsIcon`、`PinIcon`、`BellOffIcon` |
| `web/src/store/ui.ts` | 修改 | `Page`/`NavPage` 增加 `conversations`；默认顺序插入 |
| `web/src/App.tsx` | 修改 | 快捷键第 9 项、页面路由 |
| `web/src/components/NavRail.tsx` | 修改 | 「会话」项、Alt9、图标 |
| `web/src/components/SettingsPage.tsx` | 修改 | `NAV_LABELS` 增加「会话」 |
| `web/src/components/HomePage.tsx` | 修改 | 「全部会话」入口 |
| 测试 | 修改 | NavRail / SettingsPage / HomePage / App 相关断言 |

---

### Task 1: `convPrefs` 支持置顶

**Files:**
- Modify: `packages/web/src/lib/convPrefs.ts`
- Test: `packages/web/src/lib/convPrefs.test.ts`

**Interfaces:**
- Produces: `isPinned(convId)`, `setPinned(convId, pinned)`；`ConvPref { muted?: boolean; pinned?: boolean }`。

- [ ] **Step 1: 写失败的测试**

在 `convPrefs.test.ts` 追加：

```ts
  it("置顶与免打扰互不覆盖", () => {
    setPinned("c1", true);
    expect(isPinned("c1")).toBe(true);
    expect(isMuted("c1")).toBe(false);

    setMuted("c1", true);
    expect(isPinned("c1")).toBe(true);
    expect(isMuted("c1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONV_PREFS_KEY)!)).toEqual({
      c1: { pinned: true, muted: true },
    });

    setPinned("c1", false);
    expect(isPinned("c1")).toBe(false);
    expect(isMuted("c1")).toBe(true);

    setMuted("c1", false);
    expect(JSON.parse(localStorage.getItem(CONV_PREFS_KEY)!)).toEqual({});
  });

  it("坏数据里的 pinned 只认 true", () => {
    localStorage.setItem(
      CONV_PREFS_KEY,
      JSON.stringify({ a: { pinned: "yes" }, b: { pinned: true }, c: null }),
    );
    resetConvPrefsForTest();
    expect(isPinned("a")).toBe(false);
    expect(isPinned("b")).toBe(true);
    expect(isPinned("c")).toBe(false);
  });
```

import 补 `isPinned, setPinned`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/convPrefs.test.ts --no-file-parallelism`
Expected: FAIL —— 没有 `isPinned`/`setPinned`。

- [ ] **Step 3: 实现**

`convPrefs.ts`：

```ts
export interface ConvPref {
  muted?: boolean;
  pinned?: boolean;
}
```

`read()` 的归一化改为：

```ts
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const src = value as ConvPref;
        const pref: ConvPref = {};
        if (src.muted === true) pref.muted = true;
        if (src.pinned === true) pref.pinned = true;
        if (pref.muted || pref.pinned) out[id] = pref;
      }
```

`setMuted` / `setPinned` 共用一个字段写入器：

```ts
function setFlag(convId: string, key: "muted" | "pinned", on: boolean): void {
  const current = read();
  const next = { ...current };
  const entry: ConvPref = { ...(next[convId] ?? {}) };
  if (on) entry[key] = true;
  else delete entry[key];
  if (entry.muted || entry.pinned) next[convId] = entry;
  else delete next[convId];
  persist(next);
}

export function isPinned(convId: string): boolean {
  return read()[convId]?.pinned === true;
}

export function setMuted(convId: string, muted: boolean): void {
  setFlag(convId, "muted", muted);
}

export function setPinned(convId: string, pinned: boolean): void {
  setFlag(convId, "pinned", pinned);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/convPrefs.test.ts --no-file-parallelism`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/convPrefs.ts packages/web/src/lib/convPrefs.test.ts
git commit -m "feat(chat): 会话偏好支持置顶且与免打扰互不覆盖（d.40）"
```

---

### Task 2: 会话中心页面

**Files:**
- Create: `packages/web/src/components/ConversationsPage.tsx`
- Create: `packages/web/src/components/ConversationsPage.test.tsx`
- Modify: `packages/web/src/components/icons.tsx`

**Interfaces:**
- Consumes: `convLabel`（`ChatPage.tsx` 导出）、`msgCache`（`lib/e2eSession.ts`）、`convPrefs`、`drafts`、`archiveConversation`。
- Produces: `<ConversationsPage />`，无 props；页面内 `aria-label="搜索会话"` 输入框。

- [ ] **Step 1: 写失败的测试**

`ConversationsPage.test.tsx`（新文件）：

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Conversation, User } from "@heming/shared";
import { ConversationsPage } from "./ConversationsPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { resetConvPrefsForTest, setPinned } from "../lib/convPrefs.js";
import { clearDraft, setDraft } from "../lib/drafts.js";
import { msgCache } from "../lib/e2eSession.js";
import { archiveConversation } from "../lib/api.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, archiveConversation: vi.fn(async () => {}) };
});

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const bob: User = { id: "u2", username: "bob", displayName: "鲍勃" };

const direct = (id: string, lastMessageAt: string | null = null): Conversation =>
  ({ id, type: "direct", peer: bob, unreadCount: 0, lastMessageAt }) as Conversation;

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
  vi.mocked(archiveConversation).mockClear();
  useUiStore.setState({ page: "conversations", activeConversationId: null, openTabs: [] });
  useChatStore.setState({
    conversations: [],
    messages: {},
    workspaceReady: true,
    workspaceError: null,
    loadWorkspace: vi.fn(async () => {}),
  });
});

describe("ConversationsPage", () => {
  it("只列未归档；置顶优先，其次按 lastMessageAt 降序", () => {
    const rows = [
      direct("c-old", "2026-10-20T00:00:00.000Z"),
      direct("c-new", "2026-10-25T00:00:00.000Z"),
      { ...direct("c-arch", "2026-10-26T00:00:00.000Z"), archivedAt: "2026-10-27T00:00:00.000Z" },
      direct("c-pin", "2026-10-01T00:00:00.000Z"),
    ] as Conversation[];
    setPinned("c-pin", true);
    useChatStore.setState({ conversations: rows, messages: {} });

    render(<ConversationsPage />);
    const buttons = screen.getAllByRole("button", { name: /打开会话/ });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "打开会话 鲍勃", // pinned
      "打开会话 鲍勃", // new
      "打开会话 鲍勃", // old
    ]);
    expect(screen.queryByText(/c-arch/)).not.toBeInTheDocument();
  });
```

（上面的断言只用名字区分不了三行；请给 direct 夹具加不同 peer 名，或断言行内 `data-conv-id` 属性。建议给每行加 `data-conv-id={c.id}`，测试用 `container.querySelectorAll('[data-conv-id]')` 断言顺序为 `["c-pin","c-new","c-old"]`。）

继续加：

```tsx
  it("预览优先级：草稿 > 已加载最后一条 > 本机缓存 > 点击查看消息 > 暂无消息", () => {
    const rows = [
      direct("c-draft", "2026-10-25T00:00:00.000Z"),
      direct("c-loaded", "2026-10-25T00:00:00.000Z"),
      direct("c-cache", "2026-10-25T00:00:00.000Z"),
      direct("c-unloaded", "2026-10-25T00:00:00.000Z"),
      direct("c-empty", null),
    ];
    setDraft("c-draft", "写到一半");
    msgCache.append("c-cache", {
      id: "cm1",
      senderId: "u2",
      at: Date.parse("2026-10-25T00:00:00.000Z"),
      plain: { kind: "text", text: "缓存里的正文" },
    });
    useChatStore.setState({
      conversations: rows,
      messages: {
        "c-loaded": [
          {
            id: "m1",
            conversationId: "c-loaded",
            senderType: "user",
            senderId: "u2",
            payload: { text: "已加载正文" },
            replyTo: null,
            createdAt: "2026-10-25T00:00:00.000Z",
            recalledAt: null,
            enc: "plain",
          },
        ],
      },
    });

    render(<ConversationsPage />);
    expect(screen.getByText(/草稿：写到一半/)).toBeInTheDocument();
    expect(screen.getByText("已加载正文")).toBeInTheDocument();
    expect(screen.getByText("缓存里的正文")).toBeInTheDocument();
    expect(screen.getByText("点击查看消息")).toBeInTheDocument();
    expect(screen.getByText("暂无消息")).toBeInTheDocument();
    clearDraft("c-draft");
  });

  it("搜索按会话名过滤；置顶/免打扰切换即时生效；归档调用 API", async () => {
    support("c1", "张三");
    support("c2", "李四");
    render(<ConversationsPage />);
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "李四" } });
    expect(screen.queryByText("张三")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "置顶 李四" }));
    expect(screen.getByRole("button", { name: "取消置顶 李四" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "免打扰 李四" }));
    expect(screen.getByRole("button", { name: "取消免打扰 李四" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "归档 李四" }));
    });
    expect(archiveConversation).toHaveBeenCalledWith("c2", true);
    await waitFor(() => expect(useChatStore.getState().loadWorkspace).toHaveBeenCalled());
  });
});
```

（`support` 是测试内辅助：建一个 direct 会话并把 peer 名设为传入值。实现时按现有 fixture 风格写，别引用未定义函数。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/ConversationsPage.test.tsx --no-file-parallelism`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 图标**

`icons.tsx` 加：

```tsx
/** 会话中心：列表。 */
export const SessionsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h10" />
  </svg>
);

/** 置顶。 */
export const PinIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 4h6l-1 6 3 3H7l3-3-1-6z" />
    <path d="M12 13v7" />
  </svg>
);

/** 免打扰（铃铛加斜线）。 */
export const BellOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 0 0-9.3-5" />
    <path d="M6.3 6.3A6 6 0 0 0 6 8c0 7-3 7-3 9h12" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    <path d="M3 3l18 18" />
  </svg>
);
```

- [ ] **Step 4: 实现页面**

`ConversationsPage.tsx`：

```tsx
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Conversation, Message } from "@heming/shared";
import { archiveConversation } from "../lib/api.js";
import { msgCache } from "../lib/e2eSession.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { hasDraft, getDraft, subscribeDrafts, draftsVersion } from "../lib/drafts.js";
import {
  convPrefsVersion,
  isMuted,
  isPinned,
  setMuted,
  setPinned,
  subscribeConvPrefs,
} from "../lib/convPrefs.js";
import { Avatar } from "./Avatar.js";
import { convLabel } from "./ChatPage.js";
import { ArchiveIcon, BellIcon, BellOffIcon, PinIcon, SearchIcon } from "./icons.js";

/** 预览截尾：列表一行只给一个大概，完整正文在会话里。 */
function clipPreview(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : chars.join("");
}

/** 本机解密缓存里最后一条可展示消息；reaction/chaindist/chunk/error 不算。 */
function cachedPreview(convId: string): { text: string; at: number } | null {
  const list = msgCache.list(convId);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const p = list[i].plain;
    if (p.kind === "text") return { text: p.text?.trim() || "(空消息)", at: list[i].at };
    if (p.kind === "file") return { text: "(附件)", at: list[i].at };
    if (p.kind === "forward") return { text: p.text?.trim() || "(转发消息)", at: list[i].at };
  }
  return null;
}

function lastLoaded(messages: Record<string, Message[]>, convId: string): Message | undefined {
  const list = messages[convId];
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function previewOf(conv: Conversation, messages: Record<string, Message[]>): string {
  const draft = hasDraft(conv.id) ? getDraft(conv.id) : "";
  if (draft) return `草稿：${clipPreview(draft)}`;
  const last = lastLoaded(messages, conv.id);
  if (last) {
    return last.recalledAt != null ? "消息已撤回" : clipPreview(last.payload.text || "(附件)");
  }
  const cached = cachedPreview(conv.id);
  if (cached) return clipPreview(cached.text);
  return conv.lastMessageAt ? "点击查看消息" : "暂无消息";
}

function timeOf(conv: Conversation, messages: Record<string, Message[]>): string {
  const iso =
    conv.lastMessageAt ??
    (() => {
      const last = lastLoaded(messages, conv.id);
      if (last) return last.createdAt;
      const cached = cachedPreview(conv.id);
      return cached ? new Date(cached.at).toISOString() : null;
    })();
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

export function ConversationsPage() {
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const workspaceReady = useChatStore((s) => s.workspaceReady);
  const workspaceError = useChatStore((s) => s.workspaceError);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const openConversation = useUiStore((s) => s.openConversation);

  // 偏好与草稿变化都要重算预览/排序
  useSyncExternalStore(subscribeConvPrefs, convPrefsVersion, () => 0);
  useSyncExternalStore(subscribeDrafts, draftsVersion, () => 0);

  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadWorkspace().catch(() => {});
  }, [loadWorkspace]);

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return conversations
      .filter((c) => !c.archivedAt)
      .filter((c) => !keyword || convLabel(c).name.toLowerCase().includes(keyword))
      .sort((a, b) => {
        const ap = isPinned(a.id) ? 1 : 0;
        const bp = isPinned(b.id) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const ax = a.lastMessageAt ?? "";
        const bx = b.lastMessageAt ?? "";
        return ax === bx ? 0 : ax < bx ? 1 : -1;
      });
  }, [conversations, query]);

  const active = conversations.filter((c) => !c.archivedAt);
  const unread = active.reduce((n, c) => n + (c.unreadCount ?? 0), 0);

  const archive = async (conv: Conversation) => {
    if (busyId) return;
    setBusyId(conv.id);
    setNotice(null);
    try {
      await archiveConversation(conv.id, true);
      await loadWorkspace();
    } catch (err) {
      setNotice(`归档失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-[17px] font-extrabold">会话</h1>
          <span className="text-[11px] text-muted">
            {active.length} 个会话{unread > 0 ? ` · ${unread} 条未读` : ""}
          </span>
        </div>
        <div className="relative mt-3 max-w-[420px]">
          <SearchIcon width={15} height={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#bbb]" />
          <input
            aria-label="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            className="w-full rounded-lg border border-line py-1.5 pl-8 pr-3 text-[12px] outline-none focus:border-[#bbb]"
          />
        </div>
        {notice && (
          <div role="status" className="mt-2 text-[11px] text-red-600">
            {notice}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-3">
        {rows.length === 0 ? (
          !workspaceReady ? (
            workspaceError ? (
              <div className="py-8 text-center text-[12px] text-muted">
                加载失败：{workspaceError}
                <button
                  type="button"
                  className="ml-2 rounded-lg border border-line px-2 py-0.5 text-[11px] hover:bg-[#fafafa]"
                  onClick={() => void loadWorkspace().catch(() => {})}
                >
                  重试
                </button>
              </div>
            ) : (
              <div className="py-8 text-center text-[12px] text-muted">正在加载会话…</div>
            )
          ) : (
            <div className="py-8 text-center text-[12px] text-muted">
              {query.trim() ? `没有匹配「${query.trim()}」的会话` : "还没有会话，去工作区开始"}
            </div>
          )
        ) : (
          <div className="max-w-[720px] space-y-1">
            {rows.map((c) => {
              const label = convLabel(c);
              const pinned = isPinned(c.id);
              const muted = isMuted(c.id);
              const preview = previewOf(c, messages);
              const time = timeOf(c, messages);
              return (
                <div
                  key={c.id}
                  data-conv-id={c.id}
                  className="group flex items-center gap-2 rounded-xl border border-[#ececec] bg-white px-2.5 py-2 shadow-card transition-colors hover:bg-[#fafafa]"
                >
                  <button
                    type="button"
                    aria-label={`打开会话 ${label.name}`}
                    onClick={() => openConversation(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="relative shrink-0">
                      <Avatar user={{ displayName: label.name, avatar: label.avatar }} size={36} />
                      {c.unreadCount > 0 && (
                        <span
                          aria-label={`${c.unreadCount} 条未读`}
                          className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-ink px-1 text-center text-[10px] font-semibold leading-4 text-white"
                        >
                          {c.unreadCount}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{label.name}</span>
                        {pinned && <PinIcon width={12} height={12} className="shrink-0 text-[#b45309]" aria-hidden="true" />}
                        {muted && <BellOffIcon width={12} height={12} className="shrink-0 text-[#b45309]" aria-hidden="true" />}
                      </span>
                      <span className="block truncate text-[11px] text-muted">{preview}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">{time}</span>
                  </button>

                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`${pinned ? "取消置顶" : "置顶"} ${label.name}`}
                      title={pinned ? "取消置顶" : "置顶"}
                      onClick={() => setPinned(c.id, !pinned)}
                      className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
                    >
                      <PinIcon width={14} height={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`${muted ? "取消免打扰" : "免打扰"} ${label.name}`}
                      title={muted ? "取消免打扰" : "免打扰"}
                      onClick={() => setMuted(c.id, !muted)}
                      className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
                    >
                      {muted ? <BellOffIcon width={14} height={14} /> : <BellIcon width={14} height={14} />}
                    </button>
                    <button
                      type="button"
                      aria-label={`归档 ${label.name}`}
                      title="归档"
                      disabled={busyId === c.id}
                      onClick={() => void archive(c)}
                      className="rounded p-1 text-muted hover:bg-[#f3f3f3] disabled:opacity-40"
                    >
                      <ArchiveIcon width={14} height={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

> `useMemo` 的 deps 只写 `[conversations, query]` 时，置顶/草稿变化靠 `useSyncExternalStore` 触发重渲染，但 memo 不会重算。把 `convPrefsVersion()`/`draftsVersion()` 的返回值接出来作为 deps：

```tsx
  const prefsVersion = useSyncExternalStore(subscribeConvPrefs, convPrefsVersion, () => 0);
  const draftVersion = useSyncExternalStore(subscribeDrafts, draftsVersion, () => 0);
  ...
  }, [conversations, query, prefsVersion, draftVersion]);
```

（上面的直接调用只是示意；实现用接出来的两个版本值。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/ConversationsPage.test.tsx --no-file-parallelism`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/components/ConversationsPage.tsx packages/web/src/components/ConversationsPage.test.tsx packages/web/src/components/icons.tsx
git commit -m "feat(chat): 会话中心页——列表、搜索、置顶/免打扰/归档（d.40）"
```

---

### Task 3: 导航与首页入口

**Files:**
- Modify: `packages/web/src/store/ui.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/NavRail.tsx`
- Modify: `packages/web/src/components/SettingsPage.tsx`
- Modify: `packages/web/src/components/HomePage.tsx`
- Test: `NavRail.test.tsx`、`SettingsPage.test.tsx`、`HomePage.test.tsx`

**Interfaces:**
- Produces: `Page`/`NavPage` 包含 `conversations`；Alt+9；首页「全部会话」入口。

- [ ] **Step 1: 写失败的测试**

- `NavRail.test.tsx` 第一例列表加 `"会话 Alt9"`，标题「渲染 9 个…」；「存储里缺项」循环加 `会话`。
- `SettingsPage.test.tsx` 上移/下移预期数组加 `"conversations"`（位置按 `DEFAULT_NAV_ORDER` 更新；技能区上移后预期为 `["home","conversations","skills","workspace","tasks","interfaces","memory","archive","settings"]`）。
- `HomePage.test.tsx` 新增：

```tsx
  it("最近会话「全部会话」入口切到会话页", async () => {
    mockFetch({ conversations: [conv("c1")] });
    useChatStore.setState({ conversations: [conv("c1")], messages: {}, workspaceReady: true });
    render(<HomePage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "全部会话" }));
    expect(useUiStore.getState().page).toBe("conversations");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/NavRail.test.tsx src/components/SettingsPage.test.tsx src/components/HomePage.test.tsx --no-file-parallelism`
Expected: FAIL。

- [ ] **Step 3: 类型与默认顺序**

`store/ui.ts`：

```ts
export type Page =
  | "home"
  | "conversations"
  | ...;
```

`DEFAULT_NAV_ORDER` 在 `home` 之后插入 `"conversations"`。

- [ ] **Step 4: App 路由与快捷键**

`App.tsx`：
- `SHORTCUT_PAGES` 末尾追加 `"conversations"`（第 9 位）；
- 键盘处理 `["1"…"9"].includes(e.key)`，`"123456789".indexOf(e.key)`；
- import `ConversationsPage`；
- `view` 增加分支：

```tsx
    ) : page === "conversations" ? (
      <ConversationsPage />
    ) : page === "archive" ? (
```

注释更新为 Alt+1–9。

- [ ] **Step 5: NavRail**

`NavRail.tsx`：
- import `SessionsIcon`；
- `ITEMS` 加：

```tsx
  { page: "conversations", label: "会话", icon: <SessionsIcon width={17} height={17} />, digit: "9" },
```

- 注释中的「六个主页」等文案按实际数量修正（若存在）。

- [ ] **Step 6: 设置区标签**

`SettingsPage.tsx` 的 `NAV_LABELS` 加 `conversations: "会话"`。

- [ ] **Step 7: 首页入口**

`HomePage.tsx` 的「最近会话」标题行改为：

```tsx
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-[12px] font-bold text-[#777]">最近会话</div>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-[#f3f3f3] hover:text-ink"
              onClick={() => useUiStore.getState().setPage("conversations")}
            >
              全部会话
            </button>
          </div>
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/NavRail.test.tsx src/components/SettingsPage.test.tsx src/components/HomePage.test.tsx --no-file-parallelism`
Expected: PASS。

再跑 `npx tsc -p tsconfig.json --noEmit`。

- [ ] **Step 9: 提交**

```bash
git add packages/web/src/store/ui.ts packages/web/src/App.tsx packages/web/src/components/NavRail.tsx packages/web/src/components/SettingsPage.tsx packages/web/src/components/HomePage.tsx packages/web/src/components/NavRail.test.tsx packages/web/src/components/SettingsPage.test.tsx packages/web/src/components/HomePage.test.tsx
git commit -m "feat(nav): 会话页接入导航与首页入口（d.40）"
```

---

### Task 4: 版本、日志、文档与门禁

**Files:**
- 五个 `package.json`、`README.md`
- `CHANGELOG.md`、`packages/web/src/generated/changelog.ts`
- `docs/HANDOFF.md`、`docs/INDEX.md`

- [ ] **Step 1: 全量门禁**

Run: `pnpm -r build && pnpm -r --workspace-concurrency=1 test`
Expected: 全绿。

- [ ] **Step 2: 升版本**

Run: `node scripts/bump-version.mjs auto feature`
Expected: `d.39.1.11.0 → d.40.1.11.0`。

- [ ] **Step 3: CHANGELOG（单行 bullet）**

```markdown
## d.40.1.11.0（2026-10-29）— 会话中心：所有会话都在一个地方

不再靠雷达和标签找会话。

- **会话页**：导航新增「会话」（Alt+9），列出全部未归档会话，置顶优先、其余按最后消息时间降序。
- **一眼可见**：未读角标、草稿预览、最近消息（本机已加载/已解密缓存）、置顶与免打扰标记、行尾时间。
- **行内操作**：置顶、免打扰、归档；点击打开会话；归档后从会话页消失、仍在归档页。
- **搜索**：按会话名过滤；消息全文检索仍留待后续。
- **本机偏好**：置顶与免打扰只存本机 `heming.convPrefs.v1`，与免打扰开关共用、互不覆盖；不上传、不导出。
- 明确未做：全局消息全文检索、分组/文件夹、拖拽排序、服务端同步置顶。
```

- [ ] **Step 4: 生成更新日志**

Run: `node scripts/build-changelog.mjs`

- [ ] **Step 5: 文档**

- HANDOFF：头部版本 d.40.1.11.0；§2 版本/测试行实际数字；里程碑追加第 38 条；§5 下一轮指向全局消息检索/会话分组；§6 补「预览只读本机缓存、缺失时如实显示」与「偏好只存本机」。
- INDEX：规格表加 d.40 spec 行。

- [ ] **Step 6: 再跑门禁**

Run: `pnpm -r build && pnpm -r --workspace-concurrency=1 test`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add package.json packages/*/package.json README.md CHANGELOG.md packages/web/src/generated/changelog.ts docs/HANDOFF.md docs/INDEX.md docs/superpowers/specs/2026-10-29-d40-conversation-center.md docs/superpowers/plans/2026-10-29-d40-conversation-center.md
git commit -m "docs(release): d.40.1.11.0 会话中心，门禁全绿"
```

---

## 自检

- 规格 A 导航/B 排序与预览/C 行操作/D 偏好 分别落到 Task 3 / Task 2 / Task 2 / Task 1。
- 预览只读 `messages` 与 `msgCache`，无服务端接口；缺失时「点击查看消息」。
- 老页快捷键不动，新页 Alt+9；导航顺序缺项自动补。
- 版本 d.40.1.11.0；测试覆盖列表/排序/预览/搜索/操作/归档/导航/首页入口。
