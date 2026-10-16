import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { User, Message, Conversation, Member, ReadState, Agent } from "@heming/shared";
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

export function createSqliteStore(dbPath: string): SqliteStore {
  const db: DatabaseSync = openDb(dbPath);

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
    createFriendRequest(fromId, toUsername) {
      mustUser(fromId);
      const to = this.findUserByUsername(toUsername);
      if (!to) throw new Error("peer not found");
      if (to.user.id === fromId) throw new Error("cannot friend self");
      const dup = db
        .prepare(
          `SELECT id FROM friend_requests WHERE status = 'pending' AND
            ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`,
        )
        .get(fromId, to.user.id, to.user.id, fromId);
      if (dup) throw new Error("request already exists");
      const id = randomUUID();
      db.prepare("INSERT INTO friend_requests (id, from_id, to_id, status) VALUES (?, ?, ?, 'pending')").run(
        id,
        fromId,
        to.user.id,
      );
      return { id, from: mustUser(fromId), to: to.user, status: "pending" as const };
    },
    acceptFriendRequest(requestId, userId) {
      const row = db.prepare("SELECT id, from_id, to_id, status FROM friend_requests WHERE id = ?").get(requestId) as
        | { id: string; from_id: string; to_id: string; status: string }
        | undefined;
      if (!row) throw new Error("request not found");
      if (row.to_id !== userId) throw new Error("not request recipient");
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(requestId);
      return { id: row.id, user: mustUser(row.from_id) };
    },
    listFriends(userId) {
      const rows = db
        .prepare(
          `SELECT id, from_id, to_id FROM friend_requests WHERE status = 'accepted' AND (from_id = ? OR to_id = ?)`,
        )
        .all(userId, userId) as { id: string; from_id: string; to_id: string }[];
      return rows.map((r) => ({ id: r.id, user: mustUser(r.from_id === userId ? r.to_id : r.from_id) }));
    },
    listIncomingRequests(userId) {
      const rows = db
        .prepare(`SELECT id, from_id FROM friend_requests WHERE status = 'pending' AND to_id = ?`)
        .all(userId) as { id: string; from_id: string }[];
      return rows.map((r) => ({ id: r.id, from: mustUser(r.from_id) }));
    },
    createDirectConversation(aId, bId) {
      mustUser(aId);
      mustUser(bId);
      const friends = db
        .prepare(
          `SELECT 1 FROM friend_requests WHERE status = 'accepted' AND
            ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`,
        )
        .get(aId, bId, bId, aId);
      if (!friends) throw new Error("not friends");
      const found = db
        .prepare(
          `SELECT c.id FROM conversations c
           JOIN conversation_members m1 ON m1.conv_id = c.id AND m1.member_id = ?
           JOIN conversation_members m2 ON m2.conv_id = c.id AND m2.member_id = ?
           WHERE c.kind = 'direct'`,
        )
        .get(aId, bId) as { id: string } | undefined;
      if (found) return { id: found.id, type: "direct", peer: mustUser(bId) };
      const id = randomUUID();
      db.prepare("INSERT INTO conversations (id, kind) VALUES (?, 'direct')").run(id);
      const ins = db.prepare("INSERT INTO conversation_members (conv_id, member_id) VALUES (?, ?)");
      ins.run(id, aId);
      ins.run(id, bId);
      return { id, type: "direct", peer: mustUser(bId) };
    },
    createGroup(creatorId, name, memberIds) {
      mustUser(creatorId);
      const ids = [...new Set([creatorId, ...memberIds])];
      for (const id of ids) mustUser(id);
      // 口径同 createDirectConversation：除 creator 自身外，入群者须与 creator 已接受好友
      for (const id of ids) {
        if (id === creatorId) continue;
        const friends = db
          .prepare(
            `SELECT 1 FROM friend_requests WHERE status = 'accepted' AND
              ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`,
          )
          .get(creatorId, id, id, creatorId);
        if (!friends) throw new Error("not friends");
      }
      const id = randomUUID();
      db.prepare("INSERT INTO conversations (id, kind, name, created_by) VALUES (?, 'group', ?, ?)").run(
        id,
        name,
        creatorId,
      );
      const ins = db.prepare("INSERT INTO conversation_members (conv_id, member_id) VALUES (?, ?)");
      for (const m of ids) ins.run(id, m);
      return { id, type: "group", name };
    },
    isMember(conversationId, userId) {
      const row = db
        .prepare("SELECT 1 AS x FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId);
      return !!row;
    },
    addMessage(conversationId, senderType, senderId, payload, replyTo) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const msg: Message = {
        id: randomUUID(),
        conversationId,
        senderType,
        senderId,
        payload,
        replyTo,
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO messages (id, conv_id, sender_type, sender_id, payload, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(msg.id, conversationId, senderType, senderId, JSON.stringify(payload), replyTo, msg.createdAt);
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
      ) as {
        id: string;
        conv_id: string;
        sender_type: string;
        sender_id: string;
        payload: string;
        reply_to: string | null;
        created_at: string;
      }[];
      const ordered = limit ? [...rows].reverse() : rows;
      return ordered.map((r) => ({
        id: r.id,
        conversationId: r.conv_id,
        senderType: r.sender_type as "user" | "agent",
        senderId: r.sender_id,
        payload: JSON.parse(r.payload),
        replyTo: r.reply_to,
        createdAt: r.created_at,
      }));
    },
    listConversations(userId) {
      const convs = db
        .prepare(
          `SELECT c.id, c.kind, c.name FROM conversations c
           JOIN conversation_members m ON m.conv_id = c.id WHERE m.member_id = ?`,
        )
        .all(userId) as { id: string; kind: string; name: string | null }[];
      const unreadOf = (convId: string): number => {
        const read = db
          .prepare("SELECT read_at FROM message_reads WHERE conv_id = ? AND user_id = ?")
          .get(convId, userId) as { read_at: string } | undefined;
        if (read) {
          const row = db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id != ? AND created_at > ?")
            .get(convId, userId, read.read_at) as { n: number };
          return Number(row.n);
        }
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id != ?")
          .get(convId, userId) as { n: number };
        return Number(row.n);
      };
      const out: Conversation[] = [];
      for (const c of convs) {
        if (c.kind === "group") {
          const mc = db
            .prepare("SELECT COUNT(*) AS n FROM conversation_members WHERE conv_id = ?")
            .get(c.id) as { n: number };
          out.push({
            id: c.id,
            type: "group",
            name: c.name ?? "未命名群",
            memberCount: Number(mc.n),
            unreadCount: unreadOf(c.id),
          });
        } else {
          const peer = db
            .prepare("SELECT member_id FROM conversation_members WHERE conv_id = ? AND member_id != ?")
            .get(c.id, userId) as { member_id: string } | undefined;
          if (peer) out.push({ id: c.id, type: "direct", peer: mustUser(peer.member_id), unreadCount: unreadOf(c.id) });
        }
      }
      return out;
    },
    listMembers(conversationId) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const rows = db.prepare("SELECT member_id FROM conversation_members WHERE conv_id = ?").all(conversationId) as {
        member_id: string;
      }[];
      const out: Member[] = rows.map((r) => {
        const u = mustUser(r.member_id);
        return { kind: "user" as const, id: r.member_id, name: u.displayName, avatar: u.avatar ?? null, user: u };
      });
      // agent 行尾部追加：conversation_agents JOIN agents 取元数据（INNER JOIN——
      // agents 行缺失即丢行，与内存实现「未知 agentId 跳过」同语义）。
      const agentRows = db
        .prepare(
          `SELECT a.id, a.name, a.avatar FROM conversation_agents ca
           JOIN agents a ON a.id = ca.agent_id WHERE ca.conv_id = ?`,
        )
        .all(conversationId) as { id: string; name: string; avatar: string | null }[];
      for (const a of agentRows) {
        out.push({ kind: "agent", id: a.id, name: a.name, avatar: a.avatar, user: null });
      }
      return out;
    },
    markRead(conversationId, userId) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      if (!this.isMember(conversationId, userId)) throw new Error("not a member");
      db.prepare(
        `INSERT INTO message_reads (conv_id, user_id, read_at) VALUES (?, ?, ?)
         ON CONFLICT(conv_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
      ).run(conversationId, userId, new Date().toISOString());
    },
    listReads(conversationId) {
      const rows = db.prepare("SELECT user_id, read_at FROM message_reads WHERE conv_id = ?").all(conversationId) as {
        user_id: string;
        read_at: string;
      }[];
      return rows.map((r) => ({ userId: r.user_id, at: r.read_at }));
    },
    listUserIds() {
      const rows = db.prepare("SELECT id FROM users").all() as { id: string }[];
      return rows.map((r) => r.id);
    },
    ensurePresetGroup(name, userIds, agentId) {
      // B 语义（防劫持 + 启动补成员）：只匹配预设群（created_by IS NULL——用户自建同名群
      // 由 createGroup 写 creator id，不参与匹配）；命中则把 userIds 中尚未入群的用户
      // INSERT OR IGNORE 补入（幂等），返回同一 id。
      const existing = db
        .prepare("SELECT id FROM conversations WHERE kind = 'group' AND name = ? AND created_by IS NULL")
        .get(name) as { id: string } | undefined;
      if (existing) {
        const hasMember = db.prepare("SELECT 1 FROM conversation_members WHERE conv_id = ? AND member_id = ?");
        const ins = db.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, member_id) VALUES (?, ?)");
        for (const u of new Set(userIds)) {
          if (hasMember.get(existing.id, u)) continue;
          mustUser(u);
          ins.run(existing.id, u);
        }
        return existing.id;
      }
      const meta = SYSTEM_AGENTS[agentId];
      if (!meta) throw new Error(`unknown system agent: ${agentId}`);
      if (userIds.length === 0) throw new Error("preset group requires at least one user");
      const ids = [...new Set(userIds)];
      for (const id of ids) mustUser(id);
      const id = randomUUID();
      db.prepare("INSERT INTO conversations (id, kind, name, created_by) VALUES (?, 'group', ?, NULL)").run(id, name);
      const ins = db.prepare("INSERT INTO conversation_members (conv_id, member_id) VALUES (?, ?)");
      for (const m of ids) ins.run(id, m);
      // 登记 agent（upsert——已存在则保留既有 name/avatar 等行数据？不：预设 agent 元数据
      // 以 SYSTEM_AGENTS 为准，DO UPDATE 保证幂等后元数据仍一致）
      db.prepare(
        `INSERT INTO agents (id, owner_id, name, avatar, description, system_prompt)
         VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
           description = excluded.description, system_prompt = excluded.system_prompt`,
      ).run(agentId, meta.name, meta.avatar, meta.description, meta.systemPrompt);
      db.prepare("INSERT INTO conversation_agents (conv_id, agent_id) VALUES (?, ?)").run(id, agentId);
      return id;
    },
    listAgentIds(conversationId) {
      const rows = db.prepare("SELECT agent_id FROM conversation_agents WHERE conv_id = ?").all(conversationId) as {
        agent_id: string;
      }[];
      return rows.map((r) => r.agent_id);
    },
    attachAgentToGroup(conversationId, agentId) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      // 幂等：PRIMARY KEY (conv_id, agent_id) 冲突即 no-op（与内存 includes 判断同语义）
      db.prepare("INSERT OR IGNORE INTO conversation_agents (conv_id, agent_id) VALUES (?, ?)").run(
        conversationId,
        agentId,
      );
    },
    detachAgentFromGroup(conversationId, agentId) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      db.prepare("DELETE FROM conversation_agents WHERE conv_id = ? AND agent_id = ?").run(
        conversationId,
        agentId,
      );
    },
    listAgents() {
      // 永不 SELECT system_prompt：系统提示词是部署侧内部字段，名册 API 契约不含它。
      // 系统 agent 由 ensurePresetGroup upsert 落行，此处直接读表即自然出现。
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
  };
}
