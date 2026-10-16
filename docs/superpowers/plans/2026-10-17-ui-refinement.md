# 和鸣 UI 完善（热力图 + 聊天改版 + 雷达详情）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主页补 Claude Code 式近 30 日 token 热力图；聊天页头部/输入栏改版（头像昵称、三横线信息卡、表情/图片/文件/语音/发送布局）；工作区雷达点击进详情页且其余头像滚入右侧分组列。

**Architecture:** 全部为 web 层 UI 增量 + 一处 shared 契约扩展（MessagePayload 加可选 `file`）与 server 两处小改（ws 透传 file、新增文件内容路由）。数据层沿用现有 store（tokenUsage 本地日志、chat store、雷达节点口径不变）。

**Tech Stack:** React 18 + TS + Tailwind3 + Zustand；server Express 5 + ws；测试 Vitest（web: testing-library；server: supertest；shared: vitest）。

## Global Constraints

- UI chrome 不用 emoji 图标：一律细线 SVG（strokeWidth 1.5）；**表情选择器插入的 emoji 属消息内容，允许**。
- 分割线/边框用浅灰 `#e6e6e6`/`#ececec`/`#f1f1f1` 一档，不用纯黑；纯黑（`#1a1a1a`/`ink`）仅文字与小面积强调。
- 卡片用既有 `shadow-card`；选中态黑底反白（`bg-ink text-white`）。
- 界面 chrome 不显示产品名「和鸣」。
- 不新增任何 npm 依赖。
- 热力图/Token 口径：**只存逐条原始日志，读取时按窗口重算**，不存跨天累计；日期用本地时区（`dayKeyOf` 现有实现）。
- 消息 `text` 上限 20000、`mentions` max 50 不变；新增 `file` 可选。
- 所有新组件配 vitest 测试；`pnpm -r build && pnpm -r test` 全绿后提交。

---

### Task 1: shared 契约 + server：消息附件（file 字段与内容路由）

**Files:**
- Modify: `packages/shared/src/schemas.ts`（MessagePayloadSchema）
- Modify: `packages/server/src/ws.ts`（send_message 透传 file）
- Modify: `packages/server/src/app.ts`（files 路由区新增 GET content）
- Test: `packages/shared/src/schemas.test.ts`
- Test: `packages/server/src/app.test.ts`、`packages/server/src/ws.test.ts`

**Interfaces:**
- Produces: `MessagePayloadSchema.file?: { id: string; name: string; mime: string; size: number }`；`GET /api/files/:id/content`（Bearer 鉴权，返回原始字节，`Content-Type` 为文件 mime）。
- Task 4 的图片/文件发送消费 `payload.file`；气泡渲染消费 content 路由 URL。

- [ ] **Step 1: 写失败测试（shared）**

在 `schemas.test.ts` 加（沿用既有 describe 风格）：

```ts
it("MessagePayload 允许仅附件（text 空串）", () => {
  const r = MessagePayloadSchema.safeParse({
    text: "",
    file: { id: "f1", name: "a.png", mime: "image/png", size: 12 },
  });
  expect(r.success).toBe(true);
});

it("MessagePayload.file 缺 id 拒绝", () => {
  const r = MessagePayloadSchema.safeParse({
    text: "hi",
    file: { name: "a.png", mime: "image/png", size: 12 },
  });
  expect(r.success).toBe(false);
});

it("MessagePayload.file.size 负数拒绝", () => {
  const r = MessagePayloadSchema.safeParse({
    text: "hi",
    file: { id: "f1", name: "a.png", mime: "image/png", size: -1 },
  });
  expect(r.success).toBe(false);
});
```

- [ ] **Step 2: 写失败测试（server）**

`app.test.ts` files 区追加：

```ts
it("GET /api/files/:id/content 返回原始字节与 mime", async () => {
  const a = await registerUser(app, "filec");
  const up = await request(app)
    .post("/api/files")
    .set("Authorization", `Bearer ${a.token}`)
    .send({ name: "t.txt", mime: "text/plain", contentBase64: Buffer.from("hello").toString("base64") });
  const got = await request(app)
    .get(`/api/files/${up.body.id}/content`)
    .set("Authorization", `Bearer ${a.token}`);
  expect(got.status).toBe(200);
  expect(got.headers["content-type"]).toContain("text/plain");
  expect(got.text).toBe("hello");
});

it("GET /api/files/:id/content 不存在 404", async () => {
  const a = await registerUser(app, "filec2");
  const got = await request(app)
    .get("/api/files/none-id/content")
    .set("Authorization", `Bearer ${a.token}`);
  expect(got.status).toBe(404);
});
```

（`registerUser` 为该文件既有 helper，若名称不同以文件内实际为准。）

`ws.test.ts`（沿用既有连 WS + 断言消息的模式）追加：

```ts
it("send_message 携带 file 原样入库并广播", async () => {
  // 建 a/b 二人直聊（用既有测试同款 REST 流程），连 a 的 WS 发：
  // { type:"send_message", conversationId, payload:{ text:"", file:{ id:"f1", name:"a.png", mime:"image/png", size:3 } } }
  // b 收 message_new，断言 message.payload.file.id === "f1"、text === "";
  // GET /api/messages 断言入库 payload 含 file。
});
```

（测试体用该文件现成的连接/收帧 helper 完成；没有可复用的就按邻近用例复制最小骨架。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @heming/shared test && pnpm --filter @heming/server test`
Expected: 新用例 FAIL（file 被 strip / content 路由 404）。

- [ ] **Step 4: 实现**

`shared/src/schemas.ts` MessagePayloadSchema 内追加：

```ts
  // 消息附件（M4 前置）：引用共享库文件；text 可空串（纯附件消息）
  file: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1).max(255),
      mime: z.string().min(1).max(128),
      size: z.number().int().min(0),
    })
    .optional(),
