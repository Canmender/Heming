# d.38 正在输入提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 人类会话里，对方正在输入时在输入框上方显示「X 正在输入…」，3 秒无新事件自动消失；只传元数据，不传内容。

**Architecture:** shared 增加 `typing` 客户端/服务端 WS 事件；服务端做成员校验 + 每连接 1 秒节流后广播；web 端在输入非空且已连接时每 2 秒发一次，收到后按 `(convId, userId)` 记录时间并在 3 秒后过期，名字从 direct peer / 群成员快照解析。

**Tech Stack:** Zod WS 契约、`ws` 服务端、React + zustand、vitest/jsdom。

**Spec:** `docs/superpowers/specs/2026-10-28-d38-typing-indicator.md`

## Global Constraints

- 只传「有人在输入」元数据，**不传输入内容**；不落库、不进离线队列语义。
- 客户端只在 `connected` 时发送；发送节流 2 秒；服务端每连接 1 秒兜底；接收端 3 秒过期。
- 忽略自己（`userId === 自己`）与自己不在的会话。
- 智能体不参与（流式气泡已有反馈）。
- 不改 E2E、不改消息存储、不引第三方依赖。
- 视觉规范：无 emoji、中文文案；提示行固定高度，避免输入区跳动。
- 版本：完成时 `node scripts/bump-version.mjs auto feature`（`d.37.1.9.0` ⇒ **`d.38.1.9.0`**）；改 shared 先 `pnpm --filter @heming/shared build`。
- 门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/shared/src/schemas.ts` | 修改 | 客户端 `typing` 事件 + 服务端 `typing` 广播事件 |
| `packages/server/src/ws.ts` | 修改 | 成员校验、每连接 1 秒节流、会话内广播 |
| `packages/server/src/ws.test.ts` | 修改 | 转发 / 非成员 / 节流 |
| `packages/web/src/components/ChatPage.tsx` | 修改 | 发送节流、接收状态、3 秒过期、名字解析、提示行 |
| `packages/web/src/components/ChatPage.test.tsx` | 修改 | 发送 / 节流 / 未连接不发 / 展示 / 忽略自己与他会话 / 过期 / 切会话清空 |
| `CHANGELOG.md` / `docs/HANDOFF.md` / `docs/INDEX.md` | 修改 | 版本、里程碑 36、索引 |

---

### Task 1: 共享事件 + 服务端转发

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/server/src/ws.ts`
- Test: `packages/server/src/ws.test.ts`

**Interfaces:**
- Produces: `WsClientEvent` 的 `{ type:"typing"; conversationId:string }`；`WsServerEvent` 的 `{ type:"typing"; conversationId:string; userId:string }`；导出常量 `TYPING_MIN_INTERVAL_MS = 1000`。

- [ ] **Step 1: 写失败的测试**

在 `ws.test.ts` 的 describe 内加：

```ts
  it("typing：成员转发、非成员 forbidden、1 秒内第二条静默丢弃", async () => {
    const a = await connect(issueToken(aliceId));
    const b = await connect(issueToken(bobId));
    const stranger = store.createUser(`typing-eve-${Date.now()}`, "h", "夏娃");
    const s = await connect(issueToken(stranger.id));

    const bWait = nextEvent(b);
    a.send(JSON.stringify({ type: "typing", conversationId: convId }));
    const event = await bWait;
    expect(event).toMatchObject({ type: "typing", conversationId: convId, userId: aliceId });

    // 1 秒内第二条：静默丢弃，不再转发
    let extra = 0;
    const count = () => {
      extra += 1;
    };
    b.on("message", count);
    a.send(JSON.stringify({ type: "typing", conversationId: convId }));
    await new Promise((r) => setTimeout(r, 100));
    b.off("message", count);
    expect(extra).toBe(0);

    // 非成员：走通用 forbidden，不广播
    const sWait = nextEvent(s);
    s.send(JSON.stringify({ type: "typing", conversationId: convId }));
    const err = await sWait;
    expect(err.type).toBe("error");
    if (err.type === "error") expect(err.code).toBe("forbidden");

    a.close();
    b.close();
    s.close();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @heming/shared build && cd packages/server && npx vitest run src/ws.test.ts --no-file-parallelism -t "typing"`
