import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// node:sqlite 只能按带 node: 前缀的名字加载（Node 24 的 builtinModules 亦只收录 "node:sqlite"）。
// 静态 import "node:sqlite" 会被 vite-node(vitest 1.6) 的 normalizeModuleId 剥掉前缀后按
// "sqlite" 原生加载而失败（ERR_MODULE_NOT_FOUND），故统一经 createRequire 原生加载。
// 类型仍走 @types/node 的 node:sqlite 声明；运行时（vitest worker 与 dist）行为一致。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function resolveDbPath(): string {
  return process.env.HEMING_DB_PATH?.trim() || "./data/heming.db";
}

export function openDb(dbPath: string): DatabaseSyncType {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  return db;
}

export function initSchema(db: DatabaseSyncType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL, avatar TEXT
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conv_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (conv_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL,
      payload TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL, recalled_at TEXT,
      enc TEXT NOT NULL DEFAULT 'plain', cipher TEXT, chain_kid TEXT, n INTEGER
    );
    CREATE TABLE IF NOT EXISTS message_reads (
      conv_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at TEXT NOT NULL,
      PRIMARY KEY (conv_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, owner_id TEXT, name TEXT NOT NULL, avatar TEXT,
      description TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS conversation_agents (
      conv_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (conv_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS shared_files (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, updated_at TEXT NOT NULL, content_base64 TEXT NOT NULL
    );
    -- E2E 设备公钥（Task 2）：每用户多设备，按 (user_id, ik_ecdh) upsert（ikEcdh=设备身份指纹）
    CREATE TABLE IF NOT EXISTS e2e_keys (
      user_id TEXT NOT NULL, ik_ecdh TEXT NOT NULL, ik_sign TEXT NOT NULL,
      spk_pub TEXT NOT NULL, spk_sig TEXT NOT NULL, spk_created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, ik_ecdh)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at);
  `);
  // 幂等列迁移：生产库已有无 recalled_at 列的 messages 表（CREATE IF NOT EXISTS 不会补列）；
  // E2E Task 2 同模式补 enc/cipher/chain_kid/n（enc 带非空默认值，SQLite ALTER 允许常量默认）。
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "recalled_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN recalled_at TEXT");
  }
  if (!cols.some((c) => c.name === "enc")) {
    db.exec("ALTER TABLE messages ADD COLUMN enc TEXT NOT NULL DEFAULT 'plain'");
  }
  if (!cols.some((c) => c.name === "cipher")) {
    db.exec("ALTER TABLE messages ADD COLUMN cipher TEXT");
  }
  if (!cols.some((c) => c.name === "chain_kid")) {
    db.exec("ALTER TABLE messages ADD COLUMN chain_kid TEXT");
  }
  if (!cols.some((c) => c.name === "n")) {
    db.exec("ALTER TABLE messages ADD COLUMN n INTEGER");
  }

  // 归档：**按成员存**而不是按会话存。
  // 群聊里 A 归档了不该影响 B——归档是「我不想再在列表里看到它」，
  // 属于个人视图偏好，跟会话本身的状态无关。
  // 存成 conversations 的列会让全群一起被归档，那是错的。
  const memberCols = db.prepare("PRAGMA table_info(conversation_members)").all() as Array<{
    name: string;
  }>;
  if (!memberCols.some((c) => c.name === "archived_at")) {
    db.exec("ALTER TABLE conversation_members ADD COLUMN archived_at TEXT");
  }
}