```

`server/src/ws.ts` send_message 分支 payload 组装改为：

```ts
          {
            text: event.payload.text,
            ...(event.payload.mentions ? { mentions: event.payload.mentions } : {}),
            ...(event.payload.file ? { file: event.payload.file } : {}),
          },
```

`server/src/app.ts` 在 `app.delete("/api/files/:id", …)` 之后加：

```ts
  // 附件内容（气泡图片/下载）：与列表同为登录可见口径（共享库语义），无属主校验
  app.get("/api/files/:id/content", authOnly, (req, res) => {
    const stored = files.get(req.params.id);
    if (!stored) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.setHeader("Content-Type", stored.meta.mime);
    res.send(Buffer.from(stored.content, "base64"));
  });
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `pnpm --filter @heming/shared test && pnpm --filter @heming/server test`
Expected: 全绿。

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts packages/server/src/ws.ts packages/server/src/app.ts packages/server/src/app.test.ts packages/server/src/ws.test.ts
git commit -m "feat: 消息附件契约（payload.file）与文件内容路由"
```

---

### Task 2: 主页近 30 日 token 热力图

**Files:**
- Modify: `packages/web/src/store/tokenUsage.ts`（导出两个纯函数）
- Create: `packages/web/src/components/TokenHeatmap.tsx`
- Create: `packages/web/src/components/TokenHeatmap.test.tsx`
- Modify: `packages/web/src/components/Home.tsx` → 实际文件为 `packages/web/src/components/HomePage.tsx`（统计卡网格后插入热力图卡）
- Test: `packages/web/src/store/tokenUsage.test.ts`（追加）、`HomePage.test.tsx`（追加）

**Interfaces:**
- Produces: `last30DaysTotals(records: UsageRecord[], now?: Date): { day: string; total: number }[]`（30 项、零值天不跳过、含今天）；`heatLevel(total: number, max: number): 0|1|2|3|4`；组件 `<TokenHeatmap />`（自取 store）。
- Consumes: `dayKeyOf`、`useTokenUsageStore`。

- [ ] **Step 1: 写失败测试（store 纯函数）**

`tokenUsage.test.ts` 追加：

```ts
describe("last30DaysTotals", () => {
  it("30 项、零值天不跳过、末项为今天", () => {
    const now = new Date(2026, 9, 17, 12); // 本地 2026-10-17
    const rows = last30DaysTotals([], now);
    expect(rows).toHaveLength(30);
    expect(rows[29].day).toBe("2026-10-17");
    expect(rows.every((r) => r.total === 0)).toBe(true);
  });
  it("按本地日聚合命中对应格", () => {
    const now = new Date(2026, 9, 17, 12);
    const recs = [
      { model: "m", tokens: 10, at: new Date(2026, 9, 17, 1).toISOString() },
      { model: "m", tokens: 5, at: new Date(2026, 9, 16, 23).toISOString() },
      { model: "m", tokens: 999, at: new Date(2026, 8, 1, 1).toISOString() }, // 窗外
    ];
    const rows = last30DaysTotals(recs, now);
    expect(rows[29].total).toBe(10);
    expect(rows[28].total).toBe(5);
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(15);
  });
});
describe("heatLevel", () => {
  it("零/无 max → 0；四档相对刻度", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(10, 0)).toBe(0);
    expect(heatLevel(25, 100)).toBe(1);
    expect(heatLevel(26, 100)).toBe(2);
    expect(heatLevel(50, 100)).toBe(2);
    expect(heatLevel(51, 100)).toBe(3);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(76, 100)).toBe(4);
  });
});
```

（import 补 `last30DaysTotals, heatLevel`。）

- [ ] **Step 2: 写失败测试（组件）**

`TokenHeatmap.test.tsx` 新建：

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenHeatmap } from "./TokenHeatmap.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";

describe("TokenHeatmap", () => {
  beforeEach(() => {
    useTokenUsageStore.setState({ records: [] });
  });

  it("渲染 30 个格子，标题含日期与用量", () => {
    render(<TokenHeatmap />);
    const cells = screen.getByRole("img", { name: "近 30 日 token 用量" }).querySelectorAll("[data-day]");
    expect(cells).toHaveLength(30);
    expect(cells[29].getAttribute("title")).toMatch(/2026-10-\d{2}/);
  });

  it("有记录的格子 data-total 非零且底色非空态", () => {
    useTokenUsageStore.setState({
      records: [{ model: "m", tokens: 50, at: new Date().toISOString() }],
    });
    render(<TokenHeatmap />);
    const today = screen.getByRole("img", { name: "近 30 日 token 用量" }).querySelectorAll("[data-day]")[29];
    expect(today.getAttribute("data-total")).toBe("50");
    expect((today as HTMLElement).style.backgroundColor).not.toBe("rgb(241, 244, 247)");
  });
});
```

（空态色以实现为准，测试断言与实现同步写死 `#f1f4f7` 对应的 rgb 串；若 jsdom 归一化不同，改断言 `style.backgroundColor` 非空即可。）

`HomePage.test.tsx` 追加：渲染 HomePage 后 `screen.getByRole("img", { name: "近 30 日 token 用量" })` 存在。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @heming/web test -- TokenHeatmap tokenUsage HomePage`
Expected: FAIL（函数/组件未导出）。

- [ ] **Step 4: 实现**

`tokenUsage.ts` 追加导出：

```ts
/** 近 30 个自然日（含今天）逐日合计：零值天不跳过；本地时区。 */
export function last30DaysTotals(
  records: UsageRecord[],
  now: Date = new Date(),
): { day: string; total: number }[] {
  const byDay = new Map<string, number>();
  for (const r of records) {
    const day = dayKeyOf(r.at);
    byDay.set(day, (byDay.get(day) ?? 0) + r.tokens);
  }
  const days: { day: string; total: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const day = dayKeyOf(d.toISOString());
    days.push({ day, total: byDay.get(day) ?? 0 });
  }
  return days;
}