Expected: FAIL —— schema 无 `typing`，服务端转发不存在（事件超时或解析失败）。

- [ ] **Step 3: shared 事件**

`WsClientEventUnion` 里 `mark_read` 之后加：

```ts
  // 正在输入（d.38）：只传元数据，不传内容。服务端成员校验后原样广播，不落库。
  z.object({
    type: z.literal("typing"),
    conversationId: z.string().min(1),
  }),
```

`WsServerEventSchema` 的 `read_update` 之后加：

```ts
  z.object({
    type: z.literal("typing"),
    conversationId: z.string().min(1),
    userId: z.string().min(1),
  }),
```

- [ ] **Step 4: 服务端转发与节流**

`packages/server/src/ws.ts` 顶部（`AUTH_TIMEOUT_MS` 附近）加：

```ts
/** typing 元数据的服务端兜底节流：每连接每秒最多转发一次（客户端另有 2s 节流）。 */
export const TYPING_MIN_INTERVAL_MS = 1000;
```

连接处理器内（`let registered...` 附近）加一个每连接变量：

```ts
    /** 上一条 typing 的转发时间（每连接）：防故障/恶意客户端刷屏。 */
    let lastTypingAt = 0;
```

事件分发处：在通用成员校验 `if (!store.isMember(...)) { ... return; }` **之后**、`recall_message` 分支**之前**加：

```ts
      if (event.type === "typing") {
        const now = Date.now();
        if (now - lastTypingAt < TYPING_MIN_INTERVAL_MS) return; // 静默丢弃
        lastTypingAt = now;
        broadcastToConversation(event.conversationId, {
          type: "typing",
          conversationId: event.conversationId,
          userId,
        });
        return;
      }
```

注意：必须放在成员校验之后，否则非成员也能让别人收到提示；必须放在 `else` 兜底（mark_read）之前，否则会被当成已读广播。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/server && npx vitest run src/ws.test.ts --no-file-parallelism -t "typing"`
Expected: PASS。

Run: `cd packages/server && npx vitest run --no-file-parallelism`
Expected: PASS（ws 全文件无回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/schemas.ts packages/server/src/ws.ts packages/server/src/ws.test.ts
git commit -m "feat(ws): typing 元数据事件与每连接节流（d.38）"
```

---

### Task 2: 聊天页发送节流与提示展示

