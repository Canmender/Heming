# d.37 会话连续性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「离开再回来」的路径不再撒谎：最近会话按真实最后消息排序、未读能定位、断线状态说清楚、草稿在会话入口可见。

**Architecture:** 服务端给 `Conversation` 增加可选 `lastMessageAt`（两种 Store 同契约）；web 侧首页据此排序并在未加载消息时显示「点击查看消息」。聊天页用切会话时的未读数快照插分隔线并滚到它；WS 三态驱动标题与横幅；草稿库加轻量订阅，标签/缩略列/首页实时显示草稿。

**Tech Stack:** Zod + 两个 Store 实现、React + zustand、vitest/jsdom、node:test（不涉及 desktop）。

**Spec:** `docs/superpowers/specs/2026-10-27-d37-conversation-continuity.md`

## Global Constraints

- 版本号只增不减；完成时 `node scripts/bump-version.mjs auto feature`（`d.36.1.9.0` ⇒ **`d.37.1.9.0`**）。
- **改了 shared 契约先 `pnpm --filter @heming/shared build`**，否则 server/web 的 typecheck 读旧类型。
- `lastMessageAt` 必须是**可选**字段，旧服务端/旧数据不迁移；客户端把 `null/undefined` 排最后。
- 未读计数口径与服务端一致：**所有非自己发送的消息**（含 agent、撤回）都算；不另造计数。
- 不改 E2E、不上传预览正文、不引第三方依赖。
- 断线横幅只复用现有 `connectWs` 的 `onOpen/onClose`，**不改 WS 协议**。
- 草稿订阅只在草稿**实际变更**时通知，避免每 300ms 打字全站重渲染。
- 视觉规范：无 emoji、细线 SVG、浅灰分割线、中文文案。
- 门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/shared/src/schemas.ts` | 修改 | 三个 Conversation 变体加 `lastMessageAt?: string \| null` |
| `packages/server/src/store.ts` | 修改 | 内存 Store 的 `listConversations` 填最后消息时间 |
| `packages/server/src/sqliteStore.ts` | 修改 | SQLite Store 同上（每会话一条 `ORDER BY created_at DESC LIMIT 1`） |
| `packages/server/src/storeContract.test.ts` | 修改 | 双实现契约：空会话 null、发消息后更新 |
| `packages/web/src/components/HomePage.tsx` | 修改 | 按 `lastMessageAt` 排序取 6；预览三态；草稿预览 |
| `packages/web/src/components/HomePage.test.tsx` | 修改 | 排序、未加载预览、草稿预览 |
| `packages/web/src/components/ChatPage.tsx` | 修改 | 未读快照/分隔线/定位；WS 三态横幅与恢复提示 |
| `packages/web/src/components/ChatPage.test.tsx` | 修改 | 分隔线位置与滚动、无未读不插、溢出提示、断线/恢复 |
| `packages/web/src/lib/drafts.ts` | 修改 | `hasDraft` + 模块级订阅/版本号 + 变更通知 |
| `packages/web/src/lib/drafts.test.ts` | 修改 | `hasDraft` 与订阅 |
| `packages/web/src/components/ConversationTabs.tsx` | 修改 | 标签与缩略列的草稿圆点/aria-label |
| `packages/web/src/components/ConversationTabs.test.tsx` | 修改 | 两种视图的草稿标记 |
| `CHANGELOG.md` / `docs/HANDOFF.md` / `docs/INDEX.md` | 修改 | 版本、里程碑、索引 |

---

### Task 1: 服务端 `lastMessageAt`（shared + 双 Store）

**Files:**
- Modify: `packages/shared/src/schemas.ts`（`ConversationSchema` 三个变体）
- Modify: `packages/server/src/store.ts`（`listConversations` 的三处 push）
- Modify: `packages/server/src/sqliteStore.ts`（`listConversations` 的三处 push + 一个 helper）
- Test: `packages/server/src/storeContract.test.ts`

**Interfaces:**
- Produces: `Conversation.lastMessageAt?: string | null`（ISO；无消息为 `null`）。
- 后续任务只读该字段。

- [ ] **Step 1: 写失败的契约测试**

在 `storeContract.test.ts` 的 `describe` 内、`群消息计入未读并可 markRead 清零` 之后加：

```ts
    it("listConversations 带 lastMessageAt：空会话 null，发消息后是最后一条时间", async () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      befriend(a.id, "bob", b.id);
      const g = store.createGroup(a.id, "群", [b.id]);

      const empty = store.listConversations(a.id).find((c) => c.id === g.id);
      expect(empty?.lastMessageAt ?? null).toBeNull();

      store.addMessage(g.id, "user", b.id, { text: "一" }, null);
      // 隔开 5ms，确保第二条时间严格更晚（避免同毫秒让「取最后一条」与「取第一条」不可区分）
      await new Promise((r) => setTimeout(r, 5));
      const last = store.addMessage(g.id, "user", a.id, { text: "二" }, null);

      const conv = store.listConversations(a.id).find((c) => c.id === g.id);
      expect(conv?.lastMessageAt).toBe(last.createdAt);
    });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @heming/shared build && cd packages/server && npx vitest run src/storeContract.test.ts --no-file-parallelism`
Expected: FAIL —— `lastMessageAt` 为 `undefined`（空会话断言先失败）。

- [ ] **Step 3: 加 shared 字段**

`packages/shared/src/schemas.ts` 的 `ConversationSchema` 三个 `z.object` 里，紧跟 `unreadCount` 之后各加一行（三种 type 都加）：

```ts
    /** 最后一条消息时间（ISO）；无消息为 null。可选：兼容旧服务端。 */
    lastMessageAt: z.string().nullable().optional(),