/** 相对 max 的 5 档热度：0=无，1 ≤25%，2 ≤50%，3 ≤75%，4 其余。 */
export function heatLevel(total: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (total <= 0 || max <= 0) return 0;
  const ratio = total / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
```

`TokenHeatmap.tsx` 新建：

```tsx
import { useMemo } from "react";
import { last30DaysTotals, heatLevel, useTokenUsageStore } from "../store/tokenUsage.js";

const LEVEL_BG = ["#f1f4f7", "#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"] as const;
const LEVEL_LABEL = ["无", "少", "较少", "较多", "多"] as const;

/** 近 30 日用量热力图（Claude Code 式横排小方格，蓝色深浅=用量）。 */
export function TokenHeatmap() {
  const records = useTokenUsageStore((s) => s.records);
  const days = useMemo(() => last30DaysTotals(records), [records]);
  const max = Math.max(0, ...days.map((d) => d.total));
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label="近 30 日 token 用量">
      {days.map((d, i) => {
        const level = heatLevel(d.total, max);
        return (
          <span
            key={d.day}
            title={`${d.day} · ${d.total} tokens（${LEVEL_LABEL[level]}）`}
            data-day={d.day}
            data-total={d.total}
            style={{ backgroundColor: LEVEL_BG[level] }}
            className={`h-3.5 w-3.5 rounded-[3px]${i === 29 ? " ring-1 ring-ink/20" : ""}`}
          />
        );
      })}
    </div>
  );
}
```

`HomePage.tsx`：import `TokenHeatmap`；在「四张统计卡」grid（`</div>` 收尾统计卡 grid 之后、「两栏」section 之前）插入：

```tsx
      {/* 2.5 近 30 日用量热力图 */}
      <section className="rounded-xl border border-[#ececec] bg-white p-3 shadow-card">
        <div className="mb-1.5 flex items-center">
          <div className="text-[12px] font-bold text-[#777]">近 30 日用量</div>
          <div className="ml-auto flex items-center gap-1 text-[10px] text-muted">
            少
            {["#f1f4f7", "#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"].map((c) => (
              <span key={c} style={{ backgroundColor: c }} className="h-2.5 w-2.5 rounded-[2px]" />
            ))}
            多
          </div>
        </div>
        <TokenHeatmap />
      </section>
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `pnpm --filter @heming/web test`
Expected: 全绿。

```bash
git add packages/web/src/store/tokenUsage.ts packages/web/src/store/tokenUsage.test.ts packages/web/src/components/TokenHeatmap.tsx packages/web/src/components/TokenHeatmap.test.tsx packages/web/src/components/HomePage.tsx packages/web/src/components/HomePage.test.tsx
git commit -m "feat: 主页近 30 日 token 用量热力图"
```

---

### Task 3: 聊天头部改版（头像昵称 + 三横线信息卡浮窗）

**Files:**
- Modify: `packages/web/src/components/ChatPage.tsx`（header 区）
- Create: `packages/web/src/components/ChatInfoCard.tsx`
- Create: `packages/web/src/components/ChatInfoCard.test.tsx`
- Test: `packages/web/src/components/ChatPage.test.tsx`（追加）

**Interfaces:**
- Produces: `<ChatInfoCard conv={Conversation} onClose={() => void} />`——锚定右上的信息卡：direct 显头像/昵称/@用户名；group 显头像首字/群名/人数；带 `pop` 动画与关闭。
- Consumes: `Conversation` 联合类型、`Avatar`、`resolveUrl`（不需）。

- [ ] **Step 1: 写失败测试**

`ChatInfoCard.test.tsx` 新建：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatInfoCard } from "./ChatInfoCard.js";
import type { Conversation } from "@heming/shared";

const direct = {
  id: "c1", type: "direct", unreadCount: 0,
  peer: { id: "u2", username: "bob", displayName: "鲍勃" },
} as unknown as Conversation;

const group = {
  id: "g1", type: "group", unreadCount: 0, name: "群聊组", memberCount: 5,
} as unknown as Conversation;

describe("ChatInfoCard", () => {
  it("direct 显示昵称与 @用户名", () => {
    render(<ChatInfoCard conv={direct} onClose={() => {}} />);
    expect(screen.getByText("鲍勃")).toBeTruthy();
    expect(screen.getByText("@bob")).toBeTruthy();
  });
  it("group 显示群名与人数", () => {
    render(<ChatInfoCard conv={group} onClose={() => {}} />);
    expect(screen.getByText("群聊组")).toBeTruthy();
    expect(screen.getByText(/5 人/)).toBeTruthy();
  });
  it("点关闭调用 onClose", () => {
    const onClose = vi.fn();
    render(<ChatInfoCard conv={direct} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("关闭会话信息"));
    expect(onClose).toHaveBeenCalled();
  });
});
```

`ChatPage.test.tsx` 追加（沿用该文件既有渲染 ChatPage 的 helper 模式）：

```tsx
it("头部左侧显示会话头像与昵称、右侧有会话信息按钮", async () => {
  // 渲染进入某 direct 会话的 ChatPage（用文件内既有 setup）
  expect(screen.getByText("已连接")).toBeTruthy(); // 既有断言风格
  expect(screen.getByLabelText("会话信息")).toBeTruthy();
});

it("点会话信息弹出信息卡", async () => {
  // 点击 getByLabelText("会话信息") → 出现信息卡内容（如 @用户名 或 关闭按钮）
  expect(screen.getByLabelText("关闭会话信息")).toBeTruthy();
});
```

（若既有 ChatPage 测试无 direct 会话夹具，复用其最接近的用例的 mock/fixture，勿新造整套。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @heming/web test -- ChatInfoChat ChatPage`
Expected: FAIL。

- [ ] **Step 3: 实现**

新建 `ChatInfoCard.tsx`：