**Files:**
- Modify: `packages/web/src/components/ChatPage.tsx`
- Test: `packages/web/src/components/ChatPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `typing` 客户端/服务端事件。
- Produces: 导出常量 `TYPING_SEND_INTERVAL_MS = 2000`、`TYPING_TTL_MS = 3000`（供测试与文档引用）；提示行文案见规格 §1C。

- [ ] **Step 1: 写失败的测试**

在 `ChatPage.test.tsx` 的 describe 内加：

```tsx
  it("输入非空且已连接时发送 typing，2 秒内连续输入只发一次", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
      mockMessagesFetch([]);
      render(<ChatPage />);
      act(() => {
        lastHandlers().onOpen?.();
      });

      const input = screen.getByLabelText("消息输入框");
      fireEvent.change(input, { target: { value: "你" } });
      expect(send).toHaveBeenCalledWith({ type: "typing", conversationId: "c1" });

      send.mockClear();
      fireEvent.change(input, { target: { value: "你好" } });
      expect(send).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2001);
      });
      fireEvent.change(input, { target: { value: "你好呀" } });
      expect(send).toHaveBeenCalledWith({ type: "typing", conversationId: "c1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("未连接时不发 typing", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    render(<ChatPage />);
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "你" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("收到他人 typing 显示名字；自己与别的会话忽略；3 秒后消失", async () => {
    vi.useFakeTimers();
    try {
      mockMessagesFetch([]);
      render(<ChatPage />);
      act(() => {
        lastHandlers().onOpen?.();
        lastHandlers().onEvent({ type: "typing", conversationId: "c1", userId: "u2" });
      });
      expect(screen.getByText("鲍勃 正在输入…")).toBeInTheDocument();

      act(() => {
        lastHandlers().onEvent({ type: "typing", conversationId: "c1", userId: "u1" }); // 自己
        lastHandlers().onEvent({ type: "typing", conversationId: "c2", userId: "u2" }); // 别的会话
      });
      expect(screen.queryByText(/爱丽丝 正在输入/)).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(4000); // TTL 3s + 清理定时器 1s
      });
      expect(screen.queryByText("鲍勃 正在输入…")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
```

（若 fake timers 影响挂载期的既有定时器导致噪声，改为：只在该用例 `vi.useFakeTimers({ shouldAdvanceTime: true })`，或把「3 秒后消失」单独拆一个用例；**不要**改实现来迁就测试。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism -t "typing"`
Expected: FAIL —— 没有发送与提示。

- [ ] **Step 3: 常量与状态**

`ChatPage.tsx` 顶部常量区加：

```tsx
/** typing 发送节流：输入期间最多每 2 秒发一次（只传元数据）。 */
export const TYPING_SEND_INTERVAL_MS = 2000;
/** typing 接收端过期：3 秒没有新事件即视为停止输入。 */
export const TYPING_TTL_MS = 3000;
```

组件状态区（`connected` 附近）加：

```tsx
  /** 本会话正在输入的人：userId → 最后事件时间（毫秒）。 */
  const [typingBy, setTypingBy] = useState<Record<string, number>>({});
  /** 上次发送 typing 的时间（每会话重置）。 */
  const typingSentAtRef = useRef(0);
```

切会话复位（现有 `useEffect(() => {...}, [convId])` 里）加：

```tsx
    setTypingBy({});
    typingSentAtRef.current = 0;
```

- [ ] **Step 4: 发送节流**

在 `onDraftChange` 里、`setDraft(value)` 之后：

```tsx
    if (value.trim() !== "") {
      const now = Date.now();
      if (connected && now - typingSentAtRef.current >= TYPING_SEND_INTERVAL_MS) {
        typingSentAtRef.current = now;
        wsHandleRef.current?.send({ type: "typing", conversationId: convId });
      }
    }
```

> `connected` 判断放在发送前：`ws.send` 在未连接时会把帧塞进离线队列，恢复后补发的 typing 已经过期，属于噪音。

- [ ] **Step 5: 接收与过期**

WS `onEvent` 里（`read_update` 分支之后、`error` 之前）加：

```tsx
        } else if (e.type === "typing") {
          if (e.conversationId === convId && e.userId !== useAuthStore.getState().user?.id) {
            setTypingBy((prev) => ({ ...prev, [e.userId]: Date.now() }));
          }
        }
```

裁剪定时器（放在其它定时器 effect 附近）：

```tsx
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTypingBy((prev) => {
        const next: Record<string, number> = {};
        let changed = false;
        for (const [id, at] of Object.entries(prev)) {
          if (now - at < TYPING_TTL_MS) next[id] = at;
          else changed = true;
        }
        return changed ? next : prev; // 没变化不触发重渲染
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);
```

- [ ] **Step 6: 名字与文案**

在 `headerTitle` 附近计算：

```tsx
  const typingNames = Array.from(
    new Set(
      Object.keys(typingBy)
        .map((id) => {
          if (conv?.type === "direct") return conv.peer.id === id ? conv.peer.displayName : null;
          if (conv?.type === "group") return groupMembers?.byId[id]?.name ?? "有人";
          return null;
        })
        .filter((name): name is string => !!name),
    ),
  );
  const typingText =
    typingNames.length === 0
      ? ""
      : typingNames.length === 1
        ? `${typingNames[0]} 正在输入…`
        : typingNames.length === 2
          ? `${typingNames[0]}、${typingNames[1]} 正在输入…`
          : `${typingNames[0]} 等 ${typingNames.length} 人正在输入…`;
```

- [ ] **Step 7: 渲染提示行**

在 composer 的拖拽把手之前（输入行上方）加固定高度的一行：

```tsx
        <div
          role="status"
          aria-live="polite"
          className="h-4 shrink-0 px-5 text-[10px] leading-4 text-muted"
        >
          {typingText}
        </div>
```

（固定 `h-4`：提示出现/消失不推挤输入区。）

- [ ] **Step 8: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism -t "typing"`
Expected: PASS。

Run: `cd packages/web && npx vitest run src/components/ChatPage.test.tsx --no-file-parallelism`
Expected: PASS（整文件无回归）。

- [ ] **Step 9: 提交**

```bash
git add packages/web/src/components/ChatPage.tsx packages/web/src/components/ChatPage.test.tsx
git commit -m "feat(chat): 正在输入提示与发送节流（d.38）"
```

---

### Task 3: 版本、日志、文档与门禁

**Files:**
- Modify: 五个 `package.json`（脚本）
- Modify: `CHANGELOG.md`、`packages/web/src/generated/changelog.ts`（生成）
- Modify: `docs/HANDOFF.md`（头部/§2/里程碑 36/§5/§6）
- Modify: `docs/INDEX.md`（d.38 spec 行）

- [ ] **Step 1: 全量门禁（提交前）**

Run:

```bash
pnpm --filter @heming/shared build && pnpm -r build && pnpm -r --workspace-concurrency=1 test
```

Expected: 五个包 exit 0。

- [ ] **Step 2: 升版本**

Run: `node scripts/bump-version.mjs auto feature`
Expected: `d.37.1.9.0 → d.38.1.9.0`（后四位保留）。

- [ ] **Step 3: CHANGELOG 顶部条目（每条 bullet 单行）**

```markdown
## d.38.1.9.0（2026-10-28）— 看得见对方正在输入

人类会话终于有了「正在回应」的信号，和智能体的流式气泡对齐。

- **正在输入提示**：输入框上方显示「鲍勃 正在输入…」；群聊按成员名显示，3 人以上显示「张三 等 N 人正在输入…」，3 秒没有新事件自动消失。
- **只传元数据**：WS 新增 `typing` 事件，只说明「谁在哪个会话输入」，**不传输入内容**、不落库、不进离线队列。
- **节流**：客户端每 2 秒最多发一次；服务端每连接每秒兜底转发一次，超限静默丢弃，防故障客户端刷屏。
- **边界**：自己与其他会话的 typing 一律忽略；切会话清空提示；智能体不参与（流式气泡已足够）。
- 明确未做：真实在线状态（WS 连接目前随聊天页卸载，做 presence 会假离线；需先把连接上提 App 壳，另立规格）。
```

- [ ] **Step 4: 生成设置区更新日志**

Run: `node scripts/build-changelog.mjs`
Expected: d.38 条目完整、bullet 不折断。

- [ ] **Step 5: 更新交接与索引**

- `docs/HANDOFF.md`：头部日期 2026-10-28、当前版本 d.38.1.9.0、本轮标签 d.38；§2 版本/测试行用实际门禁数字与增量；里程碑追加第 36 条；§5 下一轮仍指向 `research/2026-10-23-rounds-after-d36.md`；§6 补一条：typing 是元数据、服务端不落库；presence 仍待 WS 上提。
- `docs/INDEX.md` 设计规格表加 d.38 spec 行。

- [ ] **Step 6: 再跑门禁**

Run: `pnpm -r build && pnpm -r --workspace-concurrency=1 test`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add package.json packages/*/package.json README.md CHANGELOG.md packages/web/src/generated/changelog.ts docs/HANDOFF.md docs/INDEX.md docs/superpowers/specs/2026-10-28-d38-typing-indicator.md docs/superpowers/plans/2026-10-28-d38-typing-indicator.md
git commit -m "docs(release): d.38.1.9.0 正在输入提示，门禁全绿"
```

---

## 自检

- 规格 A（事件形态/不落库）、B（2s/1s/3s）、C（文案/名字/固定高度）分别落到 Task 1 / Task 2。
- 非目标 presence 写明原因，不在本轮偷偷实现。
- 服务端顺序：成员校验 → typing 分支 → recall/send/mark_read，避免被当成已读广播。
- 版本 d.38.1.9.0；shared 先 build。
- 边界：群名缺失回退「有人」；自己/他会话忽略；typing 不进离线队列。