```

- [ ] **Step 4: 内存 Store 填充**

`packages/server/src/store.ts` 的 `listConversations`：在 `for (const [id, conv] of conversations)` 内先算一次：

```ts
      const lastMessageAt = messages.get(id)?.at(-1)?.createdAt ?? null;
```

三个 `out.push({...})` 里各加 `lastMessageAt,`。

- [ ] **Step 5: SQLite Store 填充**

`packages/server/src/sqliteStore.ts` 的 `listConversations` 里，`unreadOf` 旁边加：

```ts
      const lastMessageAtOf = (convId: string): string | null => {
        const row = db
          .prepare(
            "SELECT created_at FROM messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(convId) as { created_at: string } | undefined;
        return row?.created_at ?? null;
      };
```

三个 `out.push({...})` 里各加 `lastMessageAt: lastMessageAtOf(c.id),`。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @heming/shared build && cd packages/server && npx vitest run src/storeContract.test.ts --no-file-parallelism`
Expected: PASS（memory 与 sqlite 两组契约都绿）。

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/schemas.ts packages/server/src/store.ts packages/server/src/sqliteStore.ts packages/server/src/storeContract.test.ts
git commit -m "feat(server): 会话列表带最后消息时间（d.37）"
```

---

### Task 2: 首页最近会话排序 + 诚实的未加载预览

**Files:**
- Modify: `packages/web/src/components/HomePage.tsx:182`、`:355-375`
- Test: `packages/web/src/components/HomePage.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `lastMessageAt`。
- Produces: `recent` 按最后消息降序、取 6；预览三态。

- [ ] **Step 1: 写失败的测试**

在 `HomePage.test.tsx` 的 `describe` 里（`beforeEach` 已清 store）加：

```tsx
  it("最近会话按 lastMessageAt 排序；未加载的消息不冒充「暂无消息」", async () => {
    const mkGroup = (id: string, name: string, lastMessageAt?: string) => ({
      id,
      type: "group" as const,
      name,
      memberCount: 2,
      unreadCount: 0,
      ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    });
    const rows = [
      mkGroup("g-old", "较旧的群", "2026-10-20T00:00:00.000Z"),
      mkGroup("g-fresh", "最新的群", "2026-10-25T00:00:00.000Z"),
      mkGroup("g-empty", "空群"),
    ];
    mockFetch({ conversations: rows });
    useChatStore.setState({ conversations: rows, messages: {}, workspaceReady: true });

    render(<HomePage />);
    await act(async () => {});

    const fresh = screen.getByText("最新的群").closest("button")!;
    const old = screen.getByText("较旧的群").closest("button")!;
    const empty = screen.getByText("空群").closest("button")!;
    expect(fresh.compareDocumentPosition(old) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(old.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 有 lastMessageAt 但本机没加载消息 → 「点击查看消息」；真没消息 → 「暂无消息」
    expect(screen.getAllByText("点击查看消息")).toHaveLength(2);
    expect(screen.getByText("暂无消息")).toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/HomePage.test.tsx --no-file-parallelism`
Expected: FAIL —— 顺序仍按数组、预览仍是「暂无消息」。

- [ ] **Step 3: 实现排序与预览**

`HomePage.tsx` 把 `const recent = conversations.slice(0, 6);` 改成：

```tsx
  /**
   * 最近会话：按最后消息时间降序（无消息排最后），取前 6。
   *
   * 之前直接 slice 数组——那是服务端的创建序，不是「最近」。
   */
  const recent = useMemo(() => {
    return [...conversations]
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(0, 6);
  }, [conversations]);
```

预览处（`const preview = ...`）改为：

```tsx
              const preview = last
                ? last.recalledAt != null
                  ? "消息已撤回"
                  : last.payload.text || "(附件)"
                : c.lastMessageAt
                  ? "点击查看消息" // 有消息但本机还没加载：不冒充「暂无消息」
                  : "暂无消息";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/HomePage.test.tsx --no-file-parallelism`
Expected: PASS（既有用例 + 新 1 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/components/HomePage.tsx packages/web/src/components/HomePage.test.tsx
git commit -m "feat(home): 最近会话按真实活跃度排序，未加载预览不再说暂无（d.37）"
```

---

### Task 3: 聊天页未读分隔线与定位

**Files:**
- Modify: `packages/web/src/components/ChatPage.tsx`
- Test: `packages/web/src/components/ChatPage.test.tsx`

**Interfaces:**
- Produces: 分隔线 `id="unread-divider"`、`role="separator"`、`aria-label="以下是新消息"`；溢出提示「有更多未读消息在上方」。

- [ ] **Step 1: 写失败的测试**

在 `ChatPage.test.tsx` 的 `describe` 内加三条（放在 A3 滚动用例附近；`mockMessagesFetch`、`msg`、`lastHandlers` 都是文件内既有 helper）：

```tsx
  it("有未读时在第一条未读前插分隔线，并滚到分隔线而不是底部", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 2 }],
    });
    mockMessagesFetch([
      msg("m1", "旧消息一", "2026-10-14T01:00:00.000Z"),
      msg("m2", "旧消息二", "2026-10-14T01:01:00.000Z"),
      msg("m3", "未读一", "2026-10-14T02:00:00.000Z"),
      msg("m4", "未读二", "2026-10-14T02:01:00.000Z"),
    ]);

    render(<ChatPage />);
    const divider = await screen.findByRole("separator", { name: "以下是新消息" });
    const firstUnread = document.getElementById("msg-m3")!;
    expect(divider.compareDocumentPosition(firstUnread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("没有未读时不插分隔线", async () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 0 }],
    });
    mockMessagesFetch([msg("m1", "普通消息", "2026-10-14T01:00:00.000Z")]);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("普通消息")).toBeInTheDocument());
    expect(screen.queryByRole("separator", { name: "以下是新消息" })).not.toBeInTheDocument();
  });

  it("未读数超过已加载消息：顶部提示还有更早的未读", async () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 5 }],
    });
    mockMessagesFetch([
      msg("m1", "仅有的旧消息", "2026-10-14T01:00:00.000Z"),
      msg("m2", "仅有的新消息", "2026-10-14T02:00:00.000Z"),
    ]);
    render(<ChatPage />);
    expect(await screen.findByText("有更多未读消息在上方")).toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism -t "未读"`
Expected: FAIL —— 找不到分隔线/提示。

- [ ] **Step 3: 实现未读快照**

在 `ChatPage.tsx` 的 `visibleMessages` 附近加：

```tsx
  /**
   * 本次停留的未读快照：切进会话时取一次服务端 unreadCount，之后只用于分隔线。
   *
   * 不能实时读 conversations.unreadCount：打开即发 mark_read，很快就会被清零。
   */
  const [unreadMarker, setUnreadMarker] = useState<{ convId: string; count: number } | null>(null);
  const unreadCapturedRef = useRef<string | null>(null);

  useEffect(() => {
    // 切会话先清旧快照；真正的捕获等 conversations 里有这条会话再做（首帧可能还没加载）。
    unreadCapturedRef.current = null;
    setUnreadMarker(null);
  }, [convId]);

  useEffect(() => {
    if (unreadCapturedRef.current === convId) return;
    const target = conversations.find((c) => c.id === convId);
    if (!target) return; // 会话数据还没到，等下一次 conversations 变化
    unreadCapturedRef.current = convId;
    if (target.unreadCount > 0) setUnreadMarker({ convId, count: target.unreadCount });
  }, [convId, conversations]);
