#!/usr/bin/env node
/**
 * d.54 迁移脚本：清掉人类 IM 的会话数据，保留账号、好友关系与 AI 会话。
 *
 * 代码本身不删任何数据；是否清理由运维显式决定：
 *   node scripts/purge-im-data.mjs --db <path>          # dry-run：只打印将删除的行数
 *   node scripts/purge-im-data.mjs --db <path> --yes    # 执行（先备份 heming.db！）
 *
 * 删除范围（严格限定在 kind != 'agent' 的会话上）：
 *   conversations / conversation_members / messages / message_reads / conversation_agents
 * 不碰：users、friend_requests、agents、shared_files、e2e_keys、team_activities。
 *
 * 服务端只读取 kind='agent' 的会话，所以旧行留着也不会出现；
 * 但数据库里仍可能残留聊天正文，需要的话用本脚本一次清干净。
 * 回滚只能靠备份：清理前请先停服并复制 <db>（及其 -wal/-shm）到备份目录。
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function usage(code = 0) {
  const text = `用法：
  node scripts/purge-im-data.mjs --db <path>          # dry-run，只统计
  node scripts/purge-im-data.mjs --db <path> --yes    # 真正删除（务必先备份）`;
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

const argv = process.argv.slice(2);
let dbPath = "";
let confirmed = false;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--db") {
    dbPath = argv[i + 1] ?? "";
    i += 1;
  } else if (arg.startsWith("--db=")) {
    dbPath = arg.slice("--db=".length);
  } else if (arg === "--yes") {
    confirmed = true;
  } else if (arg === "-h" || arg === "--help") {
    usage(0);
  } else {
    console.error(`未知参数：${arg}`);
    usage(2);
  }
}

if (!dbPath) {
  console.error("缺少 --db <path>");
  usage(2);
}
if (!existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: !confirmed });

/** 老库可能没有某张表（例如从未建过群）；缺表时按 0 行处理。 */
function tableExists(name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

const OLD_CONVS = "SELECT id FROM conversations WHERE kind <> 'agent'";
const tables = ["conversations", "conversation_members", "messages", "message_reads", "conversation_agents"];
for (const table of tables) {
  if (!tableExists(table)) {
    console.error(`数据库缺表 ${table}，不像和鸣的 heming.db：${dbPath}`);
    process.exit(2);
  }
}

const counts = {
  conversations: db.prepare(`SELECT COUNT(*) AS n FROM (${OLD_CONVS})`).get().n,
  conversation_members: db
    .prepare(`SELECT COUNT(*) AS n FROM conversation_members WHERE conv_id IN (${OLD_CONVS})`)
    .get().n,
  messages: db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conv_id IN (${OLD_CONVS})`)
    .get().n,
  message_reads: db
    .prepare(`SELECT COUNT(*) AS n FROM message_reads WHERE conv_id IN (${OLD_CONVS})`)
    .get().n,
  conversation_agents: db
    .prepare(`SELECT COUNT(*) AS n FROM conversation_agents WHERE conv_id IN (${OLD_CONVS})`)
    .get().n,
};

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
console.log(`数据库：${dbPath}`);
console.log("将删除（kind != 'agent' 的会话及其附属行）：");
for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(20)} ${n}`);
console.log(`  合计                 ${total}`);

const kept = {
  users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
  friend_requests: tableExists("friend_requests")
    ? db.prepare("SELECT COUNT(*) AS n FROM friend_requests").get().n
    : 0,
  agents: db.prepare("SELECT COUNT(*) AS n FROM agents").get().n,
  agent_conversations: db
    .prepare("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'agent'")
    .get().n,
};
console.log("保留：");
for (const [name, n] of Object.entries(kept)) console.log(`  ${name.padEnd(20)} ${n}`);

db.close();

if (!confirmed) {
  console.log("\ndry-run：未改动数据库。确认已备份后加 --yes 执行。");
  process.exit(0);
}

if (total === 0) {
  console.log("\n没有需要清理的行。");
  process.exit(0);
}

// 重新以可写模式打开（dry-run 用的是只读连接）
const writer = new DatabaseSync(dbPath);
try {
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare(`DELETE FROM messages WHERE conv_id IN (${OLD_CONVS})`).run();
  writer.prepare(`DELETE FROM message_reads WHERE conv_id IN (${OLD_CONVS})`).run();
  writer.prepare(`DELETE FROM conversation_members WHERE conv_id IN (${OLD_CONVS})`).run();
  writer.prepare(`DELETE FROM conversation_agents WHERE conv_id IN (${OLD_CONVS})`).run();
  const deletedConvs = writer
    .prepare("DELETE FROM conversations WHERE kind <> 'agent'")
    .run().changes;
  writer.exec("COMMIT");
  writer.exec("PRAGMA optimize");
  console.log(`\n已清理 ${total} 行（会话 ${deletedConvs} 条）。`);
} catch (err) {
  try {
    writer.exec("ROLLBACK");
  } catch {
    /* 事务可能尚未开始 */
  }
  console.error(`清理失败，已回滚：${err instanceof Error ? err.message : String(err)}`);
  writer.close();
  process.exit(1);
}
writer.close();
