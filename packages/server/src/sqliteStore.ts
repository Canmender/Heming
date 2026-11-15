import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import type {
  User,
  Message,
  Conversation,
  Agent,
  SharedFileMeta,
  MessageEnvelope,
  E2eDeviceKeys,
  Workspace,
  TeamActivity,
  TeamActivityInput,
  TeamUsageInput,
  TeamItemStatus,
  TeamMemberRole,
  TeamPlanItem,
  TeamTask,
  TeamWorkspaceSnapshot,
  WorkspaceTeam,
} from "@heming/shared";
import type { Store, TeamUsageRow } from "./store.js";
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

  /**
   * 显式事务：node:sqlite 没有 transaction 助手（同 deleteConversation 的写法）。
   *
   * 团队的多语句写（建团队+建 owner 成员、删团队级联、移除成员+解绑任务、删方案+解绑任务、
   * 判重+加成员）中途失败会留下**看不见也删不掉**的半截态：团队行在、成员行没了 →
   * visibleTeam/listWorkspaceTeams 都查不到它，但 DELETE 也 404，任何 API 都清不掉。
   * db.ts 的建表注释本来就把「四个删除口在事务里清干净」写成契约。
   */
  function runTx<T>(fn: () => T): T {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

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

  /* ───────────────── d.92 团队工作台：行映射与可见性判定 ───────────────── */

  type TeamRow = {
    id: string;
    name: string;
    goal: string;
    owner_id: string;
    created_at: string;
    updated_at: string;
  };
  const rowToTeam = (r: TeamRow): WorkspaceTeam => ({
    id: r.id,
    name: r.name,
    goal: r.goal,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  type PlanRow = {
    id: string;
    team_id: string;
    title: string;
    detail: string;
    status: string;
    order_index: number;
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  const rowToPlan = (r: PlanRow): TeamPlanItem => ({
    id: r.id,
    teamId: r.team_id,
    title: r.title,
    detail: r.detail,
    status: r.status as TeamItemStatus,
    orderIndex: Number(r.order_index),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  type TaskRow = {
    id: string;
    team_id: string;
    plan_id: string | null;
    title: string;
    detail: string;
    assignee_id: string | null;
    status: string;
    created_by: string;
    created_at: string;
    updated_at: string;
    due_at: string | null;
    attachment_file_id: string | null;
  };
  const rowToTask = (r: TaskRow): TeamTask => ({
    id: r.id,
    teamId: r.team_id,
    planId: r.plan_id ?? null,
    title: r.title,
    detail: r.detail,
    assigneeId: r.assignee_id ?? null,
    status: r.status as TeamItemStatus,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dueAt: r.due_at ?? null,
    attachmentFileId: r.attachment_file_id ?? null,
  });

  const teamMemberRole = (teamId: string, userId: string): TeamMemberRole | null => {
    const row = db
      .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
      .get(teamId, userId) as { role: string } | undefined;
    return row ? (row.role as TeamMemberRole) : null;
  };

  /** 可见团队：存在且本人是成员；否则 null（app 层一律 404，不泄露存在性）。 */
  const visibleTeam = (teamId: string, actorId: string): WorkspaceTeam | null => {
    const row = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as TeamRow | undefined;
    if (!row) return null;
    if (!teamMemberRole(teamId, actorId)) return null;
    return rowToTeam(row);
  };

  /** 团队内有任何动静就刷新 updated_at：列表按它倒序排（与内存实现同语义）。 */
  const touchTeam = (teamId: string): void => {
    db.prepare("UPDATE teams SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), teamId);
  };

  const snapshotOf = (teamId: string): TeamWorkspaceSnapshot => {
    const teamRow = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as TeamRow | undefined;
    if (!teamRow) throw new Error("team not found");
    const memberRows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar, m.role, m.joined_at
         FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?`,
      )
      .all(teamId) as Array<{
      id: string;
      username: string;
      display_name: string;
      avatar: string | null;
      role: string;
      joined_at: string;
    }>;
    // 成员排序在 JS 里做：SQLite 的排序规则与 JS localeCompare 不同，
    // 放在一处（与内存实现逐字一致）才能保证「两实现同一契约」的断言稳定。
    const members = memberRows
      .map((r) => ({
        user: rowToUser(r),
        role: r.role as TeamMemberRole,
        joinedAt: r.joined_at,
      }))
      .sort(
        (a, b) =>
          (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1) ||
          (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0) ||
          a.user.displayName.localeCompare(b.user.displayName, "zh-Hans-CN") ||
          // 显示名可以重名（用户自己填的）：再用 id 兜底，保证名册顺序稳定、两实现一致。
          a.user.id.localeCompare(b.user.id),
      );
    const plans = (
      db
        .prepare(
          "SELECT * FROM team_plans WHERE team_id = ? ORDER BY order_index ASC, created_at ASC, id ASC",
        )
        .all(teamId) as PlanRow[]
    ).map(rowToPlan);
    const tasks = (
      db
        .prepare("SELECT * FROM team_tasks WHERE team_id = ? ORDER BY created_at ASC, id ASC")
        .all(teamId) as TaskRow[]
    ).map(rowToTask);
    return { team: rowToTeam(teamRow), members, plans, tasks };
  };

  /**
   * 幂等登记唯一内置智能体 + 旧数据迁移（单智能体产品；构造与 index.ts 启动各调一次）。
   *  1) upsert 内置智能体行（owner_id 归 NULL；system_prompt 是部署侧内部字段）；
   *  2) 旧版自建智能体会话改挂内置智能体：conversation_agents 主键 (conv_id, agent_id)，
   *     直接 UPDATE 可能与既有 system 行撞主键，故先 INSERT OR IGNORE 目标行再删旧行；
   *  3) 删除自建 agent 行（owner_id IS NOT NULL）——会话行、成员、消息全部保留。
   * 迁移幂等：重复调用只会重复选中零行。
   */
  const ensureSystemAgentRows = (): void => {
    const upsert = db.prepare(
      `INSERT INTO agents (id, owner_id, name, avatar, description, system_prompt)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner_id = NULL, name = excluded.name,
         avatar = excluded.avatar, description = excluded.description,
         system_prompt = excluded.system_prompt`,
    );
    for (const [id, meta] of Object.entries(SYSTEM_AGENTS)) {
      upsert.run(id, meta.name, meta.avatar, meta.description, meta.systemPrompt);
    }
    // 迁移放在事务里：中途失败整体回滚，不留「旧 agent 已删、会话未改挂」的半截态。
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT OR IGNORE INTO conversation_agents (conv_id, agent_id)
         SELECT conv_id, ? FROM conversation_agents WHERE agent_id <> ?`,
      ).run(SYSTEM_AGENT_ID, SYSTEM_AGENT_ID);
      db.prepare("DELETE FROM conversation_agents WHERE agent_id <> ?").run(SYSTEM_AGENT_ID);
      db.prepare("DELETE FROM agents WHERE owner_id IS NOT NULL").run();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  // 构造即完成单智能体化：直接 new store 的测试/调用方同样得到「名册恒一条」的不变量。
  ensureSystemAgentRows();

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
    addSession(tokenDigest, userId) {
      db.prepare(
        "INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
      ).run(tokenDigest, userId, new Date().toISOString());
    },
    sessionUserId(tokenDigest) {
      const row = db
        .prepare("SELECT user_id FROM sessions WHERE token_hash = ?")
        .get(tokenDigest) as { user_id: string } | undefined;
      return row?.user_id ?? null;
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
          `SELECT c.id, c.title, c.workspace FROM conversations c
           JOIN conversation_members m ON m.conv_id = c.id
           WHERE m.member_id = ? AND c.kind = 'agent'`,
        )
        .all(userId) as { id: string; title: string | null; workspace: string | null }[];
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
            ...(c.title ? { title: c.title } : {}),
            ...(c.workspace ? { workspace: c.workspace } : {}),
            // 智能体会话没有「别人发来」的概念，未读恒为 0（读状态随人类 IM 一起删除）。
            unreadCount: 0,
            lastMessageAt: lastMessageAtOf(c.id),
          });
      }
      return out;
    },
    deleteConversation(conversationId, userId) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const member = db
        .prepare("SELECT 1 FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId);
      if (!member) throw new Error("forbidden");
      // 先删消息/关联再删会话；显式事务保证中途失败不留半截会话（node:sqlite 无 transaction 助手）。
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM messages WHERE conv_id = ?").run(conversationId);
        db.prepare("DELETE FROM message_reads WHERE conv_id = ?").run(conversationId);
        db.prepare("DELETE FROM conversation_members WHERE conv_id = ?").run(conversationId);
        db.prepare("DELETE FROM conversation_agents WHERE conv_id = ?").run(conversationId);
        db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    updateConversationTitle(conversationId, userId, title) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) return false;
      const member = db
        .prepare("SELECT 1 FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId);
      if (!member) return false;
      const next = title.trim().slice(0, 80);
      db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(next || null, conversationId);
      return true;
    },
    updateConversationWorkspace(conversationId, userId, workspace) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const member = db
        .prepare("SELECT 1 FROM conversation_members WHERE conv_id = ? AND member_id = ?")
        .get(conversationId, userId);
      if (!member) return false;
      const next = (workspace ?? "").trim().slice(0, 1024);
      db.prepare("UPDATE conversations SET workspace = ? WHERE id = ?").run(next || null, conversationId);
      return true;
    },
    listWorkspaces(userId) {
      mustUser(userId);
      const rows = db
        .prepare(
          // 同一毫秒加的多个工作区要有确定顺序（否则每次刷新列表会跳）：updated_at 并列时按 path。
          "SELECT path, updated_at FROM workspaces WHERE user_id = ? ORDER BY updated_at DESC, path ASC",
        )
        .all(userId) as { path: string; updated_at: string }[];
      return rows.map((r) => ({ path: r.path, updatedAt: r.updated_at }));
    },
    addWorkspace(userId, path) {
      mustUser(userId);
      const next = path.trim().slice(0, 1024);
      if (!next) throw new Error("invalid path");
      const now = new Date().toISOString();
      // 同一路径幂等：已存在只刷新 updated_at，不报错、不改 created_at。
      db.prepare(
        `INSERT INTO workspaces (user_id, path, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, path) DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(userId, next, now, now);
      return { path: next, updatedAt: now };
    },
    removeWorkspace(userId, path) {
      mustUser(userId);
      const next = path.trim().slice(0, 1024);
      const inUse = db
        .prepare(
          `SELECT 1 FROM conversations c JOIN conversation_members m ON m.conv_id = c.id
           WHERE m.member_id = ? AND c.workspace = ? LIMIT 1`,
        )
        .get(userId, next);
      if (inUse) throw new Error("workspace in use");
      db.prepare("DELETE FROM workspaces WHERE user_id = ? AND path = ?").run(userId, next);
    },
    createAgentConversation(userId, _agentId, options = {}) {
      mustUser(userId);
      // 单智能体产品：忽略传入 agentId（旧客户端可能仍传自建 id），一律挂唯一内置智能体；
      // 构造时 ensureSystemAgentRows 已保证该行存在，此处不再做名册/属主校验。
      const row = db
        .prepare("SELECT id, owner_id, name, avatar, description FROM agents WHERE id = ?")
        .get(SYSTEM_AGENT_ID) as AgentRow | undefined;
      if (!row) throw new Error("agent not found");
      const agent = rowToAgent(row);
      // 幂等：同用户与同 agent 只留一个会话。conversation_agents 存「会话挂了哪些 agent」，
      // agent 一对一恰好只挂一个，据此反查即可，不必另建映射表。
      const title = (options.title ?? "").trim().slice(0, 80);
      const workspace = (options.workspace ?? "").trim().slice(0, 1024);
      if (!options.fresh) {
        const existing = db
          .prepare(
            `SELECT c.id FROM conversations c
             JOIN conversation_members m ON m.conv_id = c.id AND m.member_id = ?
             JOIN conversation_agents ca ON ca.conv_id = c.id AND ca.agent_id = ?
             WHERE c.kind = 'agent'`,
          )
          .get(userId, SYSTEM_AGENT_ID) as { id: string } | undefined;
        if (existing) return { id: existing.id, type: "agent", agent };
      }
      const id = randomUUID();
      db.prepare("INSERT INTO conversations (id, kind, title, workspace) VALUES (?, 'agent', ?, ?)").run(
        id,
        title || null,
        workspace || null,
      );
      db.prepare("INSERT INTO conversation_members (conv_id, member_id) VALUES (?, ?)").run(id, userId);
      db.prepare("INSERT OR IGNORE INTO conversation_agents (conv_id, agent_id) VALUES (?, ?)").run(
        id,
        SYSTEM_AGENT_ID,
      );
      return { id, type: "agent", agent };
    },
    listAgents() {
      // 单智能体产品：只读内置智能体那唯一一行。
      // 永不 SELECT system_prompt：系统提示词是部署侧内部字段，名册 API 契约不含它。
      const row = db
        .prepare("SELECT id, owner_id, name, avatar, description FROM agents WHERE id = ?")
        .get(SYSTEM_AGENT_ID) as AgentRow | undefined;
      return row ? [rowToAgent(row)] : [];
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
    detachTeamAttachment(fileId) {
      return Number(
        db
          .prepare(
            "UPDATE team_tasks SET attachment_file_id = NULL, updated_at = ? WHERE attachment_file_id = ?",
          )
          .run(new Date().toISOString(), fileId).changes,
      );
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
    listTeamCollaborators(viewerId) {
      // viewer 自己 + 与之共享至少一个工作台团队的人（跨队不串、去重）。
      // 排序放在 JS 里用与内存实现逐字相同的比较器：SQLite 的 COLLATE NOCASE 与
      // JS 的 localeCompare("zh-Hans-CN") 对中文显示名不等价，两 Store 必须同序。
      const rows = db
        .prepare(
          `SELECT DISTINCT u.id, u.username, u.display_name, u.avatar, u.last_seen_at
             FROM users u
            WHERE u.id = ?
               OR u.id IN (
                    SELECT m2.user_id
                      FROM team_members m1
                      JOIN team_members m2 ON m2.team_id = m1.team_id
                     WHERE m1.user_id = ?
                  )`,
        )
        .all(viewerId, viewerId) as Array<{
        id: string;
        username: string;
        display_name: string;
        avatar: string | null;
        last_seen_at: string | null;
      }>;
      return rows
        .map((r) => ({ user: rowToUser(r), lastSeenAt: r.last_seen_at ?? null }))
        .sort((a, b) => {
          if (a.lastSeenAt !== b.lastSeenAt) {
            if (a.lastSeenAt === null) return 1;
            if (b.lastSeenAt === null) return -1;
            return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
          }
          return a.user.displayName.localeCompare(b.user.displayName, "zh-Hans-CN");
        });
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
      if (res.changes === 0 && input.kind === "agenda") {
        // 日程档位随时间的推移会变（今天到期 → 已逾期），sourceId 稳定但展示字段要跟着刷新，
        // 否则 INSERT OR IGNORE 会把这一行永远冻结在首次上报时的档位（W2-01，内存 Store 同语义）。
        db.prepare(
          `UPDATE team_activities
              SET title = ?, detail = ?, status = ?, occurred_at = ?
            WHERE actor_id = ? AND source_id = ?`,
        ).run(
          input.title,
          input.detail ?? null,
          input.status ?? null,
          input.occurredAt,
          actorId,
          input.sourceId,
        );
      }
      return res.changes > 0;
    },
    listTeamActivities(opts = {}) {
      const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
      const where: string[] = [];
      const params: string[] = [];
      if (opts.before) {
        if (opts.beforeId) {
          // 组合游标：同 occurredAt 的剩余条目按 id 继续翻（内存 Store 同语义）
          where.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
          params.push(opts.before, opts.before, opts.beforeId);
        } else {
          where.push("occurred_at < ?");
          params.push(opts.before);
        }
      }
      if (opts.actorId) {
        where.push("actor_id = ?");
        params.push(opts.actorId);
      }
      // 可见范围进 SQL：不能先 LIMIT 再过滤，否则不可见成员的行会占掉名额。
      if (opts.actorIds) {
        if (opts.actorIds.length === 0) return [];
        where.push(`actor_id IN (${opts.actorIds.map(() => "?").join(", ")})`);
        params.push(...opts.actorIds);
      }
      const sql = `SELECT id, actor_id, kind, title, detail, status, source_id, occurred_at, created_at
                   FROM team_activities
                   ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY occurred_at DESC, id DESC
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
    countTeamActivities(actorId) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM team_activities WHERE actor_id = ?")
        .get(actorId) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    },
    clearTeamActivities(actorId) {
      return Number(db.prepare("DELETE FROM team_activities WHERE actor_id = ?").run(actorId).changes);
    },
    purgeTeamActivities(before) {
      // occurred_at 入库前已归一成 UTC ISO 毫秒形态，字典序即时间序（与内存实现同口径）。
      return Number(
        db.prepare("DELETE FROM team_activities WHERE occurred_at < ?").run(before).changes,
      );
    },
    setTeamActivityClearedAt(actorId, at) {
      mustUser(actorId);
      db.prepare(
        `INSERT INTO team_activity_clears (actor_id, cleared_at) VALUES (?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET cleared_at = excluded.cleared_at`,
      ).run(actorId, at);
    },
    getTeamActivityClearedAt(actorId) {
      const row = db
        .prepare("SELECT cleared_at FROM team_activity_clears WHERE actor_id = ?")
        .get(actorId) as { cleared_at: number } | undefined;
      return row === undefined ? null : Number(row.cleared_at);
    },
    upsertTeamUsage(actorId, input: TeamUsageInput) {
      mustUser(actorId);
      // 覆盖更新：客户端上报的是「该日该模型累计值」，不是增量（重复上报不会翻倍）。
      db.prepare(
        `INSERT INTO team_usage (actor_id, date, model, tokens, unreported, connections, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, date, model) DO UPDATE SET
           tokens = excluded.tokens,
           unreported = excluded.unreported,
           connections = excluded.connections,
           updated_at = excluded.updated_at`,
      ).run(
        actorId,
        input.date,
        input.model,
        input.tokens,
        input.unreported ?? 0,
        JSON.stringify(input.connections ?? []),
        new Date().toISOString(),
      );
    },
    listTeamUsage({ from, to, actorIds }) {
      // 可见范围进 SQL（同 listTeamActivities）：先过滤再排序，不可见成员的数据不参与聚合。
      let sql = `SELECT actor_id, date, model, tokens, unreported, connections
           FROM team_usage WHERE date >= ? AND date <= ?`;
      const params: Array<string | number> = [from, to];
      if (actorIds) {
        if (actorIds.length === 0) return [];
        sql += ` AND actor_id IN (${actorIds.map(() => "?").join(", ")})`;
        params.push(...actorIds);
      }
      sql += " ORDER BY date ASC, actor_id ASC, model ASC";
      const rows = db.prepare(sql).all(...params) as Array<{
        actor_id: string;
        date: string;
        model: string;
        tokens: number | null;
        unreported: number;
        connections: string;
      }>;
      return rows.map((r) => {
        let connections: string[] = [];
        try {
          const parsed: unknown = JSON.parse(r.connections);
          if (Array.isArray(parsed)) connections = parsed.filter((x): x is string => typeof x === "string");
        } catch {
          connections = []; // 坏数据不整段失败：连接名只是展示用
        }
        const row: TeamUsageRow = {
          actorId: r.actor_id,
          date: r.date,
          model: r.model,
          tokens: typeof r.tokens === "number" ? r.tokens : null,
          unreported: Number(r.unreported) || 0,
          connections,
        };
        return row;
      });
    },
    clearTeamUsage(actorId) {
      return Number(db.prepare("DELETE FROM team_usage WHERE actor_id = ?").run(actorId).changes);
    },
    setTeamUsageClearedAt(actorId, at) {
      mustUser(actorId);
      db.prepare(
        `INSERT INTO team_usage_clears (actor_id, cleared_at) VALUES (?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET cleared_at = excluded.cleared_at`,
      ).run(actorId, at);
    },
    getTeamUsageClearedAt(actorId) {
      const row = db
        .prepare("SELECT cleared_at FROM team_usage_clears WHERE actor_id = ?")
        .get(actorId) as { cleared_at: number } | undefined;
      return row === undefined ? null : Number(row.cleared_at);
    },
    listWorkspaceTeams(userId) {
      const rows = db
        .prepare(
          `SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id
           WHERE m.user_id = ? ORDER BY t.updated_at DESC, t.id ASC`,
        )
        .all(userId) as TeamRow[];
      return rows.map(rowToTeam);
    },
    getWorkspaceTeam(teamId, userId) {
      return visibleTeam(teamId, userId) ? snapshotOf(teamId) : null;
    },
    createWorkspaceTeam(ownerId, body) {
      const id = randomUUID();
      const at = new Date().toISOString();
      return runTx(() => {
        db.prepare(
          "INSERT INTO teams (id, name, goal, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, body.name, body.goal ?? "", ownerId, at, at);
        db.prepare(
          "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        ).run(id, ownerId, "owner", at);
        return snapshotOf(id);
      });
    },
    updateWorkspaceTeam(teamId, actorId, body) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      db.prepare("UPDATE teams SET name = ?, goal = ?, updated_at = ? WHERE id = ?").run(
        body.name ?? team.name,
        body.goal ?? team.goal,
        new Date().toISOString(),
        teamId,
      );
      return snapshotOf(teamId);
    },
    deleteWorkspaceTeam(teamId, actorId) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      // 显式级联：建表时没加外键（内存实现也无法表达），四个删除口要一起清干净。
      // 必须在事务里：断在删 teams 之前就会留下「有 team 行、没成员行」的孤儿团队。
      return runTx(() => {
        db.prepare("DELETE FROM team_tasks WHERE team_id = ?").run(teamId);
        db.prepare("DELETE FROM team_plans WHERE team_id = ?").run(teamId);
        db.prepare("DELETE FROM team_members WHERE team_id = ?").run(teamId);
        db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
        return true;
      });
    },
    addWorkspaceMember(teamId, actorId, username) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      const target = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
        | { id: string }
        | undefined;
      if (!target) return "user_not_found";
      // 先查后插之间有窗口（owner 双击 / 两个请求并发）：事务里再判一次，并把唯一约束
      // 冲突翻译成 already_member —— 否则 Express 默认 500 HTML，和内存实现语义分叉。
      try {
        return runTx(() => {
          if (teamMemberRole(teamId, target.id)) return "already_member" as const;
          db.prepare(
            "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
          ).run(teamId, target.id, "member", new Date().toISOString());
          touchTeam(teamId);
          return snapshotOf(teamId);
        });
      } catch (err) {
        if (err instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(err.message)) {
          return "already_member";
        }
        throw err;
      }
    },
    removeWorkspaceMember(teamId, actorId, targetUserId) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      if (targetUserId === team.ownerId) return "owner";
      if (!teamMemberRole(teamId, targetUserId)) return null;
      // 两条语句必须同生共死：只删成员不解绑会留下「指给非成员」的非法引用。
      return runTx(() => {
        db.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run(
          teamId,
          targetUserId,
        );
        // 被移出的人不该继续挂任务：指给他的任务解绑成「待认领」
        db.prepare(
          "UPDATE team_tasks SET assignee_id = NULL, updated_at = ? WHERE team_id = ? AND assignee_id = ?",
        ).run(new Date().toISOString(), teamId, targetUserId);
        touchTeam(teamId);
        return snapshotOf(teamId);
      });
    },
    leaveWorkspaceTeam(teamId, userId) {
      const team = visibleTeam(teamId, userId);
      if (!team) return null;
      // 团队不能无主：owner 先转让或解散，不能自己走掉把团队变成孤儿。
      if (team.ownerId === userId) return "owner";
      // 两条语句必须同生共死：只删成员不解绑会留下「指给非成员」的非法引用。
      return runTx(() => {
        db.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run(teamId, userId);
        db.prepare(
          "UPDATE team_tasks SET assignee_id = NULL, updated_at = ? WHERE team_id = ? AND assignee_id = ?",
        ).run(new Date().toISOString(), teamId, userId);
        touchTeam(teamId);
        return snapshotOf(teamId);
      });
    },
    transferTeamOwnership(teamId, actorId, targetUserId) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      if (!teamMemberRole(teamId, targetUserId)) return "not_member";
      // 三条语句必须同生共死：owner_id 改了但角色没换，会让「谁是队长」出现两个答案。
      return runTx(() => {
        const at = new Date().toISOString();
        db.prepare("UPDATE teams SET owner_id = ?, updated_at = ? WHERE id = ?").run(
          targetUserId,
          at,
          teamId,
        );
        // 先降自己再升目标：同一人时第二次写覆盖第一次，最终仍是 owner。
        db.prepare("UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?").run(
          teamId,
          actorId,
        );
        db.prepare("UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?").run(
          teamId,
          targetUserId,
        );
        return snapshotOf(teamId);
      });
    },
    createTeamPlan(teamId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      const at = new Date().toISOString();
      const count = db.prepare("SELECT COUNT(*) AS n FROM team_plans WHERE team_id = ?").get(teamId) as {
        n: number;
      };
      const id = randomUUID();
      db.prepare(
        `INSERT INTO team_plans (id, team_id, title, detail, status, order_index, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        teamId,
        body.title,
        body.detail ?? "",
        "todo",
        body.orderIndex ?? Number(count.n),
        actorId,
        at,
        at,
      );
      touchTeam(teamId);
      const row = db.prepare("SELECT * FROM team_plans WHERE id = ?").get(id) as PlanRow;
      return rowToPlan(row);
    },
    updateTeamPlan(teamId, planId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      const row = db.prepare("SELECT * FROM team_plans WHERE id = ?").get(planId) as
        | PlanRow
        | undefined;
      if (!row || row.team_id !== teamId) return "not_found";
      const current = rowToPlan(row);
      const next: TeamPlanItem = {
        ...current,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.orderIndex !== undefined ? { orderIndex: body.orderIndex } : {}),
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        "UPDATE team_plans SET title = ?, detail = ?, status = ?, order_index = ?, updated_at = ? WHERE id = ?",
      ).run(next.title, next.detail, next.status, next.orderIndex, next.updatedAt, planId);
      touchTeam(teamId);
      return next;
    },
    deleteTeamPlan(teamId, planId, actorId) {
      // 非成员与「方案不存在」同口径（都是 404），不泄露团队存在性
      if (!visibleTeam(teamId, actorId)) return "not_found";
      const row = db
        .prepare("SELECT team_id FROM team_plans WHERE id = ?")
        .get(planId) as { team_id: string } | undefined;
      if (!row || row.team_id !== teamId) return "not_found";
      // 删方案不删任务：归属它的任务解绑成独立任务；两条语句同生共死，
      // 否则只删方案会留下 plan_id 指向不存在方案的悬空引用。
      return runTx(() => {
        db.prepare("DELETE FROM team_plans WHERE id = ?").run(planId);
        db.prepare(
          "UPDATE team_tasks SET plan_id = NULL, updated_at = ? WHERE team_id = ? AND plan_id = ?",
        ).run(new Date().toISOString(), teamId, planId);
        touchTeam(teamId);
        return true;
      });
    },
    createTeamTask(teamId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      if (body.planId) {
        const plan = db.prepare("SELECT team_id FROM team_plans WHERE id = ?").get(body.planId) as
          | { team_id: string }
          | undefined;
        if (!plan || plan.team_id !== teamId) return "plan_not_found";
      }
      if (body.assigneeId && !teamMemberRole(teamId, body.assigneeId)) return "assignee_not_member";
      const id = randomUUID();
      const at = new Date().toISOString();
      db.prepare(
        `INSERT INTO team_tasks
         (id, team_id, plan_id, title, detail, assignee_id, status, created_by, created_at, updated_at, due_at, attachment_file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        teamId,
        body.planId ?? null,
        body.title,
        body.detail ?? "",
        body.assigneeId ?? null,
        "todo",
        actorId,
        at,
        at,
        body.dueAt ?? null,
        body.attachmentFileId ?? null,
      );
      touchTeam(teamId);
      const row = db.prepare("SELECT * FROM team_tasks WHERE id = ?").get(id) as TaskRow;
      return rowToTask(row);
    },
    updateTeamTask(teamId, taskId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      const row = db.prepare("SELECT * FROM team_tasks WHERE id = ?").get(taskId) as
        | TaskRow
        | undefined;
      if (!row || row.team_id !== teamId) return "not_found";
      if (body.planId) {
        const plan = db.prepare("SELECT team_id FROM team_plans WHERE id = ?").get(body.planId) as
          | { team_id: string }
          | undefined;
        if (!plan || plan.team_id !== teamId) return "plan_not_found";
      }
      if (body.assigneeId && !teamMemberRole(teamId, body.assigneeId)) return "assignee_not_member";
      const next: TeamTask = {
        ...rowToTask(row),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        ...(body.planId !== undefined ? { planId: body.planId } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
        ...(body.attachmentFileId !== undefined
          ? { attachmentFileId: body.attachmentFileId }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        `UPDATE team_tasks SET plan_id = ?, title = ?, detail = ?, assignee_id = ?, status = ?,
           due_at = ?, attachment_file_id = ?, updated_at = ? WHERE id = ?`,
      ).run(
        next.planId,
        next.title,
        next.detail,
        next.assigneeId,
        next.status,
        next.dueAt,
        next.attachmentFileId,
        next.updatedAt,
        taskId,
      );
      touchTeam(teamId);
      return next;
    },
    deleteTeamTask(teamId, taskId, actorId) {
      if (!visibleTeam(teamId, actorId)) return "not_found";
      const row = db
        .prepare("SELECT team_id FROM team_tasks WHERE id = ?")
        .get(taskId) as { team_id: string } | undefined;
      if (!row || row.team_id !== teamId) return "not_found";
      db.prepare("DELETE FROM team_tasks WHERE id = ?").run(taskId);
      touchTeam(teamId);
      return true;
    },
    ensureSystemAgents() {
      // 幂等：登记唯一内置智能体 + 迁移旧自建智能体数据（构造时已跑过一次）。
      ensureSystemAgentRows();
    },
  };
}