```tsx
import type { Conversation } from "@heming/shared";
import { Avatar } from "./Avatar.js";

/** 会话信息卡（三横线点击弹出）：direct=对方资料；group=群名与人数。 */
export function ChatInfoCard({
  conv,
  onClose,
}: {
  conv: Conversation;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute right-3 top-full z-40 mt-1 w-[230px] rounded-xl border border-[#ececec] bg-white p-3.5 shadow-card"
      style={{ animation: "chatpop .18s ease" }}
    >
      <style>{`@keyframes chatpop { from { opacity:0; transform:translateY(-6px);} }`}</style>
      <div className="flex items-center gap-2.5">
        <Avatar
          user={
            conv.type === "direct"
              ? conv.peer
              : { displayName: conv.name }
          }
          size={40}
          className="border-2 border-white shadow-card"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-extrabold">
            {conv.type === "direct" ? conv.peer.displayName : conv.name}
          </div>
          <div className="text-[11px] text-muted">
            {conv.type === "direct" ? `@${conv.peer.username}` : `${conv.memberCount} 人`}
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭会话信息"
          className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="mt-2.5 border-t border-[#f1f1f1] pt-2 text-[11px] text-muted">
        {conv.type === "direct" ? "好友 · 1:1 会话" : "群聊会话"}
      </div>
    </div>
  );
}
```

`ChatPage.tsx` header 区替换为（保留返回钮与已连接状态；标题改为头像+昵称；右侧加三横线）：

```tsx
  const [infoOpen, setInfoOpen] = useState(false);
```

```tsx
      <header className="relative flex items-center gap-2.5 border-b border-line-soft px-5 py-3">
        <button
          type="button"
          aria-label="返回"
          className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
          onClick={leave}
        >
          <ChevronIcon width={15} height={15} className="rotate-180" />
        </button>
        {conv && (
          <Avatar
            user={conv.type === "direct" ? conv.peer : { displayName: conv.name }}
            size={28}
          />
        )}
        <span className="text-[14px] font-bold">{headerTitle}</span>
        <span className="text-[12px] text-muted">{connected ? "已连接" : "连接中…"}</span>
        <button
          type="button"
          aria-label="会话信息"
          className={`ml-auto rounded-lg p-1.5 hover:bg-[#f3f3f3]${infoOpen ? " bg-[#f3f3f3]" : ""}`}
          onClick={() => setInfoOpen((v) => !v)}
        >
          <MenuIcon width={17} height={17} />
        </button>
        {infoOpen && conv && <ChatInfoCard conv={conv} onClose={() => setInfoOpen(false)} />}
      </header>
```

import 补 `MenuIcon`（`icons.tsx` 已有）与 `ChatInfoCard`。Esc 关闭：在既有 `onInputKeyDown` 同层加一个 `useEffect` 挂 `keydown`：Escape 时 `setInfoOpen(false)`（文档级监听，卸载移除）。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @heming/web test -- ChatInfoCard ChatPage`
Expected: 全绿。

```bash
git add packages/web/src/components/ChatInfoCard.tsx packages/web/src/components/ChatInfoCard.test.tsx packages/web/src/components/ChatPage.tsx packages/web/src/components/ChatPage.test.tsx
git commit -m "feat: 聊天头部头像昵称与三横线会话信息卡"
```

---

### Task 4: 聊天输入栏改版（表情/图片/文件 + 语音 + 发送）

**Files:**
- Modify: `packages/web/src/lib/api.ts`（提取 `uploadFile`）
- Modify: `packages/web/src/App.tsx`（onUpload 改用 `uploadFile`）
- Modify: `packages/web/src/components/icons.tsx`（SmileIcon / ImageIcon / MicIcon）
- Create: `packages/web/src/components/EmojiPicker.tsx` + test
- Modify: `packages/web/src/components/ChatPage.tsx`（输入区两行布局 + 附件发送 + 语音）
- Test: `packages/web/src/components/ChatPage.test.tsx`（追加）、`packages/web/src/lib/api.test.ts`（追加 uploadFile）

**Interfaces:**
- Produces: `uploadFile(file: File): Promise<SharedFileMeta>`（lib/api.ts）；`<EmojiPicker onPick={(e: string) => void} />`；气泡附件渲染（图片缩略图 `<img src={resolveUrl("/api/files/"+id+"/content")}>`、其他文件卡片可点下载）。
- Consumes: Task 1 的 `payload.file` 与 content 路由；`send_message` WS。

- [ ] **Step 1: 写失败测试**

`api.test.ts` 追加（沿用该文件 fetch mock 模式）：

```ts
it("uploadFile POST base64 并返回 meta", async () => {
  // mock fetch 返回 201 meta；构造 new File(["ab"], "a.txt", { type: "text/plain" })
  // await uploadFile(file) 断言 fetch 调用 /api/files、body.contentBase64 === "YWI="、name/mime 正确
});
```

`EmojiPicker.test.tsx` 新建：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "./EmojiPicker.js";

describe("EmojiPicker", () => {
  it("点表情回调所选字符", () => {
    const onPick = vi.fn();
    render(<EmojiPicker onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "😀" }));
    expect(onPick).toHaveBeenCalledWith("😀");
  });
});
```

`ChatPage.test.tsx` 追加：

```tsx
it("输入区有表情/图片/文件/语音/发送按钮，布局为工具行+输入行", async () => {
  expect(screen.getByLabelText("表情")).toBeTruthy();
  expect(screen.getByLabelText("图片")).toBeTruthy();
  expect(screen.getByLabelText("文件")).toBeTruthy();
  expect(screen.getByLabelText("语音输入")).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
});

it("点表情按钮弹选择器，选中后追加进输入框", async () => {
  fireEvent.click(screen.getByLabelText("表情"));
  fireEvent.click(await screen.findByRole("button", { name: "😀" }));
  expect((screen.getByPlaceholderText("输入消息…") as HTMLInputElement).value).toBe("😀");
});