```

计算分隔线（依赖 `visibleMessages`，放在 `windowedMessages` 之后）：

```tsx
  /** 未读分隔线：从后往前数「非自己发送」的第 count 条；不足则标记溢出。 */
  const unreadDivider = useMemo(() => {
    if (!unreadMarker || unreadMarker.convId !== convId) return { id: null, overflow: false };
    let remaining = unreadMarker.count;
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      const m = visibleMessages[i];
      if (m.senderId === me?.id) continue; // 自己的消息不算未读（与服务端口径一致）
      remaining -= 1;
      if (remaining === 0) return { id: m.id, overflow: false };
    }
    return { id: visibleMessages[0]?.id ?? null, overflow: remaining > 0 };
  }, [unreadMarker, convId, visibleMessages, me?.id]);

  /** 分隔线只在第一次出现时定位一次；之后用户自己滚，不再抢滚动条。 */
  const dividerScrolledRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!unreadDivider.id) return;
    const el = scrollRef.current;
    if (unreadDivider.overflow) {
      // 未读多到超出已加载窗口：滚到顶，让「有更多未读消息在上方」的提示可见
      if (el) el.scrollTop = 0;
      atBottomRef.current = false;
      return;
    }
    const key = `${convId}:${unreadDivider.id}`;
    if (dividerScrolledRef.current === key) return;
    dividerScrolledRef.current = key;
    atBottomRef.current = false;
    document
      .getElementById("unread-divider")
      ?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [convId, unreadDivider.id, unreadDivider.overflow]);
