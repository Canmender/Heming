import { randomUUID } from "node:crypto";
import type {
  User,
  Message,
  Conversation,
  Agent,
  SharedFileMeta,
  MessageEnvelope,
  E2eDeviceKeys,
  TeamActivity,
  TeamActivityInput,
  TeamUsageInput,
} from "@heming/shared";

/** 服务端存的一行团队用量（聚合前）：只有白名单维度与数字。 */
export interface TeamUsageRow {
  actorId: string;
  /** 自然日 YYYY-MM-DD（客户端本地日）。 */
  date: string;
  model: string;
  /** 已上报 token 合计；null = 未上报（不是 0）。 */
  tokens: number | null;
  unreported: number;
  /** 连接名快照（用户自命名，白名单字段）。 */
  connections: string[];
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
  /**
   * 登录会话：只存 token 的 SHA-256 摘要（原文不落库）。
   * 会话与用户数据同库持久化，服务重启后已登录设备无需重新登录。
   */
  addSession(tokenDigest: string, userId: string): void;
  /** 按 token 摘要取 userId；不存在返回 null。 */
  sessionUserId(tokenDigest: string): string | null;
  /** avatar 省略时保留原值。返回新 User 对象（见 createMemoryStore 内注释）。 */
  updateProfile(userId: string, patch: { displayName: string; avatar?: string }): User;
  /**
   * 建智能体一对一会话（幂等，已存在则返回原会话 id）。
   * agent 必须存在于名册；自建 agent 仅属主可开，系统预设 agent 谁都能开。
   */
  createAgentConversation(
    userId: string,
    agentId: string,
  ): { id: string; type: "agent"; agent: Agent };
  listConversations(userId: string): Conversation[];
  isMember(conversationId: string, userId: string): boolean;
  /** 智能体会话对应的 agent id（非 agent 会话 / 不存在返回 null）。 */
  conversationAgentId(conversationId: string): string | null;
  addMessage(
    conversationId: string,
    senderType: "user" | "agent",
    senderId: string,
    payload: { text: string },
    envelope?: MessageEnvelope,
  ): Message;
  listMessages(conversationId: string, limit?: number): Message[];
  /**
   * 明文重加密（E2E Task 2，设计 §7）：按 messageId 定位，仅当 sender=userId 且当前
   * enc="plain" 时**原子**替换信封（enc/cipher/chain_kid/n），并在**同一更新内**清掉明文：
   * payload 置 {"text":""} 占位（设计 §1/§7：e2e 消息服务端不留内容，
   * 出站 listMessages 对 e2e 不得再含原文）。三态：
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
  // —— d.54 团队系统：在线活跃与动向（单团队，全站用户即成员）——
  /** 刷新用户最近活跃时间；用户不存在时静默忽略（登录态已保证存在）。 */
  touchUser(userId: string): void;
  /** 全站名册（用户 + 最近活跃）；在线态由调用方叠加，不落库。 */
  listTeamMembers(): { user: User; lastSeenAt: string | null }[];
  /**
   * 写入一条动向摘要。按 (actorId, sourceId) 幂等：
   * 已存在返回 false（skipped），新写入返回 true（inserted）。
   */
  addTeamActivity(actorId: string, input: TeamActivityInput): boolean;
  /** 动向流：按 occurredAt 倒序；before 为严格小于的游标，actorId 可过滤。 */
  listTeamActivities(opts?: { limit?: number; before?: string; actorId?: string }): TeamActivity[];
  /** 清空某位成员已上传的动向，返回删除条数。 */
  clearTeamActivities(actorId: string): number;
  // —— ②-3 团队用量：白名单摘要的服务端聚合 ——
  /**
   * 幂等写入一天的聚合用量：同一 `(actorId, date, model)` **覆盖更新**。
   *
   * 客户端上报的是「该日该模型的累计值」，不是增量——所以重复上报同一份数据不会翻倍，
   * 补报/修正也只覆盖那一格。用户不存在时抛 "user not found"（与动向同口径）。
   */
  upsertTeamUsage(actorId: string, input: TeamUsageInput): void;
  /** 区间（自然日闭区间）内全部成员的用量行；排行/本人明细由调用方聚合。 */
  listTeamUsage(opts: { from: string; to: string }): TeamUsageRow[];
  /**
   * 删除某位成员已上传的全部用量行，返回删除条数。
   *
   * 关闭共享只停「未来上传」，旧行还留在服务端、人仍出现在排行里——那不是隐私口径。
   * 所以清除必须是一个显式动作（对称团队动向的 `clearTeamActivities`）。
   */
  clearTeamUsage(actorId: string): number;
  /** 幂等登记系统预设 agent（新库没有预设群后仍要能开「和小鸣」对话）。 */
  ensureSystemAgents(): void;
}

