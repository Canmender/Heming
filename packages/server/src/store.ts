import { randomUUID } from "node:crypto";
import type { User, Message, Conversation, Member, ReadState, Agent } from "@heming/shared";

export interface FriendshipRequest {
  id: string;
  fromId: string;
  toId: string;
  status: "pending" | "accepted";
}

/**
 * 系统预设 agent 元数据单一真源：内存注册表与 sqlite agents 表 upsert 共用，
 * seedPreset 侧的 SYSTEM_AGENT_NAME 亦由此派生，避免三处字面量漂移。
 */
export const SYSTEM_AGENTS: Record<
  string,
  { name: string; avatar: string | null; description: string; systemPrompt: string }
> = {
  "system-assistant": { name: "和小鸣", avatar: null, description: "和鸣官方预设智能体", systemPrompt: "" },
};

export interface Store {
  createUser(username: string, passwordHash: string, displayName: string): User;
  findUserByUsername(username: string): { user: User; passwordHash: string } | null;
  findUserById(id: string): User | null;
  /** avatar 省略时保留原值。返回新 User 对象（见 createMemoryStore 内注释）。 */
  updateProfile(userId: string, patch: { displayName: string; avatar?: string }): User;
  createFriendRequest(fromId: string, toUsername: string): { id: string; from: User; to: User; status: "pending" };
  acceptFriendRequest(requestId: string, userId: string): { id: string; user: User };
  listFriends(userId: string): { id: string; user: User }[];
  listIncomingRequests(userId: string): { id: string; from: User }[];
  createDirectConversation(aId: string, bId: string): { id: string; type: "direct"; peer: User };
  listConversations(userId: string): Conversation[];
  isMember(conversationId: string, userId: string): boolean;
  addMessage(
    conversationId: string,
    senderType: "user" | "agent",
    senderId: string,
    payload: { text: string },
    replyTo: string | null,
  ): Message;
  listMessages(conversationId: string, limit?: number): Message[];
  /**
   * 建群（用户自建）：creator 自动入群；除 creator 外的每个 memberIds 必须与 creator
   * 是**已接受好友**关系，否则抛 "not friends"（对齐 createDirectConversation 口径）。
   */
  createGroup(creatorId: string, name: string, memberIds: string[]): { id: string; type: "group"; name: string };
  listMembers(conversationId: string): Member[];
  markRead(conversationId: string, userId: string): void;
  listReads(conversationId: string): ReadState[];
  /** 全部已存在用户 id（预设群播种取成员用）。 */
  listUserIds(): string[];
  /**
   * 幂等建预设群（B 语义）：同名**预设**群（非用户自建）已存在 → 把 userIds 中尚不在
   * 成员表的用户补入（幂等，不重复插入）并返回其 id；否则建群（成员 = userIds 去重，
   * 仅用户）、upsert agentId 元数据并挂 conversation_agents。agentId 必须在 SYSTEM_AGENTS
   * 中，否则抛错（双实现同语义）。用户自建同名群不遮蔽预设群（created_by 非 NULL 不参与匹配）。
   */
  ensurePresetGroup(name: string, userIds: string[], agentId: string): string;
  /** 会话挂载的 agent id 列表（conversation_agents / 内存 agentIds），无则空数组。 */
  listAgentIds(conversationId: string): string[];
  /**
   * 智能体名册：用户自建 + 已播种的系统 agent（未播种时仅用户自建）。
   * 返回结构不含 system_prompt（部署边界：系统提示词永不进 API）。
   */
  listAgents(): Agent[];
  createAgent(ownerId: string, body: { name: string; avatar?: string | null; description: string }): Agent;
  /** owner_id IS NULL（系统）或非 ownerId → 抛 "forbidden"；不存在 → "agent not found"。 */
  updateAgent(id: string, ownerId: string, patch: { name?: string; avatar?: string | null; description?: string }): Agent;
  /** 权限同 updateAgent；删除同时清理 conversation_agents 关联。 */
  deleteAgent(id: string, ownerId: string): void;
}