```

**同时改现有的切会话复位 effect**（否则它会在分隔线定位之后又把视图拽回底部）。把 `ChatPage.tsx:1421-1428` 的
`bottomRef.current?.scrollIntoView(...)` 包一层：**只有切进来的会话当前没有未读时才跳底**，
有未读就交给上面的分隔线 effect：

```tsx
  useEffect(() => {
    setWindowCount(DEFAULT_WINDOW);
    prevScrollHeightRef.current = null;
    atBottomRef.current = true;
    setNewBelow(false);
    const unreadAtSwitch =
      useChatStore.getState().conversations.find((c) => c.id === convId)?.unreadCount ?? 0;
    if (unreadAtSwitch === 0) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [convId]);
```

在消息列表顶部（`windowedMessages.map` 之前）加溢出提示：

```tsx
        {unreadDivider.overflow ? (
          <div className="mb-3 flex justify-center">
            <span className="rounded-full bg-[#fff7e6] px-2.5 py-0.5 text-[10px] text-[#b45309]">
              有更多未读消息在上方
            </span>
          </div>
        ) : null}
```

在 `windowedMessages.map` 的 `return` 里，`<Fragment key={m.id}>` 内、时间分隔之前插入：

```tsx
              {unreadDivider.id === m.id ? (
                <div
                  id="unread-divider"
                  role="separator"
                  aria-label="以下是新消息"
                  className="mb-3 flex items-center gap-2 text-[10px] text-[#b45309]"
                >
                  <span className="h-px flex-1 bg-[#f0d58c]" />
                  <span>以下是新消息</span>
                  <span className="h-px flex-1 bg-[#f0d58c]" />
                </div>
              ) : null}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism -t "未读"`
Expected: PASS（3 例；既有未读相关用例也仍绿）。

再跑整个 ChatPage 测试文件确认无回归：

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/components/ChatPage.tsx packages/web/src/components/ChatPage.test.tsx
git commit -m "feat(chat): 未读分隔线与打开会话定位到第一条未读（d.37）"
```

---

### Task 4: 连接状态三态与重连横幅

**Files:**
- Modify: `packages/web/src/components/ChatPage.tsx`（`connected` 状态、WS 回调、header 与横幅）
- Test: `packages/web/src/components/ChatPage.test.tsx`

**Interfaces:**
- Consumes: 既有 `connectWs` 的 `onOpen/onClose`。
- Produces: 文案「连接中…」/「已连接」/「连接已断开」/「连接已断开，正在自动重连…消息会排队，恢复后自动补发」/「已恢复连接」。

- [ ] **Step 1: 写失败的测试**

在 `ChatPage.test.tsx` 的 describe 内加（`lastHandlers()` 是既有 helper）：

```tsx
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
    expect(screen.getByText("已恢复连接")).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
  });
```

（若 `getByRole("status", { name: "" })` 因页面其他 status 冲突，改用下面的横幅文本 `getByText` 断言；**不要**为了测试改实现。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism -t "断线"`
Expected: FAIL —— 没有横幅/恢复提示。

- [ ] **Step 3: 实现三态**

把 `const [connected, setConnected] = useState(false);` 附近扩展为：

```tsx
  const [connected, setConnected] = useState(false);
  /** WS 三态：首次连接 / 已连接 / 已断开（用于标题与横幅，不用 connected 二元冒充）。 */
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  /** 断线后恢复的短暂提示（3 秒）。 */
  const [recovered, setRecovered] = useState(false);
  const recoveredTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadClosedRef = useRef(false);
```

WS 回调改为：

```tsx
      onOpen: () => {
        setConnected(true);
        setConnState("open");
        if (hadClosedRef.current) {
          setRecovered(true);
          if (recoveredTimer.current) clearTimeout(recoveredTimer.current);
          recoveredTimer.current = setTimeout(() => setRecovered(false), 3000);
        }
        // ……以下既有补拉与补已读逻辑原样保留
      },
      onClose: () => {
        setConnected(false);
        setConnState("closed");
        hadClosedRef.current = true;
      },
```

卸载清理（放在该 effect 的 `return` 之前或单独的清理 effect）：

```tsx
    if (recoveredTimer.current) clearTimeout(recoveredTimer.current);
```

header 状态文本改为：

```tsx
        <span className="flex items-center gap-1 text-[12px] text-muted">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              connState === "open"
                ? "bg-[#12b76a]"
                : connState === "closed"
                  ? "bg-[#b45309]"
                  : "bg-[#c4c4c4]"
            }`}
          />
          {connState === "open" ? "已连接" : connState === "closed" ? "连接已断开" : "连接中…"}
        </span>
        {recovered && (
          <span role="status" className="text-[11px] text-[#12b76a]">
            已恢复连接
          </span>
        )}
```

