import { randomUUID } from "node:crypto";
import type { User, Message, Conversation, Member, ReadState, Agent, SharedFileMeta, MessageEnvelope, E2eDeviceKeys } from "@heming/shared";

export interface FriendshipRequest {
  id: string;
  fromId: string;
  toId: string;
  status: "pending" | "accepted";
}

/** reencryptMessage 结果：ok 携更新后消息；否则三态 reason（app 层映射 404/403/409）。 */
export type ReencryptResult =
  | { ok: true; message: Message }
  | { ok: false; reason: "not_found" | "forbidden" | "conflict" };

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
  /**
   * 建智能体一对一会话（幂等，已存在则返回原会话 id）。
   * agent 必须存在于名册；自建 agent 仅属主可开，系统预设 agent 谁都能开。
   */
  createAgentConversation(
    userId: string,
    agentId: string,
  ): { id: string; type: "agent"; agent: Agent };
  listConversations(userId: string): Conversation[];
  /**
   * 归档 / 取消归档一条会话（**按成员独立**）。
   *
   * 群聊里 A 归档不该影响 B——归档是「我不想在列表里看到它」，属于个人视图偏好。
   * 存成会话级字段会让全群跟着被归档，那是错的。
   *
   * 非成员调用抛错（调用方转 403），与其它成员校验一致。
   */
  setConversationArchived(conversationId: string, userId: string, archived: boolean): void;
  isMember(conversationId: string, userId: string): boolean;
  addMessage(
    conversationId: string,
    senderType: "user" | "agent",
    senderId: string,
    payload: { text: string },
    replyTo: string | null,
    envelope?: MessageEnvelope,
  ): Message;
  listMessages(conversationId: string, limit?: number): Message[];
  /**
   * 撤回消息（仅发送者本人）：非本人发送 / 非成员 / 消息不存在 → null；
   * 成功置 recalledAt（ISO）并持久化，返回更新后消息（内容不删，仅标记）。
   */
  recallMessage(conversationId: string, messageId: string, userId: string): Message | null;
  /**
   * 明文重加密（E2E Task 2，设计 §7）：按 messageId 定位，仅当 sender=userId 且当前
   * enc="plain" 时**原子**替换信封（enc/cipher/chain_kid/n），并在**同一更新内**清掉明文：
   * payload 置 {"text":""} 占位、replyTo 置 null（设计 §1/§7：e2e 消息服务端不留内容/
   * 回复指向，出站 listMessages 对 e2e 不得再含原文）。三态：
   *   消息不存在 → not_found；senderId≠userId → forbidden（只看本人，不看成员身份）；
   *   enc≠"plain"（已 e2e）→ conflict；成功 → ok + 更新后消息。
   */
  reencryptMessage(
    messageId: string,
    userId: string,
    envelope: { cipher: string; chainKid?: string; n?: number },
  ): ReencryptResult;
  /**
   * 登记本人设备公钥（E2E Task 2）：按 (userId, ikEcdh) upsert——同设备再登记覆盖
   * （SPK 轮换），新 ikEcdh 追加设备。userId 恒来自登录态，不做用户存在性校验。
   */
  upsertE2eDevice(userId: string, device: E2eDeviceKeys): void;
  /** 全部已登记设备公钥 { [userId]: devices[] }（GET /api/e2e/keys，登录可读）。 */
  listE2eKeys(): Record<string, E2eDeviceKeys[]>;
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
   * 会话挂载 agent（幂等，重复挂载为 no-op）。**不做**成员/存在性校验——权限与
   * 403/404 口径在路由层（app.ts）做；会话不存在抛 "conversation not found"（双实现同语义）。
   */
  attachAgentToGroup(conversationId: string, agentId: string): void;
  /** 会话卸载 agent（幂等，未挂载也为 no-op → 204）；会话不存在同 attach 抛错。 */
  detachAgentFromGroup(conversationId: string, agentId: string): void;
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
  // —— M4 共享文件（app.ts 内存 Map 迁入 Store 的持久化契约，双实现同语义）——
  /** 落库一个共享文件（元数据 + base64 内容），返回入参 meta。 */
  addFile(meta: SharedFileMeta, contentBase64: string): SharedFileMeta;
  /** 取文件（元数据 + base64 内容）；不存在返回 null。 */
  getFile(id: string): { meta: SharedFileMeta; contentBase64: string } | null;
  /** 全部共享文件元数据，按 updatedAt 降序。 */
  listFiles(): SharedFileMeta[];
  /** 删除文件；存在并删除成功 true，不存在 false。 */
  deleteFile(id: string): boolean;
  /** 某用户全部共享文件字节数（size 求和，配额用）。 */
  userFileBytes(ownerUsername: string): number;
}

