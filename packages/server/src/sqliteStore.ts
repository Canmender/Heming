import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { User, Message, Conversation, Member, ReadState, Agent, SharedFileMeta, MessageEnvelope, E2eDeviceKeys } from "@heming/shared";
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

  /** messages 行 → Message（listMessages 与 recallMessage 回读共用，防映射口径漂移）。 */
  function rowToMessage(r: {
    id: string;
    conv_id: string;
    sender_type: string;
    sender_id: string;
    payload: string;
    reply_to: string | null;
    created_at: string;
    recalled_at?: string | null;
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
      replyTo: r.reply_to,
      createdAt: r.created_at,
      // 老库迁移来的行 recalled_at 为 NULL → 恒有字段按 null 出
      recalledAt: r.recalled_at ?? null,
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
    setConversationArchived(conversationId, userId, archived) {
      if (!archived) {
        const cleared = db
          .prepare("UPDATE conversation_members SET archived_at = NULL WHERE conv_id = ? AND member_id = ?")
          .run(conversationId, userId);
        if (Number(cleared.changes) === 0) {
          throw new Error("conversation not found or not a member");
        }
        return;
      }
      // 归档：**保留首次归档时间**。
      //
      // 不用「先读再判断再写」：那是两次往返，且中间可能被并发改写。
      // 直接用一条带条件的 UPDATE ——只有当前**未归档**的行会被写入，
      // 已归档的行 changes=0，正好表示「无需改动」。
      //
      // 为什么必须保留首次时间：归档页按它倒序。若每次都刷新成现在，
      // 用户重复点归档会让条目在列表里跳位——看起来像坏了。
      //
      // 但「已归档」本身也要校验成员身份，所以分两步：
      // 第一步无条件写（未归档才生效），第二步用影响行数区分
      // 「不是成员」与「已是归档态」。
      const result = db
        .prepare(
          `UPDATE conversation_members SET archived_at = ?
           WHERE conv_id = ? AND member_id = ? AND archived_at IS NULL`,
        )
        .run(new Date().toISOString(), conversationId, userId);
      if (Number(result.changes) > 0) return;

      // 没改动：要么不是成员，要么已经是归档态。用一次存在性查询区分。
      const row = db
        .prepare("SELECT 1 AS ok FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId) as { ok: number } | undefined;
      if (!row) throw new Error("conversation not found or not a member");
    },
    isMember(conversationId, userId) {
      const row = db
        .prepare("SELECT 1 AS x FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId);
      return !!row;
    },
    addMessage(conversationId, senderType, senderId, payload, replyTo, envelope) {
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
        recalledAt: null,
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
        replyTo,
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
    recallMessage(conversationId, messageId, userId) {
      // 权限口径同 memory：非成员/消息不存在 → 0 changes → null；UPDATE 带 sender_id 限定
      // 使「非本人」也不落库（changes=0 → null），单一语句完成鉴权与持久化。
      if (!this.isMember(conversationId, userId)) return null;
      const res = db
        .prepare("UPDATE messages SET recalled_at = ? WHERE id = ? AND conv_id = ? AND sender_id = ?")
        .run(new Date().toISOString(), messageId, conversationId, userId);
      if (res.changes === 0) return null;
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
        | Parameters<typeof rowToMessage>[0]
        | undefined;
      return row ? rowToMessage(row) : null;
    },
    reencryptMessage(messageId, userId, envelope) {
      // 单条件 UPDATE 完成鉴权与写入（sender + enc='plain'）→ 原子替换信封四字段，
      // 并在**同一条 UPDATE** 内清明文：payload 置 {"text":""} 占位（列 NOT NULL 不能
      // 置 NULL）、reply_to 置 NULL——出站 listMessages 对 e2e 不再含原文/回复指向。
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
          `SELECT c.id, c.kind, c.name, m.archived_at FROM conversations c
           JOIN conversation_members m ON m.conv_id = c.id WHERE m.member_id = ?`,
        )
        .all(userId) as { id: string; kind: string; name: string | null; archived_at: string | null }[];
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
      const lastMessageAtOf = (convId: string): string | null => {
        const row = db
          .prepare(
            "SELECT created_at FROM messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(convId) as { created_at: string } | undefined;
        return row?.created_at ?? null;
      };
      const lastReadAtOf = (convId: string): string | null => {
        const row = db
          .prepare("SELECT read_at FROM message_reads WHERE conv_id = ? AND user_id = ?")
          .get(convId, userId) as { read_at: string } | undefined;
        return row?.read_at ?? null;
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
            lastMessageAt: lastMessageAtOf(c.id),
            lastReadAt: lastReadAtOf(c.id),
            archivedAt: c.archived_at,
          });
        } else if (c.kind === "agent") {
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
              unreadCount: unreadOf(c.id),
              lastMessageAt: lastMessageAtOf(c.id),
              lastReadAt: lastReadAtOf(c.id),
              archivedAt: c.archived_at,
            });
        } else {
          const peer = db
            .prepare("SELECT member_id FROM conversation_members WHERE conv_id = ? AND member_id != ?")
            .get(c.id, userId) as { member_id: string } | undefined;
          if (peer)
            out.push({
              id: c.id,
              type: "direct",
              peer: mustUser(peer.member_id),
              unreadCount: unreadOf(c.id),
              lastMessageAt: lastMessageAtOf(c.id),
              lastReadAt: lastReadAtOf(c.id),
              archivedAt: c.archived_at,
            });
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
  };
}