header 之后（`</header>` 之后）加横幅：

```tsx
      {connState === "closed" && (
        <div
          role="status"
          className="border-b border-[#f0d58c] bg-[#fff7e6] px-5 py-1.5 text-[11px] text-[#b45309]"
        >
          连接已断开，正在自动重连…消息会排队，恢复后自动补发
        </div>
      )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism -t "断线"`
Expected: PASS。

再跑整个 ChatPage 测试文件确认既有「已连接」断言仍绿。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/components/ChatPage.tsx packages/web/src/components/ChatPage.test.tsx
git commit -m "feat(chat): 连接状态三态与重连横幅（d.37）"
```

---

### Task 5: 草稿可见（订阅 + 入口标记）

**Files:**
- Modify: `packages/web/src/lib/drafts.ts`
- Modify: `packages/web/src/components/ConversationTabs.tsx`
- Modify: `packages/web/src/components/ChatConvStrip.tsx`
- Modify: `packages/web/src/components/HomePage.tsx`
- Test: `packages/web/src/lib/drafts.test.ts`、`packages/web/src/components/ConversationTabs.test.tsx`、`packages/web/src/components/HomePage.test.tsx`

**Interfaces:**
- Produces: `hasDraft(convId): boolean`、`subscribeDrafts(fn): () => void`、`draftsVersion(): number`。
- 组件用 `useSyncExternalStore(subscribeDrafts, draftsVersion, () => 0)` 订阅。

- [ ] **Step 1: 写失败的测试**

`drafts.test.ts` 追加：

```ts
  it("hasDraft 只看有没有草稿；set/clear 会通知订阅者", () => {
    expect(hasDraft("conv-a")).toBe(false);
    const calls: number[] = [];
    const unsubscribe = subscribeDrafts(() => calls.push(draftsVersion()));

    setDraft("conv-a", "写了点东西");
    expect(hasDraft("conv-a")).toBe(true);
    expect(calls.length).toBe(1);

    setDraft("conv-a", "写了点东西"); // 同样内容不重复通知
    expect(calls.length).toBe(1);

    clearDraft("conv-a");
    expect(hasDraft("conv-a")).toBe(false);
    expect(calls.length).toBe(2);
    unsubscribe();
  });