it("渲染带 file 的消息为附件卡（非图片显示文件名）", async () => {
  // setMessages 注入一条 payload:{ text:"", file:{ id:"f1", name:"报告.pdf", mime:"application/pdf", size:10 } }
  // 断言 文件名 出现在气泡内
});
```

（ChatPage 用例均沿用该文件既有 store/mock 夹具。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @heming/web test -- uploadFile EmojiPicker ChatPage`
Expected: FAIL。

- [ ] **Step 3: 实现**

`icons.tsx` 追加：

```tsx
export const SmileIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </svg>
);
export const ImageIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="M4 17l4.5-4.5 3 3L15 12l5 5" />
  </svg>
);
export const MicIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9.5" y="3" width="5" height="11" rx="2.5" />
    <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
  </svg>
);
```

`lib/api.ts` 追加（App.tsx 的上传逻辑下沉）：

```ts
export async function uploadFile(file: File): Promise<SharedFileMeta> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (const b of bytes) binary += String.fromCharCode(b);
  return api<SharedFileMeta>("/api/files", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      mime: file.type || "application/octet-stream",
      contentBase64: btoa(binary),
    }),
  });
}

export function fileContentUrl(id: string): string {
  return resolveUrl(`/api/files/${id}/content`);
}
```

`App.tsx` `onUpload` 改为：创建 input → `await uploadFile(file)` → `refreshFiles()`；catch 里保留现有 `alert` 提示（去掉手工 base64 段）。

`EmojiPicker.tsx` 新建：

```tsx
const EMOJIS = [
  "😀", "😄", "😁", "😂", "🤣", "😊", "😍", "😘",
  "😎", "🤔", "😅", "😭", "👍", "👏", "🎉", "🔥",
  "💯", "🙏", "✅", "❌",
];

/** 表情选择器（输入栏上方浮层，点选插入草稿）。 */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="absolute bottom-full left-12 z-40 mb-1 grid w-[220px] grid-cols-8 gap-1 rounded-xl border border-[#ececec] bg-white p-2 shadow-card">
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          className="rounded p-1 text-[17px] leading-none hover:bg-[#f3f3f3]"
          onClick={() => onPick(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
```

`ChatPage.tsx` 输入区改造（替换原 `<form>` 内布局，保留 send/pickMention/onDraftChange/未绑定拦截等既有逻辑）：

```tsx
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ start(): void; stop(): void } | null>(null);
```

状态清理：既有 convId 切换 effect 里补 `setEmojiOpen(false); setListening(false);`。

工具行 + 输入行 JSX（form 结构不变，onSubmit 仍为 send）：

```tsx
        {/* 工具行：表情 / 图片 / 文件（左上角）；群会话保留 @ */}
        <div className="flex items-center gap-1 px-5 pt-2">
          <button type="button" aria-label="表情" className={`rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]${emojiOpen ? " bg-[#f3f3f3]" : ""}`} onClick={() => setEmojiOpen((v) => !v)}>
            <SmileIcon width={16} height={16} />
          </button>
          <button type="button" aria-label="图片" className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]" onClick={() => pickFile("image/*")}>
            <ImageIcon width={16} height={16} />
          </button>
          <button type="button" aria-label="文件" className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]" onClick={() => pickFile(undefined)}>
            <FileIcon width={16} height={16} />
          </button>
          {isGroup && (
            <button type="button" aria-label="提及智能体" className="ml-1 rounded-lg border border-line px-2 text-sm text-muted hover:bg-[#f3f3f3]" onClick={() => setPicker({ via: "button", query: "" })}>
              @
            </button>
          )}
        </div>
        <div className="relative flex gap-2 px-5 py-3">
          {emojiOpen && (
            <EmojiPicker
              onPick={(e) => {
                setDraft((d) => d + e);
                setEmojiOpen(false);
              }}
            />
          )}
          <input
            className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            aria-label="语音输入"
            className={`rounded-lg border px-2.5 ${listening ? "border-ink bg-ink text-white" : "border-line text-muted hover:bg-[#f3f3f3]"}`}
            onClick={toggleVoice}
          >
            <MicIcon width={16} height={16} />
          </button>
          <button type="submit" className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white">
            发送
          </button>
        </div>
```

处理函数（组件内、send 旁）：

```tsx
  const MAX_UPLOAD = 6 * 1024 * 1024; // 服务端 json 上限 8MB，base64 膨胀后 6MB 安全

  const pickFile = (accept: string | undefined) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void sendFile(f);
    };
    input.click();
  };

  const sendFile = async (f: File) => {
    const handle = wsHandleRef.current;
    if (!handle) {
      setSendNotice("连接未就绪，消息未发送");
      return;
    }
    if (f.size > MAX_UPLOAD) {
      setSendNotice("文件需小于 6MB");
      return;
    }
    try {
      const meta = await uploadFile(f);
      handle.send({
        type: "send_message",
        conversationId: convId,
        payload: {
          text: "",
          file: { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size },
        },
      });
      setSendNotice(null);
    } catch (err) {
      setSendNotice(`上传失败：${(err as Error).message}`);
    }
  };

  const toggleVoice = () => {
    const SR =
      (window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
    if (!SR) {
      setSendNotice("当前环境不支持语音输入");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new (SR as unknown as new () => {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void;
      onerror: () => void;
      start(): void;
      stop(): void;
    })();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setDraft((d) => (d ? `${d}${t}` : t));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => {
      setListening(false);
      setSendNotice("语音识别不可用");
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };
```

气泡渲染：`messages.map` 内文本下方加附件段（text 空且有 file 时只渲染附件）：

