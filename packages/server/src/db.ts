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
    -- 登录会话：token 只存 SHA-256 摘要，原文不落库。
    -- 与 users 同库持久化，服务重启/发版不会把已登录设备踢回登录页。
    -- expires_at 是毫秒时间戳；NULL = 本列引入前的老会话（视为不过期，避免升级即踢下线）。
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, created_by TEXT
    );
    -- 工作区：用户手工加进左栏的本机文件夹，只做会话分组用（d.147.4.91.11）。
    CREATE TABLE IF NOT EXISTS workspaces (
      user_id TEXT NOT NULL, path TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, path)
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conv_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (conv_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL,
      payload TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL, recalled_at TEXT,
      enc TEXT NOT NULL DEFAULT 'plain', cipher TEXT, chain_kid TEXT, n INTEGER
    );
    -- d.197：会话内容搜索按 conv_id 扫最近若干条；没有这条索引时每个会话都要全表扫。
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conv_id, created_at);
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
    -- d.412.4.181：旧的 idx_messages_conv 与上面的 idx_messages_conversation 完全重复，
    -- 已删除建表语句，并在下方迁移里 DROP 老库残留（SQLite 查询不按索引名引用，安全）。
    -- d.54 团队系统：动向摘要（不是消息，不含正文/提示词/工具参数）。
    -- source_id 是客户端确定性幂等键，(actor_id, source_id) 唯一。
    CREATE TABLE IF NOT EXISTS team_activities (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, detail TEXT, status TEXT, source_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (actor_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_activities_at ON team_activities(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_team_activities_actor ON team_activities(actor_id, occurred_at DESC);
    -- ②-3 团队用量：按 (actor_id, date, model) 唯一聚合。
    -- 只存数字与名称（模型名/用户自命名的连接名），**不存**提示词、正文、工具参数或结果；
    -- tokens 允许 NULL：供应商一次都没上报时，「未上报」与「用了 0」必须能区分（d.32）。
    CREATE TABLE IF NOT EXISTS team_usage (
      actor_id TEXT NOT NULL, date TEXT NOT NULL, model TEXT NOT NULL,
      tokens INTEGER, unreported INTEGER NOT NULL DEFAULT 0,
      connections TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
      PRIMARY KEY (actor_id, date, model)
    );
    CREATE INDEX IF NOT EXISTS idx_team_usage_date ON team_usage(date);
    -- ②-3 用量清除的服务端水位：记录「这个人最后一次清除本人用量」的时刻（毫秒）。
    -- 客户端本地也有一份 usageClearedAt（多设备/清 localStorage 就没了），这份是服务端的权威粗判：
    -- 清除之后另一台设备把旧日数据重新上传时，POST 会丢弃 date < 清除日 的条目，
    -- 否则「清除」在另一台设备上等于没做（数据被原样传回，人又出现在排行里）。
    CREATE TABLE IF NOT EXISTS team_usage_clears (
      actor_id TEXT PRIMARY KEY,
      cleared_at INTEGER NOT NULL
    );
    -- ②-3 动向清除的服务端水位（T2-03）：与 team_usage_clears 同构。
    -- 「清除共享记录」以前只在执行清除的那台设备成立：本地 activitiesClearedAt 一丢
    --（换设备/清缓存），下一次 sync 就用同样的 sourceId 把已撤回的摘要原样传回来。
    -- 服务端记下清除时刻后，POST 丢弃 occurredAt <= cleared_at 的条目，撤回才对所有设备生效。
    CREATE TABLE IF NOT EXISTS team_activity_clears (
      actor_id TEXT PRIMARY KEY,
      cleared_at INTEGER NOT NULL
    );
  `);
  /*
   * d.236 会话内容搜索 FTS5 索引。
   *
   * 为什么用 trigram：中文没有空格分词，unicode61 会把整句当一个 token，搜「全部通过」
   * 命中不了「32 条全部通过」。trigram 按 3 字符滑窗建索引，天然支持任意子串命中
   * （含中文、英文、标点）；查询 <3 字符时由上层回退线性扫描。
   *
   * rowid 与 messages.rowid 一一对应：写入/删除都按 rowid 同步，避免对 JSON 文本
   * 建触发器（payload 是 JSON，json_extract 在触发器里既不透明也难测）。
   * 建表失败（SQLite 未编入 FTS5 / 无 trigram 分词器）不是启动错误：上层检测不到
   * messages_fts 就回退既有扫描，只记一次日志。
   */
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        conv_id UNINDEXED,
        text,
        tokenize = 'trigram'
      );
    `);
  } catch (err) {
    console.warn(
      "[db] FTS5 全文索引不可用，消息搜索回退线性扫描：",
      (err as Error).message,
    );
  }
  /*
   * 团队知识库全文索引：与 messages_fts 同款 trigram（中文子串命中）。
   * 同步走应用层（写/删文档时显式 INSERT/DELETE），不建触发器，与既有风格一致。
   * rowid 与 team_knowledge_docs.rowid 一一对应；建表失败只记日志、查询回退线性扫描。
   */
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS team_knowledge_fts USING fts5(
        doc_id UNINDEXED,
        team_id UNINDEXED,
        title,
        content,
        tokenize = 'trigram'
      );
    `);
  } catch (err) {
    console.warn(
      "[db] FTS5 全文索引不可用，团队知识库搜索回退线性扫描：",
      (err as Error).message,
    );
  }
  /*
   * d.92 团队工作台：用户自建团队 / 方案 / 任务（与上面的「全站单团队」两层东西）。
   *
   * 不建外键：级联删除在 Store 里显式做（四个删除口都要在事务里清干净），
   * 这样内存实现与 SQLite 实现的行为是同一份契约、同一批测试双跑。
   * order_index 是方案排序值（小的在前，同值按 created_at），任务按 created_at 正序。
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS team_plans (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      plan_id TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      assignee_id TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      due_at TEXT,
      attachment_file_id TEXT,
      result TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      completed_by TEXT,
      blocked_by TEXT NOT NULL DEFAULT '[]',
      return_note TEXT NOT NULL DEFAULT '',
      returned_at TEXT,
      returned_by TEXT,
      progress TEXT NOT NULL DEFAULT '',
      progress_at TEXT,
      progress_by TEXT,
      nudged_at TEXT,
      nudged_by TEXT,
      nudge_count INTEGER NOT NULL DEFAULT 0,
      review_state TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT,
      reviewed_by TEXT
    );
  CREATE TABLE IF NOT EXISTS team_task_comments (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_team_task_comments_task ON team_task_comments(task_id, created_at);

  CREATE TABLE IF NOT EXISTS team_events (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    task_id TEXT,
    task_title TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_team_events_team ON team_events(team_id, created_at);

  /* 团队知识库文档：用户显式发布的摘要/文档，按 team_id 硬隔离，不建外键。 */
  CREATE TABLE IF NOT EXISTS team_knowledge_docs (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    source_vault TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_team_knowledge_team ON team_knowledge_docs(team_id, pinned DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_team_knowledge_author ON team_knowledge_docs(author_id);
    /* 加入申请：用户搜索团队后申请加入，队长审批。
   * 不建 UNIQUE：被拒/撤回后允许重新申请（新 id）；重复 pending 由 Store 显式查重拦截，
   * 与内存实现同口径。索引覆盖「队的申请列表」与「我的申请」。 */
  CREATE TABLE IF NOT EXISTS team_join_requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_team_join_requests_team ON team_join_requests(team_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_team_join_requests_user ON team_join_requests(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id, team_id);
    CREATE INDEX IF NOT EXISTS idx_teams_updated ON teams(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_team_plans_team ON team_plans(team_id, order_index, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_tasks_team ON team_tasks(team_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_tasks_plan ON team_tasks(plan_id);
  `);
  // 幂等列迁移：生产库已有无 recalled_at 列的 messages 表（CREATE IF NOT EXISTS 不会补列）；
  // E2E Task 2 同模式补 enc/cipher/chain_kid/n（enc 带非空默认值，SQLite ALTER 允许常量默认）。
  // d.412.4.181：DROP 老库里与 idx_messages_conversation 重复的 idx_messages_conv（迁移幂等）。
  db.exec("DROP INDEX IF EXISTS idx_messages_conv");
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

  // 会话过期时间（d.236）：旧库的 sessions 表没有该列，幂等补上。
  // 老行 expires_at 保持 NULL = 不过期——升级那一刻不能把所有已登录设备踢下线。
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionCols.some((c) => c.name === "expires_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");
  }

  // d.128：会话标题（Claude Code 式「按会话名找」；旧库无该列 → 幂等补）。
  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!convCols.some((c) => c.name === "title")) {
    db.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
  }
  // d.147.4.91.11：会话归属的工作区路径（= 本机文件夹，仅用于左栏分组；NULL = 未分组）。
  if (!convCols.some((c) => c.name === "workspace")) {
    db.exec("ALTER TABLE conversations ADD COLUMN workspace TEXT");
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

  // d.54 团队：最近活跃时间。登录/WS 连接时刷新，不参与鉴权。
  const userCols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === "last_seen_at")) {
    db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
  }

  // d.252：任务交付结论与完成留痕。旧库没有这三列 → 幂等补上（读侧另有 ?? 兜底）。
  const taskCols = db.prepare("PRAGMA table_info(team_tasks)").all() as Array<{ name: string }>;
  // d.268：任务优先级。旧库补列，缺省 normal（内存库同口径）。
  if (!taskCols.some((c) => c.name === "priority")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
  }
  if (!taskCols.some((c) => c.name === "result")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN result TEXT NOT NULL DEFAULT ''");
  }
  if (!taskCols.some((c) => c.name === "completed_at")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN completed_at TEXT");
  }
  if (!taskCols.some((c) => c.name === "completed_by")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN completed_by TEXT");
  }
  // d.255：任务依赖（前置任务 id 的 JSON 数组）。旧库补列，缺省空数组＝没有依赖。
  if (!taskCols.some((c) => c.name === "blocked_by")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'");
  }
  // d.261：退回原因与退回痕迹。旧库补列，缺省空串/null＝没被退回过。
  if (!taskCols.some((c) => c.name === "return_note")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN return_note TEXT NOT NULL DEFAULT ''");
  }
  if (!taskCols.some((c) => c.name === "returned_at")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN returned_at TEXT");
  }
  if (!taskCols.some((c) => c.name === "returned_by")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN returned_by TEXT");
  }
  // d.262：任务进展（做到哪、卡在哪）。旧库补列，缺省空串/null＝还没留过。
  if (!taskCols.some((c) => c.name === "progress")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN progress TEXT NOT NULL DEFAULT ''");
  }
  if (!taskCols.some((c) => c.name === "progress_at")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN progress_at TEXT");
  }
  if (!taskCols.some((c) => c.name === "progress_by")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN progress_by TEXT");
  }
  // 催办（d.265）：独立判断，别埋在 progress_by 的分支里（否则已有 progress_by 的库永远补不上）。
  if (!taskCols.some((c) => c.name === "nudged_at")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN nudged_at TEXT");
  }
  if (!taskCols.some((c) => c.name === "nudged_by")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN nudged_by TEXT");
  }
  if (!taskCols.some((c) => c.name === "nudge_count")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0");
  }
  // 验收（d.272）：逐列独立判断，已有列的库不重复加。
  if (!taskCols.some((c) => c.name === "review_state")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN review_state TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!taskCols.some((c) => c.name === "review_note")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN review_note TEXT NOT NULL DEFAULT ''");
  }
  if (!taskCols.some((c) => c.name === "reviewed_at")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN reviewed_at TEXT");
  }
  if (!taskCols.some((c) => c.name === "reviewed_by")) {
    db.exec("ALTER TABLE team_tasks ADD COLUMN reviewed_by TEXT");
  }

  // T2-02：写侧直到 d.109 才把 task 动向的 title 钉成「任务」，**收紧前入库的历史行**
  // 仍存着用户提问首行（≤60 字，配合 detail/occurredAt 能还原「谁什么时候问了什么」）。
  // 这里一次性、幂等地清掉存量；读侧另有强制投影兜底（旧库恢复/第三方导入也能挡住）。
  // 单条 UPDATE 自身原子，不需要事务。
  db.exec("UPDATE team_activities SET title = '任务' WHERE kind = 'task' AND title <> '任务'");
}