export function createMemoryStore(): Store {
  const users = new Map<string, { user: User; passwordHash: string }>();
  const usersByName = new Map<string, string>();
  const requests: FriendshipRequest[] = [];
  const conversations = new Map<
    string,
    {
      members: string[];
      kind: "direct" | "group";
      name?: string;
      agentIds?: string[];
      /** 仅用户自建群写入（createGroup）；预设群与 direct 会话不写 → undefined。 */
      createdBy?: string;
    }
  >();
  const messages = new Map<string, Message[]>();
  const reads = new Map<string, Map<string, string>>();
  const pairToConv = new Map<string, string>();
  // 智能体名册（closure 级，随 store 实例隔离——与 users/conversations 同层）。
  // 系统 agent 不在此预置：由 ensurePresetGroup 从 SYSTEM_AGENTS 登记（对齐 sqlite 的
  // INSERT ... ON CONFLICT DO UPDATE），未播种时两实现 listAgents 均不含系统 agent。
  const agents = new Map<string, Agent>();

  const mustUser = (id: string): User => {
    const row = users.get(id);
    if (!row) throw new Error("user not found");
    return row.user;
  };
  const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

  return {
    createUser(username, passwordHash, displayName) {
      if (usersByName.has(username)) throw new Error("username taken");
      const user: User = { id: randomUUID(), username, displayName };
      users.set(user.id, { user, passwordHash });
      usersByName.set(username, user.id);
      return user;
    },
    findUserByUsername(username) {
      const id = usersByName.get(username);
      return id ? users.get(id)! : null;
    },
    findUserById(id) {
      return users.get(id)?.user ?? null;
    },
    updateProfile(userId, patch) {
      const row = users.get(userId);
      if (!row) throw new Error("user not found");
      // 新对象替换而非原地改：findUser* 返回内部引用，原地修改会让持有旧引用的
      // 调用方（含测试）观察到非预期副作用；好友申请的 status 原地改是既有的
      // 小对象模式，用户对象更大且会被多处持有，故取替换语义。
      const user: User = {
        ...row.user,
        displayName: patch.displayName,
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
      };
      users.set(userId, { user, passwordHash: row.passwordHash });
      return user;
    },
    createFriendRequest(fromId, toUsername) {
      mustUser(fromId);
      const toId = usersByName.get(toUsername);
      if (!toId) throw new Error("peer not found");
      if (toId === fromId) throw new Error("cannot friend self");
      const existing = requests.find(
        (r) =>
          r.status === "pending" &&
          ((r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId)),
      );
      if (existing) throw new Error("request already exists");
      const req: FriendshipRequest = { id: randomUUID(), fromId, toId, status: "pending" };
      requests.push(req);
      return { id: req.id, from: mustUser(fromId), to: mustUser(toId), status: "pending" };
    },
    acceptFriendRequest(requestId, userId) {
      const req = requests.find((r) => r.id === requestId);
      if (!req) throw new Error("request not found");
      if (req.toId !== userId) throw new Error("not request recipient");
      req.status = "accepted";
      return { id: req.id, user: mustUser(req.fromId) };
    },
    listFriends(userId) {
      return requests
        .filter((r) => r.status === "accepted" && (r.fromId === userId || r.toId === userId))
        .map((r) => ({ id: r.id, user: mustUser(r.fromId === userId ? r.toId : r.fromId) }));
    },
    listIncomingRequests(userId) {
      return requests
        .filter((r) => r.status === "pending" && r.toId === userId)
        .map((r) => ({ id: r.id, from: mustUser(r.fromId) }));
    },
    createDirectConversation(aId, bId) {
      mustUser(aId);
      mustUser(bId);
      const friends = requests.some(
        (r) => r.status === "accepted" && pairKey(r.fromId, r.toId) === pairKey(aId, bId),
      );
      if (!friends) throw new Error("not friends");
      const key = pairKey(aId, bId);
      const existingId = pairToConv.get(key);
      if (existingId) {
        return { id: existingId, type: "direct", peer: mustUser(bId) };
      }
      const id = randomUUID();
      conversations.set(id, { members: [aId, bId], kind: "direct" });
      messages.set(id, []);
      reads.set(id, new Map());
      pairToConv.set(key, id);
      return { id, type: "direct", peer: mustUser(bId) };
    },
    listConversations(userId) {
      const unread = (convId: string): number => {
        const readAt = reads.get(convId)?.get(userId);
        return (messages.get(convId) ?? []).filter(
          (m) => m.senderId !== userId && (!readAt || m.createdAt > readAt),
        ).length;
      };
      const out: Conversation[] = [];
      for (const [id, conv] of conversations) {
        if (!conv.members.includes(userId)) continue;
        if (conv.kind === "group") {
          out.push({
            id,
            type: "group",
            name: conv.name!,
            memberCount: conv.members.length,
            unreadCount: unread(id),
          });
        } else {
          const peerId = conv.members.find((m) => m !== userId);
          if (peerId) out.push({ id, type: "direct", peer: mustUser(peerId), unreadCount: unread(id) });
        }
      }
      return out;
    },
    isMember(conversationId, userId) {
      return conversations.get(conversationId)?.members.includes(userId) ?? false;
    },
    addMessage(conversationId, senderType, senderId, payload, replyTo) {
      if (!conversations.has(conversationId)) throw new Error("conversation not found");
      const msg: Message = {
        id: randomUUID(),
        conversationId,
        senderType,
        senderId,
        payload,
        replyTo,
        createdAt: new Date().toISOString(),
      };
      messages.get(conversationId)!.push(msg);
      return msg;
    },
    listMessages(conversationId, limit) {
      const all = messages.get(conversationId);
      if (!all) throw new Error("conversation not found");
      return limit ? all.slice(-limit) : [...all];
    },
    createGroup(creatorId, name, memberIds) {
      mustUser(creatorId);
      const ids = [...new Set([creatorId, ...memberIds])];
      for (const id of ids) mustUser(id);
      // 口径同 createDirectConversation：除 creator 自身外，入群者须与 creator 已接受好友
      for (const id of ids) {
        if (id === creatorId) continue;
        const friends = requests.some(
          (r) => r.status === "accepted" && pairKey(r.fromId, r.toId) === pairKey(creatorId, id),
        );
        if (!friends) throw new Error("not friends");
      }
      const id = randomUUID();
      conversations.set(id, { members: ids, kind: "group", name, createdBy: creatorId });
      messages.set(id, []);
      reads.set(id, new Map());
      return { id, type: "group", name };
    },
    listMembers(conversationId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const out: Member[] = conv.members.map((id) => {
        const u = mustUser(id);
        return { kind: "user" as const, id, name: u.displayName, avatar: u.avatar ?? null, user: u };
      });
      // agent 行尾部追加；元数据取自 SYSTEM_AGENTS（sqlite 侧取自 agents 表，播种时同一来源 upsert）。
      // 未知 agentId 跳过，与 sqlite INNER JOIN agents 的丢行语义一致。
      for (const agentId of conv.agentIds ?? []) {
        const meta = SYSTEM_AGENTS[agentId];
        if (!meta) continue;
        out.push({ kind: "agent", id: agentId, name: meta.name, avatar: meta.avatar, user: null });
      }
      return out;
    },
    markRead(conversationId, userId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      if (!conv.members.includes(userId)) throw new Error("not a member");
      let m = reads.get(conversationId);
      if (!m) {
        m = new Map();
        reads.set(conversationId, m);
      }
      m.set(userId, new Date().toISOString());
    },
    listReads(conversationId) {
      const m = reads.get(conversationId);
      if (!m) return [];
      return [...m.entries()].map(([userId, at]) => ({ userId, at }));
    },
    listUserIds() {
      return [...users.keys()];
    },
    ensurePresetGroup(name, userIds, agentId) {
      // B 语义（防劫持 + 启动补成员）：只匹配**预设**群（createdBy 为 undefined——
      // 用户自建同名群由 createGroup 写 createdBy，不参与匹配）；命中则把 userIds 中
      // 尚未入群的用户补入（幂等，不去改动已入群成员）并返回同一 id。
      for (const [id, conv] of conversations) {
        if (conv.kind === "group" && conv.name === name && conv.createdBy === undefined) {
          const missing = [...new Set(userIds)].filter((u) => !conv.members.includes(u));
          for (const u of missing) mustUser(u);
          conv.members.push(...missing);
          return id;
        }
      }
      const meta = SYSTEM_AGENTS[agentId];
      if (!meta) throw new Error(`unknown system agent: ${agentId}`);
      if (userIds.length === 0) throw new Error("preset group requires at least one user");
      const ids = [...new Set(userIds)];
      for (const id of ids) mustUser(id);
      const id = randomUUID();
      conversations.set(id, { members: ids, kind: "group", name, agentIds: [agentId] });
      messages.set(id, []);
      reads.set(id, new Map());
      // 系统 agent 登记进名册（元数据单一真源 SYSTEM_AGENTS；与 sqlite 侧同路径 upsert 对齐）
      agents.set(agentId, {
        id: agentId,
        owner_id: null,
        name: meta.name,
        avatar: meta.avatar,
        description: meta.description,
      });
      return id;
    },
    listAgentIds(conversationId) {
      return [...(conversations.get(conversationId)?.agentIds ?? [])];
    },
    listAgents() {
      return [...agents.values()];
    },
    createAgent(ownerId, body) {
      mustUser(ownerId);
      const agent: Agent = {
        id: randomUUID(),
        owner_id: ownerId,
        name: body.name,
        avatar: body.avatar ?? null,
        description: body.description,
      };
      agents.set(agent.id, agent);
      return agent;
    },
    updateAgent(id, ownerId, patch) {
      const cur = agents.get(id);
      if (!cur) throw new Error("agent not found");
      if (cur.owner_id === null || cur.owner_id !== ownerId) throw new Error("forbidden");
      const next: Agent = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      };
      agents.set(id, next);
      return next;
    },
    deleteAgent(id, ownerId) {
      const cur = agents.get(id);
      if (!cur) throw new Error("agent not found");
      if (cur.owner_id === null || cur.owner_id !== ownerId) throw new Error("forbidden");
      agents.delete(id);
      // 同步清会话关联（内存 agentIds；sqlite 侧对应 DELETE conversation_agents）
      for (const conv of conversations.values()) {
        if (conv.agentIds) conv.agentIds = conv.agentIds.filter((x) => x !== id);
      }
    },
  };
}
