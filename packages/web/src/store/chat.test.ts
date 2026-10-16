import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Agent, Member, Message, User } from "@heming/shared";
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
    });
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
});
