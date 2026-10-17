import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Agent, Member, Message, User, WsServerEvent } from "@heming/shared";
import { useChatStore } from "./chat.js";
import { api, fetchMembers, fetchMessages, reencryptMessage } from "../lib/api.js";
import { listAgents } from "../lib/agentsApi.js";

// createGroup 走 api()、loadAgents 走 fetchMembers：模块级 mock（其余导出保持真实）
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: vi.fn(), fetchMembers: vi.fn(), fetchMessages: vi.fn(), reencryptMessage: vi.fn() };
});
// loadAgentsRoster 走 listAgents：同款模块级 mock
vi.mock("../lib/agentsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agentsApi.js")>();
  return { ...actual, listAgents: vi.fn() };
});

const rosterA1: Agent = { id: "a1", owner_id: null, name: "和小鸣", avatar: null, description: "官方" };
const rosterA2: Agent = { id: "a2", owner_id: "u1", name: "架构师", avatar: null, description: "d" };

const msg = (id: string, text: string): Message => ({
  id,
  conversationId: "c1",
  senderType: "user",
  senderId: "u1",
  payload: { text },
  replyTo: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  recalledAt: null,
  enc: "plain",
});

const msgAt = (id: string, text: string, createdAt: string): Message => ({
  ...msg(id, text),
  createdAt,
});