```tsx
                {m.payload.text ? renderTextWithMentions(m.payload.text, m.payload.mentions) : null}
                {m.payload.file &&
                  (m.payload.file.mime.startsWith("image/") ? (
                    <img
                      src={fileContentUrl(m.payload.file.id)}
                      alt={m.payload.file.name}
                      className="mt-1 max-h-40 rounded-md object-cover"
                    />
                  ) : (
                    <a
                      href={fileContentUrl(m.payload.file.id)}
                      download={m.payload.file.name}
                      className="mt-1 flex items-center gap-2 rounded-md border border-line bg-white px-2 py-1.5 text-[12px] shadow-card hover:bg-[#f7f7f7]"
                    >
                      <FileIcon width={15} height={15} />
                      <span className="min-w-0 truncate">{m.payload.file.name}</span>
                      <span className="shrink-0 text-[10px] text-muted">
                        {(m.payload.file.size / 1024).toFixed(1)} KB
                      </span>
                    </a>
                  ))}
```

import 补：`SmileIcon, ImageIcon, FileIcon, MicIcon`、`EmojiPicker`、`uploadFile, fileContentUrl`。卸载 effect 里补 `recRef.current?.stop()`。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @heming/web test`
Expected: 全绿。

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/api.test.ts packages/web/src/App.tsx packages/web/src/components/icons.tsx packages/web/src/components/EmojiPicker.tsx packages/web/src/components/EmojiPicker.test.tsx packages/web/src/components/ChatPage.tsx packages/web/src/components/ChatPage.test.tsx
git commit -m "feat: 聊天输入栏表情/图片/文件/语音与附件气泡"
```

---

### Task 5: 工作区——雷达点击进详情页 + 其余头像滚入右侧分组列

**Files:**
- Modify: `packages/web/src/store/ui.ts`（detailContact 状态）
- Create: `packages/web/src/components/ContactColumn.tsx` + test
- Create: `packages/web/src/components/ContactDetail.tsx` + test
- Modify: `packages/web/src/components/WorkspacePage.tsx`（三态布局）
- Modify: `packages/web/src/components/RadarContacts.tsx`（非 overlay 点击改为开详情；保留悬浮卡与 overlay 行为）
- Test: `packages/web/src/store/ui.test.ts`、`WorkspacePage.test.tsx`、`RadarContacts.test.tsx`（追加）

**Interfaces:**
- Produces: `useUiStore.detailContact: { kind: "group" | "human" | "agent"; id: string } | null`；`openContactDetail(kind, id)`；`closeContactDetail()`（`setPage` 时一并清空）。组件 `<ContactColumn active={…} />`（宽 84px 竖列：群聊段 → 分割线 → 人类段 → 分割线 → 智能体段；`rollIn` 逐项错峰动画）、`<ContactDetail target={…} />`。
- Consumes: `useChatStore`（conversations/friends/agentsRoster/agentIdsInGroups/messages/openDirect）、`openConversation`、`AgentFormModal`（编辑自有智能体）。

- [ ] **Step 1: 写失败测试**

`ui.test.ts` 追加：

```ts
it("openContactDetail/closeContactDetail 与 setPage 清空", () => {
  const s = useUiStore.getState();
  s.openContactDetail("human", "u1");
  expect(useUiStore.getState().detailContact).toEqual({ kind: "human", id: "u1" });
  useUiStore.getState().setPage("home");
  expect(useUiStore.getState().detailContact).toBeNull();
  useUiStore.getState().openContactDetail("agent", "a1");
  useUiStore.getState().closeContactDetail();
  expect(useUiStore.getState().detailContact).toBeNull();
});
```

`ContactColumn.test.tsx` 新建：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactColumn } from "./ContactColumn.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

describe("ContactColumn", () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [
        { id: "g1", type: "group", name: "群一", memberCount: 2, unreadCount: 0 },
      ] as never,
      friends: [
        { userId: "f1", user: { id: "u1", username: "bob", displayName: "鲍勃" } },
      ] as never,
      agentsRoster: [
        { id: "a1", owner_id: "me", name: "阿智", description: "" },
      ] as never,
      agentIdsInGroups: new Set<string>(),
      messages: {},
    });
    useUiStore.setState({ detailContact: { kind: "human", id: "u1" } });
  });

  it("上至下 群聊/人类/智能体 分段并以分割线划分", () => {
    render(<ContactColumn />);
    const labels = screen.getAllByText(/群聊|人类|智能体/).map((n) => n.textContent);
    expect(labels.slice(0, 3)).toEqual(["群聊", "人类", "智能体"]);
    expect(screen.getByText("群一")).toBeTruthy();
    expect(screen.getByText("鲍勃")).toBeTruthy();
    expect(screen.getByText("阿智")).toBeTruthy();
  });

  it("点头像切 detailContact", () => {
    render(<ContactColumn />);
    fireEvent.click(screen.getByLabelText("查看 群一"));
    expect(useUiStore.getState().detailContact).toEqual({ kind: "group", id: "g1" });
  });

  it("当前项高亮（aria-current）", () => {
    render(<ContactColumn />);
    expect(screen.getByLabelText("查看 鲍勃").getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("查看 群一").getAttribute("aria-current")).toBe("null");
  });
});
```

（friend 行形状以 `chat.ts` 实际类型为准——若 friends 元素直接是 User 数组则相应调整。）

`ContactDetail.test.tsx` 新建：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactDetail } from "./ContactDetail.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

describe("ContactDetail", () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [
        { id: "g1", type: "group", name: "群一", memberCount: 3, unreadCount: 0 },
      ] as never,
      friends: [
        { user: { id: "u1", username: "bob", displayName: "鲍勃" } },
      ] as never,
      agentsRoster: [
        { id: "a1", owner_id: "me", name: "阿智", description: "助手" },
      ] as never,
      agentIdsInGroups: new Set<string>(["a1"]),
      messages: {},
    });
  });

  it("human 详情显示昵称/@用户名与发消息", () => {
    render(<ContactDetail target={{ kind: "human", id: "u1" }} />);
    expect(screen.getByText("鲍勃")).toBeTruthy();
    expect(screen.getByText("@bob")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发消息" })).toBeTruthy();
  });

  it("group 详情显示人数；点发消息打开会话", () => {
    render(<ContactDetail target={{ kind: "group", id: "g1" }} />);
    expect(screen.getByText(/3 人/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发消息" }));
    expect(useUiStore.getState().activeConversationId).toBe("g1");
    expect(useUiStore.getState().page).toBe("chat");
  });

  it("agent 详情显示简介，发消息禁用，返回雷达可用", () => {
    render(<ContactDetail target={{ kind: "agent", id: "a1" }} />);
    expect(screen.getByText("助手")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发消息" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "返回雷达" }));
    expect(useUiStore.getState().detailContact).toBeNull();
  });
});
```