```

`ConversationTabs.test.tsx` 追加（文件顶部 import `drafts` 的 `setDraft/clearDraft`）：

```tsx
  it("有草稿的会话在标签与缩略列上都有标记", () => {
    setDraft("c1", "没发完的话");
    render(
      <>
        <ConversationTabs />
        <ChatConvStrip />
      </>,
    );
    expect(screen.getByLabelText(/爱丽丝.*有草稿/)).toBeInTheDocument(); // 标签
    expect(screen.getByLabelText(/切换到 爱丽丝.*有草稿/)).toBeInTheDocument(); // 缩略列
    clearDraft("c1");
  });
```

`HomePage.test.tsx` 追加：

```tsx
  it("有草稿时首页预览显示「草稿：…」", async () => {
    const row = { id: "c1", type: "direct" as const, peer, unreadCount: 0 };
    mockFetch({ conversations: [row] });
    useChatStore.setState({ conversations: [row], messages: {}, workspaceReady: true });
    setDraft("c1", "还没发出去的一句话");

    render(<HomePage />);
    await act(async () => {});
    expect(screen.getByText(/草稿：还没发出去的一句话/)).toBeInTheDocument();
    clearDraft("c1");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/drafts.test.ts src/components/ConversationTabs.test.tsx src/components/HomePage.test.tsx --no-file-parallelism`
Expected: FAIL —— `hasDraft`/`subscribeDrafts` 不存在。

- [ ] **Step 3: 实现草稿订阅**

`drafts.ts`（在 `hasDraft` 之前加模块状态，在 `setDraft/clearDraft/pruneDrafts` 里通知）：

```ts
/** 草稿变更订阅：标签/首页在草稿落盘后即时刷新，而不是等别的状态变化。 */
let version = 0;
const listeners = new Set<() => void>();

function notifyDraftsChanged(): void {
  version += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅者异常不影响其它订阅者 */
    }
  }
}