describe("chat store", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // 模块 mock（api/fetchMembers/listAgents）的调用历史逐例归零
    useChatStore.setState({
      conversations: [],
      friends: [],
      incoming: [],
      messages: {},
      agents: [],
      agentsRoster: [],
      agentIdsInGroups: new Set<string>(),
      reads: {},
      streaming: {},
      streamOwner: {},
      openHandler: null,
      plainById: {},
      pendingE2e: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers(); // agent_error 自清用例即便断言失败也不把假时钟泄漏到后续
  });

  it("appendMessage 追加消息", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().appendMessage(msg("m2", "二"));
    const list = useChatStore.getState().messages["c1"];
    expect(list?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("appendMessage 对相同 id 去重（重连重放）", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().appendMessage(msg("m1", "一改"));
    expect(useChatStore.getState().messages["c1"]).toHaveLength(1);
  });

  it("setMessages 合并历史：fetch 期间已入列的新消息不被覆盖", () => {
    // 交错：历史响应落定前，message_new 已经 appendMessage 入列
    useChatStore.getState().appendMessage(msgAt("mNew", "新", "2026-10-13T00:00:05.000Z"));
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史1", "2026-10-13T00:00:01.000Z"),
      msgAt("m2", "历史2", "2026-10-13T00:00:02.000Z"),
    ]);
    const ids = useChatStore.getState().messages["c1"].map((m) => m.id);
    expect(ids).toEqual(["m1", "m2", "mNew"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("setMessages 与本地同 id 去重（历史快照与广播交错）", () => {
    useChatStore.getState().appendMessage(msgAt("m1", "本地", "2026-10-13T00:00:01.000Z"));
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史", "2026-10-13T00:00:01.000Z"),
      msgAt("m2", "历史2", "2026-10-13T00:00:02.000Z"),
    ]);
    const ids = useChatStore.getState().messages["c1"].map((m) => m.id);
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("setMessages 本地独有消息按 createdAt 插入历史中间", () => {
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史1", "2026-10-13T00:00:01.000Z"),
      msgAt("m3", "历史3", "2026-10-13T00:00:03.000Z"),
    ]);
    useChatStore.getState().appendMessage(msgAt("m2", "迟到", "2026-10-13T00:00:02.000Z"));
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史1", "2026-10-13T00:00:01.000Z"),
      msgAt("m3", "历史3", "2026-10-13T00:00:03.000Z"),
    ]);
    const ids = useChatStore.getState().messages["c1"].map((m) => m.id);
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("conversations 联合类型：group 行可读 name/memberCount/unreadCount", () => {
    const peer: User = { id: "u1", username: "alice", displayName: "A" };
    useChatStore.setState({
      conversations: [
        { id: "c1", type: "direct", peer, unreadCount: 0 },
        { id: "g1", type: "group", name: "评审组", memberCount: 3, unreadCount: 2 },
      ],
    });
    const groups = useChatStore.getState().conversations.filter((c) => c.type === "group");
    expect(groups[0].type === "group" && groups[0].name).toBe("评审组");
    expect(groups[0].unreadCount).toBe(2);
    const directs = useChatStore.getState().conversations.filter((c) => c.type === "direct");
    expect(directs[0].type === "direct" && directs[0].peer.username).toBe("alice");
  });

  it("createGroup：POST /api/conversations 后 reload 并返回新 id", async () => {
    vi.mocked(api).mockResolvedValue({ id: "g9", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 });
    const loadWorkspace = vi
      .spyOn(useChatStore.getState(), "loadWorkspace")
      .mockResolvedValue(undefined);
    const id = await useChatStore.getState().createGroup("评审组", ["u2", "u3"]);
    expect(id).toBe("g9");
    expect(api).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = vi.mocked(api).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ name: "评审组", memberIds: ["u2", "u3"] });
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    loadWorkspace.mockRestore();
  });

  it("loadAgents：逐群拉 members，kind=agent 按 id 去重并 join 名册（owner/description 来自 roster）", async () => {
    const agentA: Member = { kind: "agent", id: "a1", name: "和小鸣", avatar: null, user: null };
    const agentB: Member = { kind: "agent", id: "a2", name: "架构师", avatar: null, user: null };
    const human: Member = {
      kind: "user",
      id: "u9",
      name: "路人",
      avatar: null,
      user: { id: "u9", username: "passer", displayName: "路人" },
    };
    vi.mocked(fetchMembers).mockImplementation(async (convId) => {
      // g1 与 g2 都含 a1（跨群重复）、g1 另含 a2 与一个人类成员（应被过滤）
      if (convId === "g1") return [human, agentA, agentB];
      return [agentA];
    });
    useChatStore.setState({
      conversations: [
        { id: "g1", type: "group", name: "预设群", memberCount: 4, unreadCount: 0 },
        { id: "g2", type: "group", name: "评审组", memberCount: 2, unreadCount: 0 },
      ],
      agentsRoster: [rosterA1, rosterA2],
      agents: [],
    });
    await useChatStore.getState().loadAgents();
    expect(fetchMembers).toHaveBeenCalledWith("g1");
    expect(fetchMembers).toHaveBeenCalledWith("g2");
    expect(useChatStore.getState().agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    // join 拿到 roster 的 owner/description（Member 行升级为名册全量行）
    expect(useChatStore.getState().agents[1].owner_id).toBe("u1");
    expect(useChatStore.getState().agents[1].description).toBe("d");
    expect(useChatStore.getState().agentIdsInGroups).toEqual(new Set(["a1", "a2"]));
  });

  it("loadAgents：群 members 拉取失败不炸（其余群照常收集）；roster 无此 id 时跳过不占位", async () => {
    const agentA: Member = { kind: "agent", id: "a1", name: "和小鸣", avatar: null, user: null };
    const agentGhost: Member = { kind: "agent", id: "a9", name: "幽灵", avatar: null, user: null };
    vi.mocked(fetchMembers).mockImplementation(async (convId) => {
      if (convId === "bad") throw new Error("forbidden");
      return [agentA, agentGhost]; // a9 不在 roster → join 跳过
    });
    useChatStore.setState({
      conversations: [
        { id: "bad", type: "group", name: "坏群", memberCount: 1, unreadCount: 0 },
        { id: "g2", type: "group", name: "好群", memberCount: 2, unreadCount: 0 },
      ],
      agentsRoster: [rosterA1],
      agents: [],
    });
    await expect(useChatStore.getState().loadAgents()).resolves.toBeUndefined();
    expect(useChatStore.getState().agents.map((a) => a.id)).toEqual(["a1"]);
    expect(useChatStore.getState().agentIdsInGroups.has("a9")).toBe(true); // id 集合照收
  });

  it("loadAgentsRoster：GET /api/agents 全量入册并重算 join（已收集的群内 id 随 roster 刷新）", async () => {
    vi.mocked(listAgents).mockResolvedValue([rosterA1, rosterA2]);
    useChatStore.setState({
      agentIdsInGroups: new Set(["a1", "a2", "a9"]),
      agents: [],
    });
    await useChatStore.getState().loadAgentsRoster();
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().agentsRoster.map((a) => a.id)).toEqual(["a1", "a2"]);
    // 重算 join：a9 不在 roster 跳过，a1/a2 从名册带出
    expect(useChatStore.getState().agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(useChatStore.getState().agents[0].description).toBe("官方");
  });

  it("setReads 覆盖该会话已读状态（其他会话不受影响）", () => {
    useChatStore.getState().setReads("c2", [{ userId: "u9", at: "2026-10-13T00:00:00.000Z" }]);
    useChatStore.getState().setReads("c1", [{ userId: "u1", at: "2026-10-14T01:00:00.000Z" }]);
    expect(useChatStore.getState().reads["c1"]).toHaveLength(1);
    expect(useChatStore.getState().reads["c1"][0].at).toBe("2026-10-14T01:00:00.000Z");
    // c2 的既有读态保留（按会话分桶，不整表覆盖）
    expect(useChatStore.getState().reads["c2"][0].userId).toBe("u9");
  });

  it("loadReads 拉取 GET /api/conversations/:id/reads 并写入该会话", async () => {
    vi.mocked(api).mockResolvedValue([{ userId: "u2", at: "2026-10-14T01:00:00.000Z" }]);
    await useChatStore.getState().loadReads("c1");
    expect(api).toHaveBeenCalledWith("/api/conversations/c1/reads");
    expect(useChatStore.getState().reads["c1"]).toEqual([
      { userId: "u2", at: "2026-10-14T01:00:00.000Z" },
    ]);
  });

  // —— M3 Task 8：流式管道收口（streaming/streamOwner/onWsEvent）——

  const chunk = (streamId: string, text: string): WsServerEvent => ({
    type: "agent_chunk",
    conversationId: "c1",
    agentId: "a1",
    streamId,
    text,
  });

  it("upsertStream 首帧建项（默认值补齐）、后续 patch 合并；removeStream 移除", () => {
    useChatStore
      .getState()
      .upsertStream("s1", { agentId: "a1", conversationId: "c1", text: "你", status: "streaming" });
    expect(useChatStore.getState().streaming["s1"]).toEqual({
      agentId: "a1",
      conversationId: "c1",
      text: "你",
      status: "streaming",
      lastAt: expect.any(Number), // Task 7 watchdog：写入即打时间戳
    });
    // 合并：不带 text 的 patch 保留已累积文本
    useChatStore
      .getState()
      .upsertStream("s1", { agentId: "a1", conversationId: "c1", status: "error", errorMessage: "HTTP 401" });
    expect(useChatStore.getState().streaming["s1"]).toMatchObject({
      text: "你",
      status: "error",
      errorMessage: "HTTP 401",
    });
    useChatStore.getState().removeStream("s1");
    expect(useChatStore.getState().streaming["s1"]).toBeUndefined();
  });

  it("onWsEvent agent_chunk：本机流（已标 owner）跳过不重复累积，他机流按 text 累加", () => {
    useChatStore.getState().markStreamOwner("mine");
    useChatStore.getState().onWsEvent(chunk("mine", "你"));
    expect(useChatStore.getState().streaming["mine"]).toBeUndefined(); // 触发端已本地累积

    useChatStore.getState().onWsEvent(chunk("other", "你"));
    useChatStore.getState().onWsEvent(chunk("other", "好"));
    expect(useChatStore.getState().streaming["other"]).toEqual({
      agentId: "a1",
      conversationId: "c1",
      text: "你好",
      status: "streaming",
      lastAt: expect.any(Number), // chunk 累积时刷新
    });
  });

  it("onWsEvent message_new：带 streamId 移除 streaming 项，不带则不动", () => {
    useChatStore
      .getState()
      .upsertStream("s1", { agentId: "a1", conversationId: "c1", text: "你", status: "streaming" });
    const m = { ...msg("m1", "你好"), senderType: "agent" as const, senderId: "a1" };
    useChatStore.getState().onWsEvent({ type: "message_new", message: m });
    expect(useChatStore.getState().streaming["s1"]).toBeDefined(); // 普通消息不误删
    useChatStore.getState().onWsEvent({ type: "message_new", message: m, streamId: "s1" });
    expect(useChatStore.getState().streaming["s1"]).toBeUndefined();
  });

  it("onWsEvent agent_error：本机流置 error 保留供重试，他机流短暂显示后自清", () => {
    vi.useFakeTimers();
    useChatStore.getState().markStreamOwner("mine");
    useChatStore
      .getState()
      .upsertStream("mine", { agentId: "a1", conversationId: "c1", text: "半", status: "streaming" });
    useChatStore
      .getState()
      .upsertStream("his", { agentId: "a2", conversationId: "c1", text: "半", status: "streaming" });

    const err = (streamId: string, agentId: string): WsServerEvent => ({
      type: "agent_error",
      conversationId: "c1",
      agentId,
      streamId,
      code: "provider_error",
      message: "HTTP 401",
    });
    useChatStore.getState().onWsEvent(err("mine", "a1"));
    useChatStore.getState().onWsEvent(err("his", "a2"));

    expect(useChatStore.getState().streaming["mine"]).toMatchObject({
      status: "error",
      errorMessage: "HTTP 401",
      text: "半",
    });
    expect(useChatStore.getState().streaming["his"]).toMatchObject({ status: "error" });

    vi.advanceTimersByTime(6000);
    expect(useChatStore.getState().streaming["his"]).toBeUndefined(); // 他机流自清
    expect(useChatStore.getState().streaming["mine"]).toBeDefined(); // 本机流保留（重试入口）
  });

  it("I1 clearStreamsForConversation：只清本 convId 的 streaming 项与其 streamOwner 键", () => {
    useChatStore.getState().markStreamOwner("mine-c1");
    useChatStore.getState().markStreamOwner("his-c2");
    useChatStore
      .getState()
      .upsertStream("mine-c1", { agentId: "a1", conversationId: "c1", text: "半", status: "streaming" });
    useChatStore
      .getState()
      .upsertStream("his-c2", { agentId: "a2", conversationId: "c2", text: "别处", status: "streaming" });

    useChatStore.getState().clearStreamsForConversation("c1");

    const st = useChatStore.getState();
    expect(Object.keys(st.streaming)).toEqual(["his-c2"]); // 本会话孤儿清空
    expect(st.streamOwner).toEqual({ "his-c2": true }); // 归属键同步清；他会话不受影响
    // 幂等：再清一次无副作用
    useChatStore.getState().clearStreamsForConversation("c1");
    expect(Object.keys(useChatStore.getState().streaming)).toEqual(["his-c2"]);
  });

  it("attachAgentToGroup / detachAgentFromGroup：POST/DELETE 路径与 body", async () => {
    vi.mocked(api).mockResolvedValue(undefined);
    await useChatStore.getState().attachAgentToGroup("g1", "a1");
    expect(api).toHaveBeenCalledWith(
      "/api/conversations/g1/agents",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = vi.mocked(api).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ agentId: "a1" });

    await useChatStore.getState().detachAgentFromGroup("g1", "a1");
    expect(api).toHaveBeenCalledWith(
      "/api/conversations/g1/agents/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  // —— 二期 IM Task 2：message_recalled 处理（置 recalledAt，列表不移除）——

  it("onWsEvent message_recalled：对应消息置 recalledAt，其余与列表长度不变", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().appendMessage(msg("m2", "二"));
    useChatStore.getState().onWsEvent({
      type: "message_recalled",
      conversationId: "c1",
      messageId: "m1",
      at: "2026-10-17T01:00:00.000Z",
    });
    const list = useChatStore.getState().messages["c1"];
    expect(list).toHaveLength(2); // 不移除
    expect(list.find((m) => m.id === "m1")?.recalledAt).toBe("2026-10-17T01:00:00.000Z");
    expect(list.find((m) => m.id === "m2")?.recalledAt).toBeNull(); // 其余不动
  });

  it("onWsEvent message_recalled：未知会话/未知消息静默忽略（不抛不建空表）", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    expect(() =>
      useChatStore.getState().onWsEvent({
        type: "message_recalled",
        conversationId: "ghost",
        messageId: "x",
        at: "2026-10-17T01:00:00.000Z",
      }),
    ).not.toThrow();
    expect(useChatStore.getState().messages["ghost"]).toBeUndefined();
    useChatStore.getState().onWsEvent({
      type: "message_recalled",
      conversationId: "c1",
      messageId: "nope",
      at: "2026-10-17T01:00:00.000Z",
    });
    const list = useChatStore.getState().messages["c1"];
    expect(list).toHaveLength(1);
    expect(list[0].recalledAt).toBeNull();
  });

  // —— 二期 IM Task 6：message_updated 处理（按 id 整条替换，列表长度不变）——

  it("onWsEvent message_updated：按 id 整条替换（含 reactions），其余消息不动", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().appendMessage(msg("m2", "二"));
    useChatStore.getState().onWsEvent({
      type: "message_updated",
      message: {
        ...msg("m1", "一"),
        payload: { text: "一", reactions: [{ emoji: "👍", userIds: ["u2"] }] },
      },
    });
    const list = useChatStore.getState().messages["c1"];
    expect(list).toHaveLength(2); // 整条替换，不追加/不移除
    expect(list.find((m) => m.id === "m1")?.payload.reactions).toEqual([
      { emoji: "👍", userIds: ["u2"] },
    ]);
    expect(list.find((m) => m.id === "m2")?.payload.reactions).toBeUndefined(); // 其余不动
  });

  it("onWsEvent message_updated：未知会话/未知消息静默忽略（不抛不建空表）", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    expect(() =>
      useChatStore.getState().onWsEvent({
        type: "message_updated",
        message: { ...msg("m1", "一"), conversationId: "ghost" },
      }),
    ).not.toThrow();
    expect(useChatStore.getState().messages["ghost"]).toBeUndefined();
    useChatStore.getState().onWsEvent({
      type: "message_updated",
      message: { ...msg("nope", "改我"), payload: { text: "改我", reactions: [] } },
    });
    const list = useChatStore.getState().messages["c1"];
    expect(list).toHaveLength(1);
    expect(list[0].payload.reactions).toBeUndefined();
  });

  // —— 二期 IM Task 7：他机流 watchdog（长时间无收尾 → error 行供手动重试）——

  it("sweepStaleStreams：超时流置 error，新鲜流与已完成流不动", () => {
    const now = 1_000_000;
    useChatStore.setState({
      streaming: {
        stale: { conversationId: "c1", agentId: "a1", text: "x", status: "streaming", lastAt: now - 61_000 },
        fresh: { conversationId: "c1", agentId: "a1", text: "y", status: "streaming", lastAt: now - 5_000 },
        done: { conversationId: "c1", agentId: "a1", text: "z", status: "done", lastAt: now - 99_000 },
      } as never,
      streamOwner: {},
    });
    useChatStore.getState().sweepStaleStreams(now);
    const st = useChatStore.getState().streaming;
    expect(st.stale.status).toBe("error");
    expect(st.stale.errorMessage).toBe("长时间无响应，生成可能已中断");
    expect(st.fresh.status).toBe("streaming"); // 阈值内不动
    expect(st.done.status).toBe("done"); // 非 streaming 状态一律不动
  });

  it("sweepStaleStreams：无过期流时不动引用（不触发多余的重渲染）", () => {
    useChatStore.setState({
      streaming: {
        fresh: { conversationId: "c1", agentId: "a1", text: "y", status: "streaming", lastAt: 999_000 },
      } as never,
      streamOwner: {},
    });
    const before = useChatStore.getState().streaming;
    useChatStore.getState().sweepStaleStreams(1_000_000);
    expect(useChatStore.getState().streaming).toBe(before); // 未变更则保持同引用
  });

  it("onWsEvent agent_chunk：他机流每次累积都刷新 lastAt（watchdog 依据）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    useChatStore.getState().onWsEvent(chunk("s1", "你"));
    expect(useChatStore.getState().streaming["s1"].lastAt).toBe(10_000);
    vi.setSystemTime(25_000);
    useChatStore.getState().onWsEvent(chunk("s1", "好"));
    expect(useChatStore.getState().streaming["s1"].lastAt).toBe(25_000); // 合并时刷新
  });

  // —— Task 7 评审修复：他机流自清 + 恢复流清 errorMessage ——

  it("sweepStaleStreams：他机流（非本机触发）过期项置 error 后短暂显示即自清", () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    useChatStore.setState({
      streaming: {
        remote: { conversationId: "c1", agentId: "a1", text: "x", status: "streaming", lastAt: now - 61_000 },
      } as never,
      streamOwner: {},
    });
    useChatStore.getState().sweepStaleStreams(now);
    expect(useChatStore.getState().streaming.remote.status).toBe("error");
    vi.advanceTimersByTime(6000); // REMOTE_ERROR_TTL_MS
    expect(useChatStore.getState().streaming.remote).toBeUndefined(); // 与 agent_error 同款自清
  });

  it("sweepStaleStreams：本机流（owner）过期项置 error 后保留，不自清", () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    useChatStore.setState({
      streaming: {
        mine: { conversationId: "c1", agentId: "a1", text: "x", status: "streaming", lastAt: now - 61_000 },
      } as never,
      streamOwner: { mine: true },
    });
    useChatStore.getState().sweepStaleStreams(now);
    expect(useChatStore.getState().streaming.mine.status).toBe("error");
    vi.advanceTimersByTime(60_000);
    expect(useChatStore.getState().streaming.mine).toBeDefined(); // 保留供手动重试
  });

  it("onWsEvent agent_chunk：恢复流回到 streaming 并清掉残留 errorMessage（watchdog 误报自愈）", () => {
    useChatStore.setState({
      streaming: {
        s1: {
          conversationId: "c1",
          agentId: "a1",
          text: "半",
          status: "error",
          errorMessage: "长时间无响应，生成可能已中断",
          lastAt: 0,
        },
      } as never,
      streamOwner: {},
    });
    useChatStore.getState().onWsEvent(chunk("s1", "续"));
    const s = useChatStore.getState().streaming["s1"];
    expect(s.status).toBe("streaming");
    expect(s.errorMessage).toBeUndefined(); // 显式清（否则合并会留旧值）
    expect(s.text).toBe("半续");
  });

  // —— E2E Task 4：收信解密注入（setOpenHandler）· agent chunk 密文 · 存量自迁移 ——

  /** e2e 信封消息固件：enc=e2e + 信封四件套（内容在 cipher，payload 恒空——服务端形态）。 */
  const e2eMsg = (id: string, over: Partial<Message> = {}): Message => ({
    ...msg(id, ""),
    enc: "e2e",
    cipher: "Q2lwaGVy",
    chainKid: "kid-1",
    n: 1,
    ...over,
  });

  /** 冲刷 appendMessage → handler 的异步链（void promise + .then 应用）。 */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("setOpenHandler：e2e message_new 经 handler 解密后以明文形态入列（payload/replyTo 来自密文）", async () => {
    const handler = vi.fn(async (_env: { id: string }) => ({
      status: "ok" as const,
      plain: {
        kind: "text" as const,
        text: "解密后的正文",
        replyTo: "m0",
        mentions: [{ agentId: "a1", name: "和小鸣" }],
      },
    }));
    useChatStore.getState().setOpenHandler(handler);

    useChatStore.getState().appendMessage(e2eMsg("m1"));
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      conversationId: "c1",
      id: "m1",
      cipher: "Q2lwaGVy",
      chainKid: "kid-1",
      n: 1,
      senderId: "u1",
    });
    const list = useChatStore.getState().messages.c1!;
    expect(list).toHaveLength(1);
    expect(list[0].payload.text).toBe("解密后的正文");
    expect(list[0].payload.mentions).toEqual([{ agentId: "a1", name: "和小鸣" }]);
    expect(list[0].replyTo).toBe("m0");
    expect(list[0].enc).toBe("e2e"); // 形态仍标信封（plain 自迁移扫描依赖 enc 判别）
    expect(useChatStore.getState().plainById.c1!.m1.kind).toBe("text");
    expect(useChatStore.getState().pendingE2e.c1 ?? []).toHaveLength(0);
  });

  it("defer 挂起出占位与 pending；chaindist 解开后自动重试补齐内容", async () => {
    let opened = false;
    const handler = vi.fn(async (env: { id: string }) => {
      if (env.id === "m-chain") {
        opened = true;
        return {
          status: "ok" as const,
          plain: { kind: "chaindist" as const, dist: { kid: "k1", ck: "c-k", n: 0, createdAt: 1 } },
        };
      }
      if (opened) return { status: "ok" as const, plain: { kind: "text" as const, text: "补发内容" } };
      return { status: "defer" as const };
    });
    useChatStore.getState().setOpenHandler(handler);

    useChatStore.getState().appendMessage(e2eMsg("m1"));
    await flush();
    // 挂起：占位入列（渲染层按「enc=e2e 且无明文」显示无法解密）+ pending 登记
    expect(useChatStore.getState().messages.c1!).toHaveLength(1);
    expect(useChatStore.getState().messages.c1![0].payload.text).toBe("");
    expect(useChatStore.getState().pendingE2e.c1).toEqual(["m1"]);

    // chaindist 到达 → handler 解开（接线层在此 await sweepDeferred）→ 自动重试 pending
    useChatStore.getState().appendMessage(e2eMsg("m-chain", { n: 0 }));
    await flush();

    const list = useChatStore.getState().messages.c1!;
    expect(list).toHaveLength(1); // chaindist 不入列（控制消息）
    expect(list[0].id).toBe("m1");
    expect(list[0].payload.text).toBe("补发内容"); // 占位被明文替换
    expect(useChatStore.getState().plainById.c1!.m1.kind).toBe("text");
    expect(useChatStore.getState().pendingE2e.c1 ?? []).toHaveLength(0);
    expect(handler.mock.calls.map((c) => c[0].id)).toEqual(["m1", "m-chain", "m1"]);
  });

  it("解不开（failed）→ 占位入列且不进 pending；skip → 完全不入列", async () => {
    const handler = vi.fn(async (env: { id: string }) => {
      if (env.id === "m-bad") return { status: "failed" as const };
      return { status: "skip" as const };
    });
    useChatStore.getState().setOpenHandler(handler);

    useChatStore.getState().appendMessage(e2eMsg("m-bad"));
    useChatStore.getState().appendMessage(e2eMsg("m-skip"));
    await flush();

    const ids = useChatStore.getState().messages.c1!.map((m) => m.id);
    expect(ids).toEqual(["m-bad"]); // failed → 占位；skip → 丢弃
    expect(useChatStore.getState().plainById.c1?.["m-bad"]).toBeUndefined(); // 无明文 → 渲染层「无法解密」
    expect(useChatStore.getState().pendingE2e.c1 ?? []).toHaveLength(0); // 永久失败不挂 pending
    expect(ids).not.toContain("m-skip");
  });

  it("agent_chunk 密文：解密成功累积进打字机；失败/无 handler 跳过该片不崩", async () => {
    let mode: "ok" | "fail" = "ok";
    const handler = vi.fn(
      async (_env: { id: string }, _ctx?: { streamId: string; kind?: string; index?: number }) =>
        mode === "ok"
          ? ({ status: "ok" as const, plain: { kind: "chunk" as const, text: "你" } })
          : ({ status: "failed" as const }),
    );
    useChatStore.getState().setOpenHandler(handler);

    useChatStore.getState().onWsEvent({
      type: "agent_chunk",
      conversationId: "c1",
      agentId: "a1",
      streamId: "s9",
      text: "",
      cipher: "Q2lwaGVy",
      chainKid: "kid-1",
      n: 1,
      index: 0,
    });
    await flush();
    expect(useChatStore.getState().streaming["s9"]?.text).toBe("你");
    expect(handler.mock.calls[0][1]).toEqual({ kind: "chunk", streamId: "s9", index: 0 }); // AAD 上下文注入
    expect(handler.mock.calls[0][0]).toMatchObject({ chainKid: "kid-1", n: 1, cipher: "Q2lwaGVy" });

    // 解不开 → 跳过该片（流式容错：不崩、不追加乱码）
    mode = "fail";
    useChatStore.getState().onWsEvent({
      type: "agent_chunk",
      conversationId: "c1",
      agentId: "a1",
      streamId: "s9",
      text: "",
      cipher: "Q2lwaGVy2",
      chainKid: "kid-1",
      n: 2,
      index: 1,
    });
    await flush();
    expect(useChatStore.getState().streaming["s9"]?.text).toBe("你");
    expect(useChatStore.getState().streaming["s9"]?.status).toBe("streaming"); // 不置错、不抛

    // 无 handler（未注入）→ 同样静默跳过
    useChatStore.getState().setOpenHandler(null);
    useChatStore.getState().onWsEvent({
      type: "agent_chunk",
      conversationId: "c1",
      agentId: "a1",
      streamId: "s9",
      text: "",
      cipher: "Q2lwaGVy3",
      chainKid: "kid-1",
      n: 3,
      index: 2,
    });
    await flush();
    expect(useChatStore.getState().streaming["s9"]?.text).toBe("你");
  });

  it("loadMessages：信封经 handler 合并明文，chaindist/skip 过滤出列表，defer 留占位挂 pending", async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      msg("p1", "明文旧消息"),
      e2eMsg("e1"),
      e2eMsg("e2"),
      e2eMsg("e-chain"),
      e2eMsg("e-skip"),
    ]);
    const handler = vi.fn(async (env: { id: string }) => {
      if (env.id === "e1") return { status: "ok" as const, plain: { kind: "text" as const, text: "已解密" } };
      if (env.id === "e-chain")
        return {
          status: "ok" as const,
          plain: { kind: "chaindist" as const, dist: { kid: "k1", ck: "c-k", n: 0, createdAt: 1 } },
        };
      if (env.id === "e-skip") return { status: "skip" as const };
      return { status: "defer" as const };
    });
    useChatStore.getState().setOpenHandler(handler);

    const list = await useChatStore.getState().loadMessages("c1");
    expect(list.map((m) => m.id)).toEqual(["p1", "e1", "e2"]); // chaindist 与 skip 不进列表
    expect(list[1].payload.text).toBe("已解密");
    expect(list[2].payload.text).toBe(""); // defer 占位
    expect(useChatStore.getState().pendingE2e.c1).toEqual(["e2"]);
    expect(useChatStore.getState().plainById.c1!.e1.kind).toBe("text");
    // 与 store 状态一致（渲染面从 store 读）
    expect(useChatStore.getState().messages.c1!.map((m) => m.id)).toEqual(["p1", "e1", "e2"]);
  });

  it("migrateOwnPlain：本人 plain 消息封信封 PUT reencrypt（20/s 节流），他人/已 e2e 不动", async () => {
    useChatStore.setState({
      messages: {
        c1: [
          msg("mig-a", "旧明文一"), // senderId u1（本人）
          msg("mig-b", "旧明文二"),
          { ...msg("mig-o", "别人的明文"), senderId: "u2" },
          e2eMsg("mig-e"),
        ],
      },
    });
    const deps = {
      fetchPeerKeys: vi.fn(async () => null),
      sendRaw: vi.fn(),
      now: () => Date.now(),
    };
    const attempted = new Set<string>();

    // 节流断言取「相邻 PUT 的真实时间间隔 ≥45ms」：seal 是真 crypto（线程池回调），
    // 假时钟 advanceTimersByTimeAsync 驱不动它——用实测间隔锁 20/s 语义更稳。
    const putAt: number[] = [];
    vi.mocked(reencryptMessage).mockImplementation(async (id, body) => {
      putAt.push(Date.now());
      return { ...e2eMsg(id, { cipher: body.cipher, chainKid: body.chainKid, n: body.n }), payload: { text: "" } };
    });

    await useChatStore.getState().migrateOwnPlain("c1", ["u1", "u2"], deps, attempted, "u1");

    expect(reencryptMessage).toHaveBeenCalledTimes(2);
    expect(putAt.length).toBe(2);
    expect(putAt[1] - putAt[0]).toBeGreaterThanOrEqual(45); // 20/s 节流（50ms 间隔，容 5ms 抖动）

    const calls = vi.mocked(reencryptMessage).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(["mig-a", "mig-b"]); // 他人 plain 与已 e2e 不重封
    const body = calls[0][1];
    expect(body.enc).toBe("e2e");
    expect(typeof body.cipher).toBe("string");
    expect(body.cipher.length).toBeGreaterThan(0); // 真 seal（非桩）产出的密文
    expect(typeof body.chainKid).toBe("string");
    expect(typeof body.n).toBe("number");
    // 成功后本地替换为 e2e 形态（服务端返回值）——明文已知，payload 就地回填不落占位
    const after = useChatStore.getState().messages.c1!.find((m) => m.id === "mig-a");
    expect(after!.enc).toBe("e2e");
    expect(after!.payload.text).toBe("旧明文一");
    expect(useChatStore.getState().plainById.c1!["mig-a"]).toMatchObject({ text: "旧明文一" });
    // attempted 去重：再跑一遍不重复 PUT
    await useChatStore.getState().migrateOwnPlain("c1", ["u1"], deps, attempted, "u1");
    expect(reencryptMessage).toHaveBeenCalledTimes(2);
  });

  it("agent_error 密文（fix I2）：解密得 message；解不开/无 handler 降级通用文案（code 保留）", async () => {
    let mode: "ok" | "fail" = "ok";
    const handler = vi.fn(
      async (_env: { id: string }, _ctx?: { streamId: string; kind?: string; index?: number }) =>
        mode === "ok"
          ? ({ status: "ok" as const, plain: { kind: "error" as const, text: "供应商 401 bad key" } })
          : ({ status: "failed" as const }),
    );
    useChatStore.getState().setOpenHandler(handler);

    useChatStore.getState().onWsEvent({
      type: "agent_error",
      conversationId: "c1",
      agentId: "a1",
      streamId: "sE1",
      code: "provider_error",
      message: "",
      cipher: "Qw==",
      chainKid: "kid-1",
      n: 1,
    });
    await flush();
    expect(useChatStore.getState().streaming["sE1"]).toMatchObject({
      status: "error",
      errorMessage: "供应商 401 bad key", // 密文解开的错误正文
    });
    expect(handler.mock.calls[0][1]).toEqual({ kind: "error", streamId: "sE1" }); // AAD 上下文

    // 解不开 → 通用降级文案（不显示密文乱码、不崩），code 语义保留
    mode = "fail";
    useChatStore.getState().onWsEvent({
      type: "agent_error",
      conversationId: "c1",
      agentId: "a1",
      streamId: "sE2",
      code: "provider_error",
      message: "",
      cipher: "Qw==2",
      chainKid: "kid-1",
      n: 2,
    });
    await flush();
    expect(useChatStore.getState().streaming["sE2"]).toMatchObject({
      status: "error",
      errorMessage: "生成出错（内容无法解密）",
    });

    // 无 handler → 同样降级（绝不把密文当正文显示）
    useChatStore.getState().setOpenHandler(null);
    useChatStore.getState().onWsEvent({
      type: "agent_error",
      conversationId: "c1",
      agentId: "a1",
      streamId: "sE3",
      code: "aborted",
      message: "",
      cipher: "Qw==3",
      chainKid: "kid-1",
      n: 3,
    });
    await flush();
    expect(useChatStore.getState().streaming["sE3"]).toMatchObject({
      status: "error",
      errorMessage: "生成出错（内容无法解密）",
    });

    // 明文 legacy 路径不变（服务端自产 forbidden / 旧端）
    useChatStore.getState().onWsEvent({
      type: "agent_error",
      conversationId: "c1",
      agentId: "a1",
      streamId: "sE4",
      code: "forbidden",
      message: "not a member",
    });
    await flush();
    expect(useChatStore.getState().streaming["sE4"]?.errorMessage).toBe("not a member");
  });
});