`WorkspacePage.test.tsx` 追加：无 detailContact 时渲染雷达（`通讯录 · 雷达` 存在）；设 detailContact 后渲染列+详情（`返回雷达` 存在、雷达标题消失）。

`RadarContacts.test.tsx` 追加：非 overlay 模式点人类节点 → `detailContact` 被设置（而不是直接进会话）；overlay 模式点节点 → 仍走 `openConversation`（既有用例若已断言此行为则不动）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @heming/web test -- Contact ui WorkspacePage RadarContacts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`ui.ts`：

```ts
export type ContactKind = "group" | "human" | "agent";
```

interface 与初始值、action：

```ts
  detailContact: { kind: ContactKind; id: string } | null;
  openContactDetail: (kind: ContactKind, id: string) => void;
  closeContactDetail: () => void;
```

```ts
  detailContact: null,
  openContactDetail: (kind, id) => set({ detailContact: { kind, id } }),
  closeContactDetail: () => set({ detailContact: null }),
```

`setPage` 内追加 `detailContact: null`。

`ContactColumn.tsx` 新建（数据口径与雷达一致：群=conversations group；人类=friends；智能体=「在任一群 members ∪ 自有」roster 过滤）：

```tsx
import type { Conversation } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore, type ContactKind } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { Avatar } from "./Avatar.js";

/** 雷达旁竖列：群聊 / 人类 / 智能体 分段，分割线划分；滚入动画错峰。 */
export function ContactColumn() {
  const conversations = useChatStore((s) => s.conversations);
  const friends = useChatStore((s) => s.friends);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const agentIdsInGroups = useChatStore((s) => s.agentIdsInGroups);
  const me = useAuthStore((s) => s.user);
  const active = useUiStore((s) => s.detailContact);
  const openContactDetail = useUiStore((s) => s.openContactDetail);

  const groups = conversations.filter(
    (c): c is Extract<Conversation, { type: "group" }> => c.type === "group",
  );
  const humans = friends.map((f) => f.user);
  const agents = agentsRoster.filter(
    (a) => agentIdsInGroups.has(a.id) || (me != null && a.owner_id === me.id),
  );

  const sections: { label: string; kind: ContactKind; items: { id: string; name: string; avatar?: string }[] }[] = [
    { label: "群聊", kind: "group", items: groups.map((g) => ({ id: g.id, name: g.name })) },
    { label: "人类", kind: "human", items: humans.map((u) => ({ id: u.id, name: u.displayName, avatar: u.avatar })) },
    { label: "智能体", kind: "agent", items: agents.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar ?? undefined })) },
  ];

  let idx = 0;
  return (
    <aside className="flex w-[84px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line-soft py-3" aria-label="联系人列">
      <style>{`@keyframes rollIn { from { opacity:0; transform:translateX(-16px);} }
aside[aria-label="联系人列"] a, aside[aria-label="联系人列"] button { animation: rollIn .34s ease backwards; }`}</style>
      {sections.map((sec, si) => (
        <div key={sec.label} className="flex w-full flex-col items-center">
          {si > 0 && <div className="my-2 h-px w-14 bg-[#e6e6e6]" />}
          <div className="mb-1 text-[9px] font-bold tracking-wider text-[#bbb]">{sec.label}</div>
          {sec.items.map((it) => {
            const delay = `${idx++ * 0.03}s`;
            const current = active?.kind === sec.kind && active.id === it.id;
            return (
              <button
                key={it.id}
                type="button"
                aria-label={`查看 ${it.name}`}
                aria-current={current || undefined}
                style={{ animationDelay: delay }}
                className={`flex w-[76px] flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-[#f7f7f7]${
                  current ? " bg-[#f3f3f3]" : ""
                }`}
                onClick={() => openContactDetail(sec.kind, it.id)}
              >
                <Avatar user={{ displayName: it.name, avatar: it.avatar }} size={32} />
                <span className="w-full truncate text-center text-[10px] text-[#555]">{it.name}</span>
              </button>
            );
          })}
          {sec.items.length === 0 && <div className="text-[9px] text-[#ccc]">暂无</div>}
        </div>
      ))}
    </aside>
  );
}
```

`ContactDetail.tsx` 新建：