export function draftsVersion(): number {
  return version;
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 某会话是否有草稿（只看键是否存在，不解析内容）。 */
export function hasDraft(convId: string): boolean {
  if (!convId) return false;
  try {
    return getStorage().getItem(draftKey(convId)) !== null;
  } catch {
    return false;
  }
}
```

`setDraft` 内：
- 空串删除分支：先读 `const had = store.getItem(draftKey(convId)) !== null;`，`removeItem` 后 `if (had) notifyDraftsChanged();`
- 写入分支：**按正文比较，不比较 `at`**（每次写入都会刷新 `at`，用它比较会每 300ms 通知一次）：

```ts
    const prevText = parseDraft(store.getItem(draftKey(convId)))?.text ?? "";
    ...
    store.setItem(draftKey(convId), JSON.stringify(value));
    if (prevText !== value.text) notifyDraftsChanged();
```

`clearDraft`：先读 `had`，删除后 `if (had) notifyDraftsChanged();`。
`pruneDrafts`：记录删除数量，`if (removed > 0) notifyDraftsChanged();`。

- [ ] **Step 4: 实现入口标记**

`ConversationTabs.tsx`：

```tsx
import { useSyncExternalStore } from "react";
import { draftsVersion, hasDraft, subscribeDrafts } from "../lib/drafts.js";
```

组件顶部：

```tsx
  // 草稿落盘后刷新标签（版本号变化触发重渲染；不订阅具体内容）
  useSyncExternalStore(subscribeDrafts, draftsVersion, () => 0);
```

每条标签：

```tsx
        const draft = hasDraft(id);
```

`aria-label` 改为：

```tsx
            aria-label={`${name}${unread > 0 ? ` ${unread} 条未读` : ""}${draft ? " 有草稿" : ""}`}
```

在名字后、未读角标前加：

```tsx
              {draft && (
                <span
                  aria-hidden="true"
                  title="有草稿"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#b45309]"
                />
              )}
```

`ChatConvStrip.tsx` 同样订阅并计算 `draft`，`aria-label` 追加 `" 有草稿"`，头像右下加：

```tsx
            {draft && (
              <span
                aria-hidden="true"
                title="有草稿"
                className="absolute -bottom-0.5 -left-0.5 h-2 w-2 rounded-full border border-white bg-[#b45309]"
              />
            )}
```

`HomePage.tsx`：import 并订阅，预览计算改为：

```tsx
              const draftText = hasDraft(c.id) ? getDraft(c.id) : "";
              const preview = draftText
                ? `草稿：${[...draftText].slice(0, 40).join("")}${[...draftText].length > 40 ? "…" : ""}`
                : last
                  ? last.recalledAt != null
                    ? "消息已撤回"
                    : last.payload.text || "(附件)"
                  : c.lastMessageAt
                    ? "点击查看消息"
                    : "暂无消息";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/drafts.test.ts src/components/ConversationTabs.test.tsx src/components/HomePage.test.tsx --no-file-parallelism`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/lib/drafts.ts packages/web/src/lib/drafts.test.ts packages/web/src/components/ConversationTabs.tsx packages/web/src/components/ChatConvStrip.tsx packages/web/src/components/ConversationTabs.test.tsx packages/web/src/components/HomePage.tsx packages/web/src/components/HomePage.test.tsx
git commit -m "feat(chat): 草稿在标签、缩略列与首页可见（d.37）"
```

---

### Task 6: 版本、日志、文档与门禁

**Files:**
- Modify: 五个 `package.json`（脚本）
- Modify: `CHANGELOG.md`、`packages/web/src/generated/changelog.ts`（生成）
- Modify: `docs/HANDOFF.md`（§2 版本/测试、里程碑 35、§5 下一步）
- Modify: `docs/INDEX.md`（加入 d.37 spec）

- [ ] **Step 1: 全量门禁（提交前）**

Run:

```bash
pnpm --filter @heming/shared build && pnpm -r build && pnpm -r --workspace-concurrency=1 test
```

Expected: 五个包 exit 0。

- [ ] **Step 2: 升版本**

Run: `node scripts/bump-version.mjs auto feature`
Expected: `d.36.1.9.0 → d.37.1.9.0`（后四位保留）。

- [ ] **Step 3: CHANGELOG 顶部条目（每条 bullet 单行）**

```markdown
## d.37.1.9.0（2026-10-27）— 离开再回来，界面记得住

四条都发生在「切走再回来」的路径上：数据其实都在，界面前后没说清楚。

- **最近会话按真实活跃排序**：首页不再按创建顺序取前 6；服务端 `Conversation` 增加可选 `lastMessageAt`，两种 Store 同契约；本机没加载过消息的会话显示「点击查看消息」，不再冒充「暂无消息」。
- **未读能定位**：打开有未读的会话会停在「以下是新消息」分隔线，而不是永远跳到底；未读超过已加载窗口时在顶部提示「有更多未读消息在上方」。
- **断线不伪装**：连接状态分「连接中 / 已连接 / 已断开」三态，断开时标题下方出现「正在自动重连，消息会排队」横幅，恢复后显示 3 秒「已恢复连接」。
- **草稿可见**：标签、缩略列与首页最近会话都会显示草稿标记；首页预览优先显示「草稿：…」。草稿仍是本机数据，不上云、不导出。
- 明确未做：完整会话列表/侧栏改版、真实 presence、`@我` 角标、滚动位置记忆（各自需要独立规格）。
```

- [ ] **Step 4: 生成设置区更新日志**

Run: `node scripts/build-changelog.mjs`
Expected: `packages/web/src/generated/changelog.ts` d.37 条目完整（bullet 不折断）。

- [ ] **Step 5: 更新交接与索引**

- `docs/HANDOFF.md` §2：版本行改 `d.37.1.9.0`；测试行用实际门禁数字并写明本轮增量。
- §2 里程碑追加第 35 条，记录四条改动、`lastMessageAt` 契约、未做项。
- §5：把 d.37 标为已完成，下一轮仍指向 `research/2026-10-23-rounds-after-d36.md`（CSP / release.sh / docker 清理）。
- §6：分发/体验条目按事实补充（例如「最近会话排序依赖服务端 `lastMessageAt`；旧服务端该字段缺省时客户端排最后」）。
- `docs/INDEX.md`：设计规格表加一行 d.37 spec。

- [ ] **Step 6: 再跑门禁**

Run: `pnpm -r build && pnpm -r --workspace-concurrency=1 test`
Expected: 全绿（`version-sync` / `changelog-sync` 校验通过）。

- [ ] **Step 7: 提交**

```bash
git add package.json packages/*/package.json CHANGELOG.md packages/web/src/generated/changelog.ts docs/HANDOFF.md docs/INDEX.md docs/superpowers/specs/2026-10-27-d37-conversation-continuity.md docs/superpowers/plans/2026-10-27-d37-conversation-continuity.md
git commit -m "docs(release): d.37.1.9.0 会话连续性体验轮，门禁全绿"
```

---

## 自检

- 规格 A/B/C/D 四条各对应 Task 2 / Task 3 / Task 4 / Task 5；Task 1 是 A 的数据基础。
- 未做项与规格 §2 一致，不偷偷扩范围。
- 测试文件覆盖 specs §4 表列全部行（`ChatConvStrip` 标记并入 `ConversationTabs.test.tsx`）。
- 版本 `d.37.1.9.0`；改了 shared ⇒ 先 build shared。
- 已知边界：未读数口径与服务器一致（含 agent/撤回）；溢出时只提示不伪造完整列表。