export function createMemoryStore(): Store {
  const users = new Map<string, { user: User; passwordHash: string }>();
  const usersByName = new Map<string, string>();
  /** 登录会话（token 摘要 → userId）；进程内实现，sqlite 侧对应 sessions 表。 */
  const sessions = new Map<string, string>();
  const conversations = new Map<
    string,
    {
      /** 只有本人（智能体一对一的参与者）。 */
      members: string[];
      kind: "agent";
      /** 对方 agent id（sqlite 侧对应 conversation_agents 关联）。 */
      agentPeerId?: string;
    }
  >();
  const messages = new Map<string, Message[]>();
  // 智能体名册（closure 级，随 store 实例隔离——与 users/conversations 同层）。
  // 系统 agent 不在此预置：由 ensurePresetGroup 从 SYSTEM_AGENTS 登记（对齐 sqlite 的
  // INSERT ... ON CONFLICT DO UPDATE），未播种时两实现 listAgents 均不含系统 agent。
  const agents = new Map<string, Agent>();
  // 共享文件（M4：app.ts 闭包 Map 迁入 Store——与 users/messages 同层的 store 实例级资源）
  const files = new Map<string, { meta: SharedFileMeta; contentBase64: string }>();
  // E2E 设备公钥（Task 2）：userId →（ikEcdh → 设备公钥包）；Map 插入序即登记序
  const e2eKeys = new Map<string, Map<string, E2eDeviceKeys>>();
  // d.54 团队：最近活跃与动向摘要（单团队；动向键 = actorId\0sourceId 保幂等）
  const lastSeen = new Map<string, string>();
  const teamActivities: TeamActivity[] = [];
  const teamActivityKeys = new Set<string>();
  /** 团队用量：键 = `actorId\0date\0model`（与 sqlite 主键同口径），值只有白名单维度。 */
  const teamUsage = new Map<string, TeamUsageRow>();

  const mustUser = (id: string): User => {
    const row = users.get(id);
    if (!row) throw new Error("user not found");
    return row.user;
  };
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
    addSession(tokenDigest, userId) {
      sessions.set(tokenDigest, userId);
    },
    sessionUserId(tokenDigest) {
      return sessions.get(tokenDigest) ?? null;
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
      return { id, type: "agent", agent };
    },
    listConversations(userId) {
      const out: Conversation[] = [];
      for (const [id, conv] of conversations) {
        if (!conv.members.includes(userId)) continue;
        // 智能体一对一：对方是名册项而非 users 行，取不到（agent 被删）就不出这条会话——
        // 宁可不显示，也不给前端一个没有 agent 字段的半截对象。
        const agent = conv.agentPeerId ? agents.get(conv.agentPeerId) : undefined;
        if (agent)
          out.push({
            id,
            type: "agent",
            agent,
            // 智能体会话没有「别人发来」的概念，未读恒为 0（读状态随人类 IM 一起删除）。
            unreadCount: 0,
            lastMessageAt: messages.get(id)?.at(-1)?.createdAt ?? null,
          });
      }
      return out;
    },
    isMember(conversationId, userId) {
      return conversations.get(conversationId)?.members.includes(userId) ?? false;
    },
    conversationAgentId(conversationId) {
      return conversations.get(conversationId)?.agentPeerId ?? null;
    },
    addMessage(conversationId, senderType, senderId, payload, envelope) {
      if (!conversations.has(conversationId)) throw new Error("conversation not found");
      const msg: Message = {
        id: randomUUID(),
        conversationId,
        senderType,
        senderId,
        payload,
        createdAt: new Date().toISOString(),
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
      // 同步清理指向该 agent 的一对一会话（sqlite 侧对应 DELETE conversation_agents；
      // 会话行本身靠 INNER JOIN 自然消失，这里需要显式删，避免留下无法展示的孤儿）。
      for (const [convId, conv] of conversations) {
        if (conv.agentPeerId === id) {
          conversations.delete(convId);
          messages.delete(convId);
        }
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
    touchUser(userId) {
      if (users.has(userId)) lastSeen.set(userId, new Date().toISOString());
    },
    listTeamMembers() {
      return [...users.values()].map(({ user }) => ({
        user,
        lastSeenAt: lastSeen.get(user.id) ?? null,
      }));
    },
    addTeamActivity(actorId, input) {
      mustUser(actorId);
      const key = `${actorId}\0${input.sourceId}`;
      if (teamActivityKeys.has(key)) return false;
      teamActivityKeys.add(key);
      teamActivities.push({
        id: randomUUID(),
        actorId,
        kind: input.kind,
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        sourceId: input.sourceId,
        occurredAt: input.occurredAt,
        createdAt: new Date().toISOString(),
      });
      return true;
    },
    listTeamActivities(opts = {}) {
      const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
      const rows = teamActivities
        .filter((a) => (opts.actorId ? a.actorId === opts.actorId : true))
        .filter((a) => (opts.before ? a.occurredAt < opts.before : true))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
      return rows.slice(0, limit).map((a) => ({ ...a }));
    },
    clearTeamActivities(actorId) {
      let removed = 0;
      for (let i = teamActivities.length - 1; i >= 0; i -= 1) {
        if (teamActivities[i].actorId !== actorId) continue;
        teamActivityKeys.delete(`${actorId}\0${teamActivities[i].sourceId}`);
        teamActivities.splice(i, 1);
        removed += 1;
      }
      return removed;
    },
    upsertTeamUsage(actorId, input) {
      mustUser(actorId);
      teamUsage.set(`${actorId}\0${input.date}\0${input.model}`, {
        actorId,
        date: input.date,
        model: input.model,
        tokens: input.tokens,
        unreported: input.unreported ?? 0,
        connections: [...(input.connections ?? [])],
      });
    },
    listTeamUsage({ from, to }) {
      return [...teamUsage.values()]
        .filter((row) => row.date >= from && row.date <= to)
        .sort(
          (a, b) =>
            (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
            (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0) ||
            (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
        )
        .map((row) => ({ ...row, connections: [...row.connections] }));
    },
    clearTeamUsage(actorId) {
      let removed = 0;
      for (const [key, row] of [...teamUsage.entries()]) {
        if (row.actorId !== actorId) continue;
        teamUsage.delete(key);
        removed += 1;
      }
      return removed;
    },
    ensureSystemAgents() {
      for (const [id, meta] of Object.entries(SYSTEM_AGENTS)) {
        if (!agents.has(id)) {
          agents.set(id, {
            id,
            owner_id: null,
            name: meta.name,
            avatar: meta.avatar,
            description: meta.description,
          });
        }
      }
    },
  };
}