```tsx
import { useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore, type ContactKind } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { Avatar } from "./Avatar.js";
import { AgentFormModal } from "./AgentFormModal.js";

/** 联系人详情页：头像大卡 + 类型信息 + 发消息/编辑/返回雷达。 */
export function ContactDetail({ target }: { target: { kind: ContactKind; id: string } }) {
  const conversations = useChatStore((s) => s.conversations);
  const friends = useChatStore((s) => s.friends);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const agentIdsInGroups = useChatStore((s) => s.agentIdsInGroups);
  const messages = useChatStore((s) => s.messages);
  const openDirect = useChatStore((s) => s.openDirect);
  const me = useAuthStore((s) => s.user);
  const openConversation = useUiStore((s) => s.openConversation);
  const closeContactDetail = useUiStore((s) => s.closeContactDetail);
  const [editAgent, setEditAgent] = useState(false);

  const group = target.kind === "group" ? conversations.find((c) => c.id === target.id && c.type === "group") : undefined;
  const human = target.kind === "human" ? friends.map((f) => f.user).find((u) => u.id === target.id) : undefined;
  const agent = target.kind === "agent" ? agentsRoster.find((a) => a.id === target.id) : undefined;

  if (!group && !human && !agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <p className="text-[13px]">未找到该联系人</p>
        <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card" onClick={closeContactDetail}>
          返回雷达
        </button>
      </div>
    );
  }

  const title = group?.name ?? human?.displayName ?? agent?.name ?? "";
  const kindLabel = target.kind === "group" ? "群聊" : target.kind === "human" ? "人类" : "智能体";
  const directConv = human ? conversations.find((c) => c.type === "direct" && c.peer.id === human.id) : undefined;
  const convForLast = group ?? directConv;
  const lastMsg = convForLast ? (messages[convForLast.id] ?? []).slice(-1)[0] : undefined;
  const agentOwned = agent != null && me != null && agent.owner_id === me.id;
  const inGroup = agent != null && agentIdsInGroups.has(agent.id);

  const onSend = () => {
    if (group) {
      openConversation(group.id);
    } else if (human) {
      const go = (id: string) => openConversation(id);
      if (directConv) go(directConv.id);
      else void openDirect(human.id).then(go);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="w-[340px] rounded-2xl border border-[#ececec] bg-white p-6 shadow-card">
        <div className="flex items-center gap-3.5">
          <Avatar user={{ displayName: title, avatar: human?.avatar ?? agent?.avatar }} size={40} className="border-2 border-white shadow-card" />
          <div className="min-w-0">
            <div className="truncate text-[17px] font-extrabold">{title}</div>
            <div className="text-[11px] text-muted">
              {kindLabel}
              {human ? ` · @${human.username}` : ""}
              {group ? ` · ${group.memberCount} 人` : ""}
              {agent ? (inGroup ? " · 已入群" : " · 未入群") : ""}
            </div>
          </div>
        </div>
        {agent?.description && (
          <p className="mt-3 border-t border-[#f1f1f1] pt-3 text-[12px] leading-relaxed text-[#555]">{agent.description}</p>
        )}
        {lastMsg && (
          <p className="mt-2 truncate text-[11px] text-muted">最近消息：{lastMsg.payload.text || "(附件)"}</p>
        )}
        <div className="mt-4 flex gap-2">
          {agentOwned && agent && (
            <button type="button" className="flex-1 rounded-lg border border-line py-2 text-[12px] shadow-card" onClick={() => setEditAgent(true)}>
              编辑
            </button>
          )}
          <button
            type="button"
            disabled={!!agent}
            title={agent ? "智能体对话在群内 @" : undefined}
            className="flex-1 rounded-lg bg-ink py-2 text-[12px] font-bold text-white disabled:cursor-default disabled:bg-[#e6e6e6] disabled:text-[#999]"
            onClick={onSend}
          >
            发消息
          </button>
        </div>
        <button type="button" className="mt-2 w-full rounded-lg border border-line py-1.5 text-[12px] text-muted shadow-card" onClick={closeContactDetail}>
          返回雷达
        </button>
      </div>
      {editAgent && agent && (
        <AgentFormModal open mode="edit" agent={agent} onClose={() => setEditAgent(false)} />
      )}
    </div>
  );
}
```

`WorkspacePage.tsx`：

```tsx
import { useUiStore } from "../store/ui.js";
import { RadarContacts } from "./RadarContacts.js";
import { ContactColumn } from "./ContactColumn.js";
import { ContactDetail } from "./ContactDetail.js";

export function WorkspacePage() {
  const detail = useUiStore((s) => s.detailContact);
  if (!detail) return <RadarContacts />;
  return (
    <div className="flex h-full min-h-0">
      <ContactColumn />
      <div className="min-w-0 flex-1">
        <ContactDetail target={detail} />
      </div>
    </div>
  );
}
```

`RadarContacts.tsx` 节点 onClick（仅非 overlay 改道；overlay=聊天页呼出层保持直进会话）：

```tsx
                onClick={() => {
                  setCard(null);
                  if (overlay) {
                    enter(n);
                  } else {
                    openContactDetail(n.agent ? "agent" : n.peerId ? "human" : "group", n.key);
                  }
                }}
```

import `openContactDetail`（`useUiStore` 取）。悬浮卡按钮不变（发消息/历史会话仍直进会话——快速通道）。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @heming/web test`
Expected: 全绿。

```bash
git add packages/web/src/store/ui.ts packages/web/src/store/ui.test.ts packages/web/src/components/ContactColumn.tsx packages/web/src/components/ContactColumn.test.tsx packages/web/src/components/ContactDetail.tsx packages/web/src/components/ContactDetail.test.tsx packages/web/src/components/WorkspacePage.tsx packages/web/src/components/WorkspacePage.test.tsx packages/web/src/components/RadarContacts.tsx packages/web/src/components/RadarContacts.test.tsx
git commit -m "feat: 雷达点击进详情页，其余头像滚入分组竖列"
```

---

### Task 6: 全量验证与文档回填

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-heming-platform-design.md`（§5/§9 一句级回填）
- Modify: `README.md`（能力行一句，若提及聊天/主页）

- [ ] **Step 1: 全量构建与测试**

Run: `pnpm -r build && pnpm -r test`
Expected: exit 0，全绿。

- [ ] **Step 2: 文档回填**

- 平台设计文档 §9 里程碑前补一行「M3.5 UI 完善（热力图/聊天输入栏/雷达详情）」或在 M3 条目后追记一句；§5 工作区段补「雷达点击进详情页 + 分组竖列」一句。
- README 能力行若有聊天描述，补「附件消息/热力图」关键词。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-10-13-heming-platform-design.md README.md
git commit -m "docs: UI 完善批次能力回填"
```
