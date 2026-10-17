import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Agent, Member, Message, User, WsServerEvent } from "@heming/shared";
import { useChatStore } from "./chat.js";
import { api, fetchMembers } from "../lib/api.js";
import { listAgents } from "../lib/agentsApi.js";

// createGroup 走 api()、loadAgents 走 fetchMembers：模块级 mock（其余导出保持真实）
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: vi.fn(), fetchMembers: vi.fn() };
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
});
