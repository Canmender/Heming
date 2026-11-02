import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
} from "@heming/shared";
import type { Store } from "./store.js";
import { SYSTEM_AGENTS } from "./store.js";
import { openDb } from "./db.js";

export type SqliteStore = Store & { close(): void };

function rowToUser(r: { id: string; username: string; display_name: string; avatar: string | null }): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    // `!= null` 而非真值判断：空串 avatar 是合法用户输入（清空头像），与内存实现同语义
    ...(r.avatar != null ? { avatar: r.avatar } : {}),
  };
}

/** agents 表行（列名 snake_case，永不 SELECT system_prompt——它是部署侧内部字段）。 */
type AgentRow = {
  id: string;
  owner_id: string | null;
  name: string;
  avatar: string | null;
  description: string;
};

/** agents 行 → Agent。avatar 为 null 时不写字段（与 AgentSchema 可选语义一致）。 */
function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    owner_id: r.owner_id,
    name: r.name,
    avatar: r.avatar ?? null,
    description: r.description,
  };
}

export function createSqliteStore(dbPath: string): SqliteStore {
  const db: DatabaseSync = openDb(dbPath);

  /** messages 行 → Message（listMessages 与 reencrypt 回读共用，防映射口径漂移）。 */
  function rowToMessage(r: {
    id: string;
    conv_id: string;
    sender_type: string;
    sender_id: string;
    payload: string;
    created_at: string;
    // E2E 信封列（Task 2）：enc 迁移列恒有（DEFAULT 'plain'）；cipher/chain_kid/n 可空
    enc?: string | null;
    cipher?: string | null;
    chain_kid?: string | null;
    n?: number | null;
  }): Message {
    return {
      id: r.id,
      conversationId: r.conv_id,
      senderType: r.sender_type as "user" | "agent",
      senderId: r.sender_id,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
      // enc 迁移列 NOT NULL DEFAULT 'plain'：老行回读恒 plain；信封可空列 → 缺省不带键
      enc: (r.enc as "plain" | "e2e" | null | undefined) ?? "plain",
      ...(r.cipher != null ? { cipher: r.cipher } : {}),
      ...(r.chain_kid != null ? { chainKid: r.chain_kid } : {}),
      ...(r.n != null ? { n: Number(r.n) } : {}),
    };
  }

  const mustUser = (id: string): User => {
    const row = db
      .prepare("SELECT id, username, display_name, avatar FROM users WHERE id = ?")
      .get(id) as { id: string; username: string; display_name: string; avatar: string | null } | undefined;
    if (!row) throw new Error("user not found");
    return rowToUser(row);
  };

  return {
    close() {
      db.close();
    },

    createUser(username, passwordHash, displayName) {
      const id = randomUUID();
      try {
        db.prepare("INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)").run(
          id,
          username,
          passwordHash,
          displayName,
        );
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw new Error("username taken");
        throw e;
      }
      return { id, username, displayName };
    },
    findUserByUsername(username) {
      const row = db
        .prepare("SELECT id, username, display_name, avatar, password_hash FROM users WHERE username = ?")
        .get(username) as
        | { id: string; username: string; display_name: string; avatar: string | null; password_hash: string }
        | undefined;
      return row ? { user: rowToUser(row), passwordHash: row.password_hash } : null;
    },
    findUserById(id) {
      const row = db.prepare("SELECT id, username, display_name, avatar FROM users WHERE id = ?").get(id) as
        | { id: string; username: string; display_name: string; avatar: string | null }
        | undefined;
      return row ? rowToUser(row) : null;
    },
    updateProfile(userId, patch) {
      const existing = db.prepare("SELECT id, username, display_name, avatar FROM users WHERE id = ?").get(userId) as
        | { id: string; username: string; display_name: string; avatar: string | null }
        | undefined;
      if (!existing) throw new Error("user not found");
      const nextAvatar = patch.avatar !== undefined ? patch.avatar : existing.avatar;
      db.prepare("UPDATE users SET display_name = ?, avatar = ? WHERE id = ?").run(patch.displayName, nextAvatar, userId);
      return {
        id: existing.id,
        username: existing.username,
        displayName: patch.displayName,
        ...(nextAvatar != null ? { avatar: nextAvatar } : {}),
      };
    },
    isMember(conversationId, userId) {
      const row = db
        .prepare("SELECT 1 AS x FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId);
      return !!row;
    },
    conversationAgentId(conversationId) {
      const row = db
        .prepare("SELECT agent_id FROM conversation_agents WHERE conv_id = ? LIMIT 1")
        .get(conversationId) as { agent_id: string } | undefined;
      return row?.agent_id ?? null;
    },
    addMessage(conversationId, senderType, senderId, payload, envelope) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const msg: Message = {
        id: randomUUID(),
        conversationId,
        senderType,
        senderId,
        payload,
        createdAt: new Date().toISOString(),
        // 信封（E2E Task 2）：省略 envelope → plain；列值与回读映射同口径
        enc: envelope?.enc ?? "plain",
        ...(envelope?.cipher !== undefined ? { cipher: envelope.cipher } : {}),
        ...(envelope?.chainKid !== undefined ? { chainKid: envelope.chainKid } : {}),
        ...(envelope?.n !== undefined ? { n: envelope.n } : {}),
      };
      db.prepare(
        `INSERT INTO messages (id, conv_id, sender_type, sender_id, payload, reply_to, created_at, recalled_at, enc, cipher, chain_kid, n)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        msg.id,
        conversationId,
        senderType,
        senderId,
        JSON.stringify(payload),
        null,
        msg.createdAt,
        msg.enc,
        envelope?.cipher ?? null,
        envelope?.chainKid ?? null,
        envelope?.n ?? null,
      );
      return msg;
    },
    listMessages(conversationId, limit) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const rows = (
        limit
          ? db
              .prepare("SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
              .all(conversationId, limit)
          : db.prepare("SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at ASC, rowid ASC").all(conversationId)
      ) as Parameters<typeof rowToMessage>[0][];
      const ordered = limit ? [...rows].reverse() : rows;
      return ordered.map(rowToMessage);
    },
    reencryptMessage(messageId, userId, envelope) {
      // 单条件 UPDATE 完成鉴权与写入（sender + enc='plain'）→ 原子替换信封四字段，
      // 并在**同一条 UPDATE** 内清明文：payload 置 {"text":""} 占位（列 NOT NULL 不能
      // 置 NULL）、reply_to 置 NULL——出站 listMessages 对 e2e 不再含原文。
      // changes=0 时回读分类三态（sender 先于 enc 判，与内存实现同优先级）。
      const res = db
        .prepare(
          `UPDATE messages SET enc = 'e2e', cipher = ?, chain_kid = ?, n = ?,
             payload = ?, reply_to = NULL
           WHERE id = ? AND sender_id = ? AND enc = 'plain'`,
        )
        .run(
          envelope.cipher,
          envelope.chainKid ?? null,
          envelope.n ?? null,
          JSON.stringify({ text: "" }),
          messageId,
          userId,
        );
      if (res.changes > 0) {
        const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
          | Parameters<typeof rowToMessage>[0]
          | undefined;
        if (row) return { ok: true, message: rowToMessage(row) };
        return { ok: false, reason: "not_found" }; // 刚更新成功却回读缺失：理论不可达，兜底
      }
      const row = db.prepare("SELECT sender_id, enc FROM messages WHERE id = ?").get(messageId) as
        | { sender_id: string; enc: string }
        | undefined;
      if (!row) return { ok: false, reason: "not_found" };
      if (row.sender_id !== userId) return { ok: false, reason: "forbidden" };
      return { ok: false, reason: "conflict" };
    },
    upsertE2eDevice(userId, device) {
      // (user_id, ik_ecdh) 主键冲突 → 覆盖（SPK 轮换）；UPDATE 不动 rowid → 设备序保持
      db.prepare(
        `INSERT INTO e2e_keys (user_id, ik_ecdh, ik_sign, spk_pub, spk_sig, spk_created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, ik_ecdh) DO UPDATE SET
           ik_sign = excluded.ik_sign, spk_pub = excluded.spk_pub,
           spk_sig = excluded.spk_sig, spk_created_at = excluded.spk_created_at`,
      ).run(userId, device.ikEcdh, device.ikSign, device.spk.pub, device.spk.sig, device.spk.createdAt);
    },
    listE2eKeys() {
      // rowid 序 = 登记序（同内存 Map 插入序口径；冲突 UPDATE 保留原 rowid）
      const rows = db
        .prepare(
          `SELECT user_id, ik_ecdh, ik_sign, spk_pub, spk_sig, spk_created_at
           FROM e2e_keys ORDER BY rowid`,
        )
        .all() as {
        user_id: string;
        ik_ecdh: string;
        ik_sign: string;
        spk_pub: string;
        spk_sig: string;
        spk_created_at: number;
      }[];
      const out: Record<string, E2eDeviceKeys[]> = {};
      for (const r of rows) {
        (out[r.user_id] ??= []).push({
          ikEcdh: r.ik_ecdh,
          ikSign: r.ik_sign,
          spk: { pub: r.spk_pub, sig: r.spk_sig, createdAt: Number(r.spk_created_at) },
        });
      }
      return out;
    },
    listConversations(userId) {
      const convs = db
        .prepare(
          `SELECT c.id FROM conversations c
           JOIN conversation_members m ON m.conv_id = c.id
           WHERE m.member_id = ? AND c.kind = 'agent'`,
        )
        .all(userId) as { id: string }[];
      const lastMessageAtOf = (convId: string): string | null => {
        const row = db
          .prepare("SELECT created_at FROM messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT 1")
          .get(convId) as { created_at: string } | undefined;
        return row?.created_at ?? null;
      };
      const out: Conversation[] = [];
      for (const c of convs) {
        // 智能体一对一：对方是名册 agent，复用 conversation_agents 关联行存对方 id。
        // INNER JOIN agents——agent 已删则不出这条会话（宁可不显示，也不给半截对象）。
        const agent = db
          .prepare(
            `SELECT a.id, a.owner_id, a.name, a.avatar, a.description
             FROM conversation_agents ca JOIN agents a ON a.id = ca.agent_id
             WHERE ca.conv_id = ? LIMIT 1`,
          )
          .get(c.id) as AgentRow | undefined;
        if (agent)
          out.push({
            id: c.id,
            type: "agent",
            agent: rowToAgent(agent),
            // 智能体会话没有「别人发来」的概念，未读恒为 0（读状态随人类 IM 一起删除）。
            unreadCount: 0,
            lastMessageAt: lastMessageAtOf(c.id),
          });
      }
      return out;
    },
    createAgentConversation(userId, agentId) {
      mustUser(userId);
      const row = db
        .prepare("SELECT id, owner_id, name, avatar, description FROM agents WHERE id = ?")
        .get(agentId) as AgentRow | undefined;
      if (!row) throw new Error("agent not found");
      // 与内存实现同口径：系统预设 agent（owner_id 为 null）谁都能私聊，
      // 自建 agent 仅属主可开——否则能拿别人的 agent 当自己的聊天对象。
      if (row.owner_id !== null && row.owner_id !== userId) throw new Error("not your agent");
      const agent = rowToAgent(row);
      // 幂等：同用户与同 agent 只留一个会话。conversation_agents 存「会话挂了哪些 agent」，
      // agent 一对一恰好只挂一个，据此反查即可，不必另建映射表。
      const existing = db
        .prepare(
          `SELECT c.id FROM conversations c
           JOIN conversation_members m ON m.conv_id = c.id AND m.member_id = ?
           JOIN conversation_agents ca ON ca.conv_id = c.id AND ca.agent_id = ?
           WHERE c.kind = 'agent'`,
        )
        .get(userId, agentId) as { id: string } | undefined;
      if (existing) return { id: existing.id, type: "agent", agent };
      const id = randomUUID();
      db.prepare("INSERT INTO conversations (id, kind) VALUES (?, 'agent')").run(id);
      db.prepare("INSERT INTO conversation_members (conv_id, member_id) VALUES (?, ?)").run(id, userId);
      db.prepare("INSERT OR IGNORE INTO conversation_agents (conv_id, agent_id) VALUES (?, ?)").run(id, agentId);
      return { id, type: "agent", agent };
    },
    listAgents() {
      // 永不 SELECT system_prompt：系统提示词是部署侧内部字段，名册 API 契约不含它。
      // 系统 agent 由 ensureSystemAgents upsert 落行，此处直接读表即自然出现。
      const rows = db
        .prepare("SELECT id, owner_id, name, avatar, description FROM agents")
        .all() as {
        id: string;
        owner_id: string | null;
        name: string;
        avatar: string | null;
        description: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        owner_id: r.owner_id,
        name: r.name,
        avatar: r.avatar,
        description: r.description,
      }));
    },
    createAgent(ownerId, body) {
      mustUser(ownerId);
      const id = randomUUID();
      const avatar = body.avatar ?? null;
      db.prepare("INSERT INTO agents (id, owner_id, name, avatar, description) VALUES (?, ?, ?, ?, ?)").run(
        id,
        ownerId,
        body.name,
        avatar,
        body.description,
      );
      return { id, owner_id: ownerId, name: body.name, avatar, description: body.description };
    },
    updateAgent(id, ownerId, patch) {
      const cur = db
        .prepare("SELECT id, owner_id, name, avatar, description FROM agents WHERE id = ?")
        .get(id) as
        | { id: string; owner_id: string | null; name: string; avatar: string | null; description: string }
        | undefined;
      if (!cur) throw new Error("agent not found");
      // 系统 agent（owner_id IS NULL）与非 owner 同拒：forbidden
      if (cur.owner_id === null || cur.owner_id !== ownerId) throw new Error("forbidden");
      const next: Agent = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      };
      db.prepare("UPDATE agents SET name = ?, avatar = ?, description = ? WHERE id = ?").run(
        next.name,
        next.avatar,
        next.description,
        id,
      );
      return next;
    },
    deleteAgent(id, ownerId) {
      const cur = db.prepare("SELECT owner_id FROM agents WHERE id = ?").get(id) as
        | { owner_id: string | null }
        | undefined;
      if (!cur) throw new Error("agent not found");
      if (cur.owner_id === null || cur.owner_id !== ownerId) throw new Error("forbidden");
      db.prepare("DELETE FROM conversation_agents WHERE agent_id = ?").run(id);
      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    },
    // —— M4 共享文件（shared_files 表；行结构 ↔ SharedFileMeta 映射同 users 行的 rowTo* 口径）——
    addFile(meta, contentBase64) {
      db.prepare(
        "INSERT INTO shared_files (id, owner, name, mime, size, updated_at, content_base64) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(meta.id, meta.owner, meta.name, meta.mime, meta.size, meta.updatedAt, contentBase64);
      return meta;
    },
    getFile(id) {
      const row = db
        .prepare("SELECT id, owner, name, mime, size, updated_at, content_base64 FROM shared_files WHERE id = ?")
        .get(id) as
        | { id: string; owner: string; name: string; mime: string; size: number; updated_at: string; content_base64: string }
        | undefined;
      if (!row) return null;
      return {
        meta: { id: row.id, owner: row.owner, name: row.name, mime: row.mime, size: row.size, updatedAt: row.updated_at },
        contentBase64: row.content_base64,
      };
    },
    listFiles() {
      const rows = db
        .prepare("SELECT id, owner, name, mime, size, updated_at FROM shared_files ORDER BY updated_at DESC")
        .all() as Array<{ id: string; owner: string; name: string; mime: string; size: number; updated_at: string }>;
      return rows.map((row) => ({ id: row.id, owner: row.owner, name: row.name, mime: row.mime, size: row.size, updatedAt: row.updated_at }));
    },
    deleteFile(id) {
      return db.prepare("DELETE FROM shared_files WHERE id = ?").run(id).changes > 0;
    },
    userFileBytes(ownerUsername) {
      const row = db
        .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM shared_files WHERE owner = ?")
        .get(ownerUsername) as { total: number };
      return row.total;
    },
    touchUser(userId) {
      db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
    },
    listTeamMembers() {
      const rows = db
        .prepare(
          `SELECT id, username, display_name, avatar, last_seen_at FROM users
           ORDER BY last_seen_at IS NULL, last_seen_at DESC, display_name COLLATE NOCASE`,
        )
        .all() as Array<{
        id: string;
        username: string;
        display_name: string;
        avatar: string | null;
        last_seen_at: string | null;
      }>;
      return rows.map((r) => ({ user: rowToUser(r), lastSeenAt: r.last_seen_at ?? null }));
    },
    addTeamActivity(actorId, input: TeamActivityInput) {
      mustUser(actorId);
      const now = new Date().toISOString();
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO team_activities
             (id, actor_id, kind, title, detail, status, source_id, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          actorId,
          input.kind,
          input.title,
          input.detail ?? null,
          input.status ?? null,
          input.sourceId,
          input.occurredAt,
          now,
        );
      return res.changes > 0;
    },
    listTeamActivities(opts = {}) {
      const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
      const where: string[] = [];
      const params: string[] = [];
      if (opts.before) {
        where.push("occurred_at < ?");
        params.push(opts.before);
      }
      if (opts.actorId) {
        where.push("actor_id = ?");
        params.push(opts.actorId);
      }
      const sql = `SELECT id, actor_id, kind, title, detail, status, source_id, occurred_at, created_at
                   FROM team_activities
                   ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY occurred_at DESC, created_at DESC
                   LIMIT ?`;
      const rows = db.prepare(sql).all(...params, limit) as Array<{
        id: string;
        actor_id: string;
        kind: TeamActivity["kind"];
        title: string;
        detail: string | null;
        status: string | null;
        source_id: string;
        occurred_at: string;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        kind: r.kind,
        title: r.title,
        ...(r.detail != null ? { detail: r.detail } : {}),
        ...(r.status != null ? { status: r.status } : {}),
        sourceId: r.source_id,
        occurredAt: r.occurred_at,
        createdAt: r.created_at,
      }));
    },
    clearTeamActivities(actorId) {
      return Number(db.prepare("DELETE FROM team_activities WHERE actor_id = ?").run(actorId).changes);
    },
    ensureSystemAgents() {
      const upsert = db.prepare(
        `INSERT INTO agents (id, owner_id, name, avatar, description, system_prompt)
         VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
           description = excluded.description, system_prompt = excluded.system_prompt`,
      );
      for (const [id, meta] of Object.entries(SYSTEM_AGENTS)) {
        upsert.run(id, meta.name, meta.avatar, meta.description, meta.systemPrompt);
      }
    },
  };
}