export function createMemoryStore(): Store {
  const users = new Map<string, { user: User; passwordHash: string }>();
  const usersByName = new Map<string, string>();
  const requests: FriendshipRequest[] = [];
  const conversations = new Map<
    string,
    {
      members: string[];
      /** agent = 智能体一对一（用户与某个名册 agent 的私聊，members 只含本人）。 */
      kind: "direct" | "group" | "agent";
      name?: string;
      /** 仅 kind="agent"：对方 agent id（sqlite 侧对应 conversation_agents 关联）。 */
      agentPeerId?: string;
      agentIds?: string[];
      /** 仅用户自建群写入（createGroup）；预设群与 direct 会话不写 → undefined。 */
      createdBy?: string;
      /**
       * 成员 → 归档时间。没这个 key 就是未归档。
       * 按成员存（而不是会话级）：群聊里各自归档互不影响。
       */
      archivedAt?: Map<string, string>;
    }
  >();
  const messages = new Map<string, Message[]>();
  const reads = new Map<string, Map<string, string>>();
  const pairToConv = new Map<string, string>();
  // 智能体名册（closure 级，随 store 实例隔离——与 users/conversations 同层）。
  // 系统 agent 不在此预置：由 ensurePresetGroup 从 SYSTEM_AGENTS 登记（对齐 sqlite 的
  // INSERT ... ON CONFLICT DO UPDATE），未播种时两实现 listAgents 均不含系统 agent。
  const agents = new Map<string, Agent>();
  // 共享文件（M4：app.ts 闭包 Map 迁入 Store——与 users/messages 同层的 store 实例级资源）
  const files = new Map<string, { meta: SharedFileMeta; contentBase64: string }>();
  // E2E 设备公钥（Task 2）：userId →（ikEcdh → 设备公钥包）；Map 插入序即登记序
  const e2eKeys = new Map<string, Map<string, E2eDeviceKeys>>();

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
    createAgentConversation(userId, agentId) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error("agent not found");
      // 只能和自己名下的智能体私聊：系统预设 agent（owner_id 为 null）属于公共资源，
      // 允许任何人私聊；自建 agent 仅属主可开，避免拿别人的 agent 当自己的聊天对象。
      if (agent.owner_id !== null && agent.owner_id !== userId) {
        throw new Error("not your agent");
      }
      // 幂等：同一用户与同一 agent 只保留一个会话（复用 lookup，不另建 pairToConv——
      // 那张表是 user↔user 好友对的键，agent 对混进去会污染 direct 的复用逻辑）
      const found = [...conversations].find(
        ([, c]) => c.kind === "agent" && c.agentPeerId === agentId && c.members.includes(userId),
      );
      if (found) return { id: found[0], type: "agent", agent };
      const id = randomUUID();
      conversations.set(id, { members: [userId], kind: "agent", agentPeerId: agentId });
      messages.set(id, []);
      reads.set(id, new Map());
      return { id, type: "agent", agent };
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
        const lastMessageAt = messages.get(id)?.at(-1)?.createdAt ?? null;
        const lastReadAt = reads.get(id)?.get(userId) ?? null;
        if (conv.kind === "group") {
          out.push({
            id,
            type: "group",
            name: conv.name!,
            memberCount: conv.members.length,
            unreadCount: unread(id),
            lastMessageAt,
            lastReadAt,
            archivedAt: conv.archivedAt?.get(userId) ?? null,
          });
        } else if (conv.kind === "agent") {
          // 智能体一对一：对方是名册项而非 users 行，取不到（agent 被删）就不出这条会话——
          // 宁可不显示，也不给前端一个没有 agent 字段的半截对象。
          const agent = conv.agentPeerId ? agents.get(conv.agentPeerId) : undefined;
          if (agent)
            out.push({ id, type: "agent", agent, unreadCount: unread(id), lastMessageAt, lastReadAt, archivedAt: conv.archivedAt?.get(userId) ?? null });
        } else {
          const peerId = conv.members.find((m) => m !== userId);
          if (peerId)
            out.push({
              id,
              type: "direct",
              peer: mustUser(peerId),
              unreadCount: unread(id),
              lastMessageAt,
              lastReadAt,
              archivedAt: conv.archivedAt?.get(userId) ?? null,
            });
        }
      }
      return out;
    },
    setConversationArchived(conversationId, userId, archived) {
      const conv = conversations.get(conversationId);
      // 非成员一律拒绝：与其它接口的成员校验同语义，不能让外人改别人的视图
      if (!conv || !conv.members.includes(userId)) {
        throw new Error("conversation not found or not a member");
      }
      if (archived) {
        // **保留首次归档时间**：重复点归档不该把时间刷新成现在。
        // 归档页按归档时间倒序，刷新会让「刚收起来的会话」在列表里跳位——
        // 用户点了两次归档，条目就换了位置，看起来像坏了。
        conv.archivedAt = conv.archivedAt ?? new Map();
        if (!conv.archivedAt.has(userId)) {
          conv.archivedAt.set(userId, new Date().toISOString());
        }
      } else {
        conv.archivedAt?.delete(userId);
      }
    },
    isMember(conversationId, userId) {
      return conversations.get(conversationId)?.members.includes(userId) ?? false;
    },    addMessage(conversationId, senderType, senderId, payload, replyTo, envelope) {
      if (!conversations.has(conversationId)) throw new Error("conversation not found");
      const msg: Message = {
        id: randomUUID(),
        conversationId,
        senderType,
        senderId,
        payload,
        replyTo,
        createdAt: new Date().toISOString(),
        recalledAt: null,
        // 信封（E2E Task 2）：省略 envelope → plain；e2e 才带 cipher/chainKid/n
        enc: envelope?.enc ?? "plain",
        ...(envelope?.cipher !== undefined ? { cipher: envelope.cipher } : {}),
        ...(envelope?.chainKid !== undefined ? { chainKid: envelope.chainKid } : {}),
        ...(envelope?.n !== undefined ? { n: envelope.n } : {}),
      };
      messages.get(conversationId)!.push(msg);
      return msg;
    },
    listMessages(conversationId, limit) {
      const all = messages.get(conversationId);
      if (!all) throw new Error("conversation not found");
      return limit ? all.slice(-limit) : [...all];
    },
    recallMessage(conversationId, messageId, userId) {
      // 缺失会话 → messages.get 为 undefined → 按「消息不存在」返回 null（与 sqlite 的
      // UPDATE 0 changes 同语义）；非成员/非发送者同为 null。
      const list = messages.get(conversationId);
      const m = list?.find((x) => x.id === messageId);
      if (!m || m.senderId !== userId) return null;
      if (!conversations.get(conversationId)?.members.includes(userId)) return null;
      // 原地置位 + 浅拷贝返回：listMessages 持有内部引用（既有口径），改字段即持久；
      // 返回拷贝避免调用方持有可变内部对象（对齐 updateProfile 的替换语义精神）。
      m.recalledAt = new Date().toISOString();
      return { ...m };
    },
    reencryptMessage(messageId, userId, envelope) {
      // 单线程同步段内「检查 + 替换」即原子（sqlite 侧用条件 UPDATE 同语义）
      for (const list of messages.values()) {
        const m = list.find((x) => x.id === messageId);
        if (!m) continue;
        if (m.senderId !== userId) return { ok: false, reason: "forbidden" };
        if (m.enc !== "plain") return { ok: false, reason: "conflict" };
        // 信封四字段（enc/cipher/chain_kid/n）+ **同一同步段内**清明文：
        // payload 空占位、replyTo 置 null——出站 listMessages 对 e2e 不带任何明文
        m.enc = "e2e";
        m.cipher = envelope.cipher;
        if (envelope.chainKid !== undefined) m.chainKid = envelope.chainKid;
        if (envelope.n !== undefined) m.n = envelope.n;
        m.payload = { text: "" };
        m.replyTo = null;
        return { ok: true, message: { ...m } };
      }
      return { ok: false, reason: "not_found" };
    },
    upsertE2eDevice(userId, device) {
      let devices = e2eKeys.get(userId);
      if (!devices) {
        devices = new Map();
        e2eKeys.set(userId, devices);
      }
      // 同 ikEcdh 覆盖（Map.set 对已存在键保持原插入位置）→ SPK 轮换不增行
      devices.set(device.ikEcdh, device);
    },
    listE2eKeys() {
      const out: Record<string, E2eDeviceKeys[]> = {};
      for (const [userId, devices] of e2eKeys) out[userId] = [...devices.values()];
      return out;
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
      // agent 行尾部追加；元数据取自名册 agents（系统 agent 由 ensurePresetGroup 登记、
      // 用户自建由 createAgent 落行）——sqlite 侧为 conversation_agents JOIN agents 同语义。
      // 名册缺行的 agentId 跳过（与 sqlite INNER JOIN 的丢行一致）。
      for (const agentId of conv.agentIds ?? []) {
        const meta = agents.get(agentId);
        if (!meta) continue;
        out.push({ kind: "agent", id: meta.id, name: meta.name, avatar: meta.avatar, user: null });
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
    attachAgentToGroup(conversationId, agentId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const ids = (conv.agentIds ??= []);
      if (!ids.includes(agentId)) ids.push(agentId);
    },
    detachAgentFromGroup(conversationId, agentId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      if (conv.agentIds) conv.agentIds = conv.agentIds.filter((x) => x !== agentId);
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
    addFile(meta, contentBase64) {
      files.set(meta.id, { meta, contentBase64 });
      return meta;
    },
    getFile(id) {
      return files.get(id) ?? null;
    },
    listFiles() {
      return [...files.values()].map((f) => f.meta).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    deleteFile(id) {
      return files.delete(id);
    },
    userFileBytes(ownerUsername) {
      let sum = 0;
      for (const f of files.values()) if (f.meta.owner === ownerUsername) sum += f.meta.size;
      return sum;
    },
  };
}
