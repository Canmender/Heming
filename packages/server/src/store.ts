import { randomUUID } from "node:crypto";
import { SYSTEM_AGENT, SYSTEM_AGENT_ID } from "@heming/shared";
import { summarizeTeamTasks } from "./teamCounts.js";
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
  TeamTaskPriority,
  TeamMemberRole,
  TeamPlanItem,
  TeamTask,
  TeamTaskComment,
  TeamEvent,
  TeamWorkspaceSnapshot,
  TeamBrief,
  WorkspaceTeam,
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

/* ───────────────────────── d.92 团队工作台：入参与返回值 ───────────────────────── */

/** 建团队入参（schema 已校验；Store 只做语义，不重复校验长度）。 */
export interface WorkspaceTeamCreateInput {
  name: string;
  goal?: string;
}

/** 改团队入参：只带要改的字段。 */
export interface WorkspaceTeamUpdateInput {
  name?: string;
  goal?: string;
}

export interface TeamPlanCreateInput {
  title: string;
  detail?: string;
  orderIndex?: number;
}

export interface TeamPlanUpdateInput {
  title?: string;
  detail?: string;
  status?: TeamItemStatus;
  orderIndex?: number;
}

export interface TeamTaskCreateInput {
  title: string;
  detail?: string;
  planId?: string | null;
  assigneeId?: string | null;
  dueAt?: string | null;
  attachmentFileId?: string | null;
  /** 优先级（d.268）：不填 = 普通。 */
  priority?: TeamTaskPriority;
  /** 前置任务 id（d.255）：同团队任务，最多 5 个，不能成环。 */
  blockedBy?: string[];
}

export interface TeamTaskUpdateInput {
  title?: string;
  detail?: string;
  planId?: string | null;
  assigneeId?: string | null;
  status?: TeamItemStatus;
  /** 优先级（d.268）：调整轻重缓急。 */
  priority?: TeamTaskPriority;
  dueAt?: string | null;
  attachmentFileId?: string | null;
  /** 交付结论（d.252）：完成时写「做成什么样、怎么验证的」；不要拿它覆盖 detail。 */
  result?: string;
  /** 前置任务 id（d.255）：整体替换；空数组 = 清空依赖。 */
  blockedBy?: string[];
  /** 退回原因（d.261）：assigneeId 传 null 时一起落库，说明为什么做不了。 */
  returnNote?: string;
  /** 最新进展（d.262）：空串 = 清空。 */
  progress?: string;
  /** 催办（d.265）：true = 记一次催办；只能催别人名下、还没完成的任务。 */
  nudge?: boolean;
  /** 验收（d.272）：approve = 通过；changes = 打回重做（必须带 reviewNote）。 */
  review?: "approve" | "changes";
  /** 验收意见（d.272）：打回时说明要改什么；通过时可留一句认可。 */
  reviewNote?: string;
}

/**
 * 系统预设 agent 元数据单一真源：内存注册表与 sqlite agents 表 upsert 共用。
 * 产品决策（单智能体）：全产品唯一内置智能体，元数据从 shared 的 SYSTEM_AGENT 派生，
 * 不再另立字面量；systemPrompt 是部署侧内部字段（sqlite 落 system_prompt 列，永不进 API）。
 */
export const SYSTEM_AGENTS: Record<
  string,
  { name: string; avatar: string | null; description: string; systemPrompt: string }
> = {
  [SYSTEM_AGENT_ID]: {
    name: SYSTEM_AGENT.name,
    avatar: SYSTEM_AGENT.avatar ?? null,
    description: SYSTEM_AGENT.description,
    // 系统提示词是服务端部署侧字段：当前版本为空串（客户端本地提示词不落库）。
    systemPrompt: "",
  },
};

/** 消息全文检索的一条候选（正文原样返回，片段裁剪由 app 层统一做，两实现同一口径）。 */
export interface MessageSearchHit {
  conversationId: string;
  messageId: string;
  senderType: string;
  createdAt: string;
  text: string;
}

/** 消息全文检索结果；`scanned` 是索引候选行数（与线性扫描的「扫过多少条消息」同义）。 */
export interface MessageSearchResult {
  hits: MessageSearchHit[];
  truncated: boolean;
  scanned: number;
}

export interface MessageSearchOptions {
  /** 只在这些会话里搜（调用方已按成员关系与最近活跃收口）；顺序决定命中排序。 */
  conversationIds: string[];
  limit: number;
  /** 最多检查多少条索引候选（对应旧实现的扫描上限，防止极端查询拖住单线程事件循环）。 */
  maxScanned: number;
}

export interface Store {
  createUser(username: string, passwordHash: string, displayName: string): User;
  findUserByUsername(username: string): { user: User; passwordHash: string } | null;
  findUserById(id: string): User | null;
  /**
   * 登录会话：只存 token 的 SHA-256 摘要（原文不落库）。
   * 会话与用户数据同库持久化，服务重启后已登录设备无需重新登录。
   *
   * `expiresAt` 是毫秒时间戳。旧版本升级上来的会话行没有过期时间（null）= 永不过期：
   * 升级不能把已经登录的设备全部踢回登录页（那是比「安全」更糟的可用性事故）。
   */
  addSession(tokenDigest: string, userId: string, expiresAt?: number | null): void;
  /** 按 token 摘要取 userId；不存在或已过期返回 null（过期行顺手删除，避免越积越多）。 */
  sessionUserId(tokenDigest: string): string | null;
  /** 吊销单个会话（登出 / 刷新换票）；存在并删除返回 true。 */
  deleteSession(tokenDigest: string): boolean;
  /** 吊销某用户全部会话（所有设备），返回实际吊销数量。 */
  deleteUserSessions(userId: string): number;
  /** avatar 省略时保留原值。返回新 User 对象（见 createMemoryStore 内注释）。 */
  updateProfile(userId: string, patch: { displayName: string; avatar?: string }): User;
  /**
   * 建智能体一对一会话（幂等，已存在则返回原会话 id）。
   * 产品只有唯一内置智能体：`agentId` 参数仅为旧客户端兼容而保留——**忽略传入值**，
   * 一律挂 `SYSTEM_AGENT_ID`（旧版自建 agent id 静默归一，不报错）。
   */
  createAgentConversation(
    userId: string,
    agentId: string,
    options?: { fresh?: boolean; title?: string; workspace?: string },
  ): { id: string; type: "agent"; agent: Agent };
  listConversations(userId: string): Conversation[];
  /** 改会话标题（空串 = 清除）；调用者需先确认成员身份。返回是否落库。 */
  updateConversationTitle(conversationId: string, userId: string, title: string): boolean;
  /**
   * 把会话挪到工作区（d.147.4.91.11）：`null`/空串 = 未分组。
   * 只改归属，不校验路径是否真实存在（目录可能已被删/移走，那是本机的事）。
   * 调用者需先确认成员身份；非成员返回 false，不存在抛 conversation not found。
   */
  updateConversationWorkspace(
    conversationId: string,
    userId: string,
    workspace: string | null,
  ): boolean;
  /** 左栏工作区清单（不含「未分组」，那是隐式组）；按 updated_at 倒序。 */
  listWorkspaces(userId: string): Workspace[];
  /** 加工作区（同路径幂等，只刷新 updated_at）。 */
  addWorkspace(userId: string, path: string): Workspace;
  /**
   * 删工作区（不删会话）：还有会话挂在该路径下 → 抛 `workspace in use`。
   * 删后会话仍留在左栏，只是重新落回「未分组」——调用方无需逐条搬迁。
   */
  removeWorkspace(userId: string, path: string): void;
  /** 删除整段会话（消息一并删）；非成员 forbidden、不存在 conversation not found。 */
  deleteConversation(conversationId: string, userId: string): void;
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
   * 按 id 删掉这段会话里的消息（d.291，`/rewind` 的对话那一半），返回真正删掉的条数。
   *
   * 口径：只认属于这个会话的 id——别的会话的 id、已经删掉的 id 一律静默忽略，
   * 所以同一个请求重复发是幂等的（客户端重试不会删多）。会话不存在 → conversation not found。
   */
  deleteMessages(conversationId: string, ids: string[]): number;
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
   * 消息正文全文检索（可选能力）：SQLite 实现走 FTS5；内存实现没有索引，返回 null
   * 让调用方回退既有的线性扫描。返回 null 也用于「查询 <3 字符 / FTS 不可用」——
   * 调用方只需判断「有没有加速通道」，不需要知道原因。
   */
  searchMessages(query: string, options: MessageSearchOptions): MessageSearchResult | null;
  /**
   * 登记本人设备公钥（E2E Task 2）：按 (userId, ikEcdh) upsert——同设备再登记覆盖
   * （SPK 轮换），新 ikEcdh 追加设备。userId 恒来自登录态，不做用户存在性校验。
   */
  upsertE2eDevice(userId: string, device: E2eDeviceKeys): void;
  /** 全部已登记设备公钥 { [userId]: devices[] }（GET /api/e2e/keys，登录可读）。 */
  listE2eKeys(): Record<string, E2eDeviceKeys[]>;
  /**
   * 智能体名册：恒为唯一内置智能体（`SYSTEM_AGENT_ID`）的单元素数组。
   * 返回结构不含 system_prompt（部署边界：系统提示词永不进 API）。
   */
  listAgents(): Agent[];
  // —— M4 共享文件（app.ts 内存 Map 迁入 Store 的持久化契约，双实现同语义）——
  /** 落库一个共享文件（元数据 + base64 内容），返回入参 meta。 */
  addFile(meta: SharedFileMeta, contentBase64: string): SharedFileMeta;
  /** 取文件（元数据 + base64 内容）；不存在返回 null。 */
  getFile(id: string): { meta: SharedFileMeta; contentBase64: string } | null;
  /** 全部共享文件元数据，按 updatedAt 降序。 */
  listFiles(): SharedFileMeta[];
  /** 删除文件；存在并删除成功 true，不存在 false。 */
  deleteFile(id: string): boolean;
  /**
   * 把团队任务的交付物引用摘成 NULL（删共享文件时调用），返回受影响任务数。
   *
   * 不摘就会留下指向已删文件的 `attachment_file_id`：任务卡上的「交付物」永远 404，
   * 而任务本身没有「换附件」入口，用户只能删任务重派。
   */
  detachTeamAttachment(fileId: string): number;
  /** 某用户全部共享文件字节数（size 求和，配额用）。 */
  userFileBytes(ownerUsername: string): number;
  // —— d.54 团队系统：在线活跃与动向（单团队，全站用户即成员）——
  /** 刷新用户最近活跃时间；用户不存在时静默忽略（登录态已保证存在）。 */
  touchUser(userId: string): void;
  /** 全站名册（用户 + 最近活跃）；在线态由调用方叠加，不落库。
   *
   * @deprecated d.54 的「全站一个团队」口径已废弃：名册/动向/用量只在**同队成员**之间可见。
   * 这里保留接口只为兼容既有 Store 契约测试与可能的运维脚本；业务路由请用
   * `listTeamCollaborators(viewerId)`（不再有「陌生注册用户」这层泄漏面）。
   */
  listTeamMembers(): { user: User; lastSeenAt: string | null }[];
  /**
   * 可见名册：viewer 自己 + 与 viewer 至少同属一个工作台团队的成员（去重）。
   *
   * 没有加入任何团队时只返回自己——「还没建团队就看见别的注册用户」正是要修的口径。
   * 排序与 `listTeamMembers` 一致：`lastSeenAt` 倒序、null 排最后、同值按
   * `displayName.localeCompare("zh-Hans-CN")`；在线态仍由 app 层叠加。
   */
  listTeamCollaborators(viewerId: string): { user: User; lastSeenAt: string | null }[];
  /**
   * 写入一条动向摘要。按 (actorId, sourceId) 幂等：
   * 已存在返回 false（skipped），新写入返回 true（inserted）。
   */
  addTeamActivity(actorId: string, input: TeamActivityInput): boolean;
  /**
   * 动向流：排序固定 `occurredAt DESC, id DESC`（两 Store 同语义，同刻用 id 兜底保证确定性）。
   * `before` 为游标时间（严格小于）；给了 `beforeId` 时比较 `(occurredAt, id) < (before, beforeId)`，
   * 使同一时间戳的剩余条目也能翻到（旧客户端只传 `before` = 旧语义）。
   * `actorId` 可过滤；`actorIds` 可把范围限定成「可见成员集合」——它必须参与查询/内存过滤，
   * 不能先按 limit 取一批再过滤（否则同队成员的最新动向会被陌生人的行占掉名额）。
   */
  listTeamActivities(opts?: {
    limit?: number;
    before?: string;
    beforeId?: string;
    actorId?: string;
    actorIds?: string[];
  }): TeamActivity[];
  /** 清空某位成员已上传的动向，返回删除条数。 */
  clearTeamActivities(actorId: string): number;
  /** 某位成员已存的动向条数（写侧上限护栏用；不是分页查询）。 */
  countTeamActivities(actorId: string): number;
  /**
   * 记录「本人最后一次清除动向」的时刻（毫秒），与 `setTeamUsageClearedAt` 同构。
   *
   * 客户端本地也有 `activitiesClearedAt`，但换设备/清 localStorage 就没了；
   * 服务端这份是权威那份：POST 丢弃 `occurredAt <= 清除时刻` 的条目，撤回才对所有设备生效。
   */
  setTeamActivityClearedAt(actorId: string, at: number): void;
  /** 动向清除水位；从未清除过返回 null（不是 0——0 会被当成「1970 年清过一次」）。 */
  getTeamActivityClearedAt(actorId: string): number | null;
  /**
   * 删掉 `occurredAt` 严格小于 `before` 的动向，返回删除条数（保留期清理用）。
   *
   * `occurredAt` 入库前已归一成 UTC ISO 毫秒形态，所以字符串比较就是时间比较；
   * 两实现同语义。默认不启用（只有设了 `HEMING_TEAM_ACTIVITY_RETENTION_DAYS` 才会被调用）。
   */
  purgeTeamActivities(before: string): number;
  // —— ②-3 团队用量：白名单摘要的服务端聚合 ——
  /**
   * 幂等写入一天的聚合用量：同一 `(actorId, date, model)` **覆盖更新**。
   *
   * 客户端上报的是「该日该模型的累计值」，不是增量——所以重复上报同一份数据不会翻倍，
   * 补报/修正也只覆盖那一格。用户不存在时抛 "user not found"（与动向同口径）。
   */
  upsertTeamUsage(actorId: string, input: TeamUsageInput): void;
  /**
   * 区间（自然日闭区间）内全部成员的用量行；排行/本人明细由调用方聚合。
   * `actorIds` 可把范围限定成「可见成员集合」（过滤在查询阶段完成）。
   */
  listTeamUsage(opts: { from: string; to: string; actorIds?: string[] }): TeamUsageRow[];
  /**
   * 删除某位成员已上传的全部用量行，返回删除条数。
   *
   * 关闭共享只停「未来上传」，旧行还留在服务端、人仍出现在排行里——那不是隐私口径。
   * 所以清除必须是一个显式动作（对称团队动向的 `clearTeamActivities`）。
   */
  clearTeamUsage(actorId: string): number;
  /**
   * 记录「该成员最后一次清除本人用量」的时刻（毫秒时间戳）。
   *
   * 为什么服务端也要存：客户端水位只在 localStorage（换设备 / 清缓存就没了），
   * 另一台设备下一轮轮询会把 30 天数据原样传回来，等于没删。这份是权威粗判——
   * 上传侧按 `date < dayKeyUtc(clearedAt)` 丢弃旧日条目（见 app.ts 的 POST 处理）。
   */
  setTeamUsageClearedAt(actorId: string, at: number): void;
  /** 该成员最后一次清除时刻（毫秒）；从未清除过 → null。 */
  getTeamUsageClearedAt(actorId: string): number | null;
  // —— d.92 团队工作台：用户自建团队 / 方案 / 任务（智能体接口预留，权限只在服务端判） ——
  //
  // 权限口径（app 层按此映射状态码，两个实现必须一致）：
  // - 非成员访问团队 → 一律返回 null（app 404「团队不存在」），不泄露团队是否存在；
  // - 成员但不是 owner 做 owner-only 动作 → "forbidden"（app 403）；
  // - 方案/任务：团队成员都能读写（`forbidden` 留在联合类型里给后续按项授权用）。
  /** 我是成员的团队，按 updatedAt 降序（最近有动静的在前）。 */
  listWorkspaceTeams(userId: string): WorkspaceTeam[];
  /** 我所在团队的简报（团队名/我在里面的角色/成员名单），给智能体认人用（d.253）。 */
  listTeamBriefs(userId: string): TeamBrief[];
  /** 团队工作台快照（成员 + 方案 + 任务）；不是成员 / 不存在 → null。 */
  getWorkspaceTeam(teamId: string, userId: string): TeamWorkspaceSnapshot | null;
  /** 建团队并把自己写成 owner 成员；返回空快照。 */
  createWorkspaceTeam(ownerId: string, body: WorkspaceTeamCreateInput): TeamWorkspaceSnapshot;
  /** 仅 owner 可改名/改目标；非成员 null，成员非 owner "forbidden"。 */
  updateWorkspaceTeam(
    teamId: string,
    actorId: string,
    body: WorkspaceTeamUpdateInput,
  ): TeamWorkspaceSnapshot | "forbidden" | null;
  /** 仅 owner；级联删除成员/方案/任务。非成员 null，成员非 owner "forbidden"。 */
  deleteWorkspaceTeam(teamId: string, actorId: string): boolean | "forbidden" | null;
  /** 仅 owner 按用户名拉人；用户不存在 "user_not_found"，已在团队 "already_member"。 */
  addWorkspaceMember(
    teamId: string,
    actorId: string,
    username: string,
  ): TeamWorkspaceSnapshot | "forbidden" | "user_not_found" | "already_member" | null;
  /** 仅 owner；不能移除 owner（"owner"）。目标不是成员 → null。 */
  removeWorkspaceMember(
    teamId: string,
    actorId: string,
    targetUserId: string,
  ): TeamWorkspaceSnapshot | "forbidden" | "owner" | null;
  /**
   * 成员自己退出团队（本人操作，不经 owner 同意）。
   *
   * 为什么要有：被误拉进团队的人没有自救入口，只能求 owner 踢——owner 不在就永久留在别人团队里，
   * 还会继续看到方案与任务。与 `removeWorkspaceMember` 的区别只是「谁发起」。
   *
   * - 非成员 / 团队不存在 → null（app 404「团队不存在」，口径同其它入口）
   * - 调用者就是 owner → "owner"（app 409）：团队不能无主，先转让（transferTeamOwnership）或解散
   * - 成功：删成员行 + 把指派给他的任务解绑为「待认领」+ 刷 updated_at，**同一事务**
   *   （否则半截态 = 人已退出、任务还指着一个非成员，正是 removeWorkspaceMember 要避免的非法引用）
   */
  leaveWorkspaceTeam(teamId: string, userId: string): TeamWorkspaceSnapshot | "owner" | null;
  /**
   * 转让队长（仅当前 owner）。
   *
   * 为什么要有：owner 换号 / 离职后，团队没有任何人能做 owner-only 动作（改名、加成员、删团队），
   * 也没人能移除 owner——团队永久僵尸。转让是唯一的交接口子。
   *
   * - 非成员 / 团队不存在 → null（app 404「团队不存在」）
   * - 成员但不是 owner → "forbidden"（app 403）
   * - 目标不是该团队成员 → "not_member"（app 400）——不能把团队交给外人
   * - 成功：teams.owner_id 改目标 + 两人 role 互换（原 owner 降为 member）+ 刷 updated_at，同一事务
   */
  transferTeamOwnership(
    teamId: string,
    actorId: string,
    targetUserId: string,
  ): TeamWorkspaceSnapshot | "forbidden" | "not_member" | null;
  /** 新建方案项（成员可写）；plan 不存在 "not_found"。 */
  createTeamPlan(
    teamId: string,
    actorId: string,
    body: TeamPlanCreateInput,
  ): TeamPlanItem | "forbidden" | "not_found" | null;
  updateTeamPlan(
    teamId: string,
    planId: string,
    actorId: string,
    body: TeamPlanUpdateInput,
  ): TeamPlanItem | "forbidden" | "not_found" | null;
  deleteTeamPlan(teamId: string, planId: string, actorId: string): boolean | "forbidden" | "not_found";
  /**
   * 新建任务（成员可写）。校验两类引用：
   * - assigneeId 必须是团队成员 → "assignee_not_member"（app 400）
   * - planId 必须属于该团队 → "plan_not_found"（app 400）
   */
  createTeamTask(
    teamId: string,
    actorId: string,
    body: TeamTaskCreateInput,
  ):
    | TeamTask
    | "forbidden"
    | "not_found"
    | "not_leader"
    | "assignee_not_member"
    | "plan_not_found"
    | "blocker_not_found"
    | "blocker_cycle"
    | null;
  /** 改任务（成员可写）；任务不存在 "not_found"；引用校验同 createTeamTask。 */
  updateTeamTask(
    teamId: string,
    taskId: string,
    actorId: string,
    body: TeamTaskUpdateInput,
  ):
    | TeamTask
    | "forbidden"
    | "not_found"
    | "not_leader"
    | "assignee_not_member"
    | "plan_not_found"
    | "blocker_not_found"
    | "blocker_cycle"
    | "not_nudgeable"
    | "not_reviewable"
    | null;
  deleteTeamTask(teamId: string, taskId: string, actorId: string): boolean | "forbidden" | "not_found";
  /**
   * 派到我名下、还没完成的任务（跨团队聚合，截止近的在前）。
   * 让队员的智能体一开口就知道「团队里有什么活儿派给我」。
   */
  listAssignedTeamTasks(userId: string): {
    teamId: string;
    teamName: string;
    task: TeamTask;
    /** 还没完成的前置任务（d.255）：非空说明这条活儿现在还不该开始。 */
    openBlockers: { id: string; title: string }[];
  }[];
  /**
   * 我所在团队里「还没人认领」的活（d.260）。
   *
   * 派活时把负责人留空 = 等认领，但此前只有团队页能看到：队员的智能体只知道派到自己名下的，
   * 于是这类活容易一直挂着。这里只返回**我所在团队**的未认领任务（同团队是前提，别人的团队与我无关），
   * 形状与 listAssignedTeamTasks 一致，面板与提示词复用同一套渲染。
   */
  listClaimableTeamTasks(userId: string): {
    teamId: string;
    teamName: string;
    task: TeamTask;
    openBlockers: { id: string; title: string }[];
  }[];
  /** 任务讨论（d.271）：一条任务下的留言，按时间从早到晚。 */
  /** 团队动态（d.273）：只追加；按团队裁剪，返回按时间倒序。 */
  addTeamEvent(event: TeamEvent): void;
  listTeamEvents(teamId: string, limit?: number, taskId?: string | null): TeamEvent[];
  listTeamTaskComments(teamId: string, taskId: string): TeamTaskComment[];
  /**
   * 追加一条讨论（d.271）。
   *
   * 与 progress 的区别：progress 是「最新进展」覆盖式的一条；讨论是追加的时间线，
   * 用来问口径、补约束、回复对方的疑问——所以谁也不能改别人写过的话。
   */
  addTeamTaskComment(
    teamId: string,
    taskId: string,
    actorId: string,
    text: string,
  ): TeamTaskComment | "forbidden" | "not_found";
  /** 幂等登记系统预设 agent（新库没有预设群后仍要能开「和小鸣」对话）。 */
  ensureSystemAgents(): void;
}

/**
 * 校验任务依赖（d.255）。
 *
 * - 前置必须存在且属于同一个团队 → "blocker_not_found"
 * - 不能依赖自己，也不能成环（A→B→A）→ "blocker_cycle"
 *
 * 只做「能表达的依赖是不是合法」，不做「没完成就不许开始」的硬阻断：
 * 现实里经常要先试一下才知道前置是不是真的挡住了，硬拦会把模型逼成撒谎。
 */
function validateBlockers(
  tasks: Map<string, TeamTask>,
  teamId: string,
  taskId: string | null,
  ids: readonly string[],
): "blocker_not_found" | "blocker_cycle" | null {
  const clean = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
  for (const id of clean) {
    const dep = tasks.get(id);
    if (!dep || dep.teamId !== teamId) return "blocker_not_found";
  }
  if (taskId === null) return null;
  const stack = [...clean];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === taskId) return "blocker_cycle";
    for (const b of tasks.get(id)?.blockedBy ?? []) stack.push(b);
  }
  return null;
}

/** 归一前置 id 列表：去空、去重、保序（schema 已限 5 个，这里只做形状收敛）。 */
function normalizeBlockers(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) return [];
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

export function createMemoryStore(): Store {
  const users = new Map<string, { user: User; passwordHash: string }>();
  const usersByName = new Map<string, string>();
  /** 登录会话（token 摘要 → userId + 过期时刻）；进程内实现，sqlite 侧对应 sessions 表。 */
  const sessions = new Map<string, { userId: string; expiresAt: number | null }>();
  const conversations = new Map<
    string,
    {
      /** 只有本人（智能体一对一的参与者）。 */
      members: string[];
      kind: "agent";
      /** 对方 agent id（sqlite 侧对应 conversation_agents 关联）。 */
      agentPeerId?: string;
      /** d.128：会话标题（空 = 未命名，界面按首条消息/时间兜底）。 */
      title?: string;
      /** d.147.4.91.11：归属的工作区路径（本机文件夹；空 = 未分组）。 */
      workspace?: string;
    }
  >();
  const messages = new Map<string, Message[]>();
  /** 左栏工作区清单：userId → (path → updatedAt)。 */
  const workspaces = new Map<string, Map<string, string>>();
  // 智能体名册（closure 级，随 store 实例隔离——与 users/conversations 同层）。
  // 单智能体产品：构造即登记唯一内置智能体（与 sqlite 启动时 ensureSystemAgents 同口径），
  // 保证任何时候 listAgents / createAgentConversation 都有且只有「和小鸣」。
  const agents = new Map<string, Agent>();
  agents.set(SYSTEM_AGENT_ID, { ...SYSTEM_AGENT });
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
  /** 清除水位：actorId → 清除时刻（毫秒）。服务端权威那份，见 setTeamUsageClearedAt 注释。 */
  const teamUsageClears = new Map<string, number>();
  /** 动向清除水位：actorId → 清除时刻（毫秒），见 setTeamActivityClearedAt 注释。 */
  const teamActivityClears = new Map<string, number>();
  // d.92 团队工作台：键与 sqlite 主键同口径（成员键 = `teamId` + NUL + `userId`）
  const teams = new Map<string, WorkspaceTeam>();
  const teamMembers = new Map<
    string,
    { teamId: string; userId: string; role: TeamMemberRole; joinedAt: string }
  >();
  const teamPlans = new Map<string, TeamPlanItem>();
  const teamTasks = new Map<string, TeamTask>();
  /** 任务讨论（d.271）：键 = taskId，值按 created_at 升序。 */
  const teamTaskComments = new Map<string, TeamTaskComment[]>();
  /** 团队动态（d.273）：键 = teamId，值按时间升序；每团队只留最近 300 条。 */
  const MAX_TEAM_EVENTS = 300;
  const teamEvents = new Map<string, TeamEvent[]>();

  const mustUser = (id: string): User => {
    const row = users.get(id);
    if (!row) throw new Error("user not found");
    return row.user;
  };

  const teamMemberKey = (teamId: string, userId: string) => `${teamId}\0${userId}`;
  /** 团队创建者即组长：只有组长能把任务派给别人（成员可自派 / 认领）。 */
  const isTeamOwner = (teamId: string, userId: string): boolean =>
    teams.get(teamId)?.ownerId === userId;

  const memberRole = (teamId: string, userId: string): TeamMemberRole | null =>
    teamMembers.get(teamMemberKey(teamId, userId))?.role ?? null;
  /** 可见团队：存在且本人是成员；否则 null（app 层一律 404，不泄露存在性）。 */
  const visibleTeam = (teamId: string, actorId: string): WorkspaceTeam | null => {
    const team = teams.get(teamId);
    if (!team || !teamMembers.has(teamMemberKey(teamId, actorId))) return null;
    return team;
  };
  /** 团队内有任何动静（改团队/成员/方案/任务）就刷新 updatedAt：列表按它倒序排。 */
  const touchTeam = (teamId: string): void => {
    const team = teams.get(teamId);
    if (team) teams.set(teamId, { ...team, updatedAt: new Date().toISOString() });
  };
  const snapshotOf = (teamId: string): TeamWorkspaceSnapshot => {
    const team = teams.get(teamId)!;
    const members = [...teamMembers.values()]
      .filter((m) => m.teamId === teamId)
      .map((m) => {
        const row = users.get(m.userId);
        return row ? { user: row.user, role: m.role, joinedAt: m.joinedAt } : null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort(
        (a, b) =>
          // owner 排第一，其余按加入时间；同时刻用显示名兜底，保证两实现顺序一致
          (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1) ||
          (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0) ||
          a.user.displayName.localeCompare(b.user.displayName, "zh-Hans-CN") ||
          // 显示名可以重名（用户自己填的）：再用 id 兜底，保证名册顺序稳定、两实现一致。
          a.user.id.localeCompare(b.user.id),
      );
    const plans = [...teamPlans.values()]
      .filter((p) => p.teamId === teamId)
      .sort(
        (a, b) =>
          a.orderIndex - b.orderIndex ||
          (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const tasks = [...teamTasks.values()]
      .filter((t) => t.teamId === teamId)
      .sort(
        (a, b) =>
          (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return { team, members, plans, tasks };
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
    addSession(tokenDigest, userId, expiresAt = null) {
      sessions.set(tokenDigest, { userId, expiresAt });
    },
    sessionUserId(tokenDigest) {
      const row = sessions.get(tokenDigest);
      if (!row) return null;
      // 过期即删：不把死会话留在 Map 里，也让「刷新/登出」之外没有回收任务。
      if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
        sessions.delete(tokenDigest);
        return null;
      }
      return row.userId;
    },
    deleteSession(tokenDigest) {
      return sessions.delete(tokenDigest);
    },
    deleteUserSessions(userId) {
      let revoked = 0;
      // 先收集键再删：改 Map 的同时遍历迭代器在部分引擎上行为未定义。
      for (const [key, row] of [...sessions]) {
        if (row.userId !== userId) continue;
        sessions.delete(key);
        revoked += 1;
      }
      return revoked;
    },
    searchMessages() {
      // 内存实现没有 FTS 索引：调用方回退线性扫描（两实现结果口径由 app 层统一保证）。
      return null;
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
    createAgentConversation(userId, _agentId, options = {}) {
      mustUser(userId);
      // 单智能体产品：忽略传入 agentId（旧客户端仍可能传自建 agent id），一律挂唯一内置智能体。
      // 不再有名册存在性 / 属主校验——自建智能体能力已删除，旧 id 静默归一。
      const agent = agents.get(SYSTEM_AGENT_ID)!;
      // 旧行为（fresh 缺省）：同一用户 × 唯一智能体幂等复用；`fresh: true` 则每次新开一段
      // （Claude Code 式「同一智能体多段对话」；老客户端/旧链接不受影响）。
      const title = (options.title ?? "").trim().slice(0, 80);
      const workspace = (options.workspace ?? "").trim().slice(0, 1024);
      if (!options.fresh) {
        const found = [...conversations].find(
          ([, c]) =>
            c.kind === "agent" && c.agentPeerId === SYSTEM_AGENT_ID && c.members.includes(userId),
        );
        if (found) return { id: found[0], type: "agent", agent };
      }
      const id = randomUUID();
      conversations.set(id, {
        members: [userId],
        kind: "agent",
        agentPeerId: SYSTEM_AGENT_ID,
        ...(title ? { title } : {}),
        ...(workspace ? { workspace } : {}),
      });
      messages.set(id, []);
      return { id, type: "agent", agent };
    },
    listConversations(userId) {
      const out: Conversation[] = [];
      for (const [id, conv] of conversations) {
        if (!conv.members.includes(userId)) continue;
        // 智能体一对一：对方是唯一内置智能体（名册项而非 users 行）；兜底取不到就不出这条
        // 会话——宁可不显示，也不给前端一个没有 agent 字段的半截对象。
        const agent = conv.agentPeerId ? agents.get(conv.agentPeerId) : undefined;
        if (agent)
          out.push({
            id,
            type: "agent",
            agent,
            ...(conv.title ? { title: conv.title } : {}),
            ...(conv.workspace ? { workspace: conv.workspace } : {}),
            // 智能体会话没有「别人发来」的概念，未读恒为 0（读状态随人类 IM 一起删除）。
            unreadCount: 0,
            lastMessageAt: messages.get(id)?.at(-1)?.createdAt ?? null,
          });
      }
      return out;
    },
    updateConversationTitle(conversationId, userId, title) {
      const conv = conversations.get(conversationId);
      if (!conv || !conv.members.includes(userId)) return false;
      const next = title.trim().slice(0, 80);
      if (next) conv.title = next;
      else delete conv.title;
      return true;
    },
    updateConversationWorkspace(conversationId, userId, workspace) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      if (!conv.members.includes(userId)) return false;
      const next = (workspace ?? "").trim().slice(0, 1024);
      if (next) conv.workspace = next;
      else delete conv.workspace;
      return true;
    },
    listWorkspaces(userId) {
      mustUser(userId);
      return [...(workspaces.get(userId) ?? new Map<string, string>())]
        .map(([path, updatedAt]) => ({ path, updatedAt }))
        // 同一毫秒加的多个工作区要有确定顺序，否则列表每次刷新会跳：并列时按路径排。
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
    },
    addWorkspace(userId, path) {
      mustUser(userId);
      const next = path.trim().slice(0, 1024);
      if (!next) throw new Error("invalid path");
      const now = new Date().toISOString();
      const list = workspaces.get(userId) ?? new Map<string, string>();
      list.set(next, now);
      workspaces.set(userId, list);
      return { path: next, updatedAt: now };
    },
    removeWorkspace(userId, path) {
      mustUser(userId);
      const next = path.trim().slice(0, 1024);
      const inUse = [...conversations.values()].some(
        (c) => c.members.includes(userId) && c.workspace === next,
      );
      if (inUse) throw new Error("workspace in use");
      workspaces.get(userId)?.delete(next);
    },
    deleteConversation(conversationId, userId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      if (!conv.members.includes(userId)) throw new Error("forbidden");
      conversations.delete(conversationId);
      messages.delete(conversationId);
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
    deleteMessages(conversationId, ids) {
      const all = messages.get(conversationId);
      if (!all) throw new Error("conversation not found");
      if (ids.length === 0) return 0;
      const drop = new Set(ids);
      const kept = all.filter((m) => !drop.has(m.id));
      const removed = all.length - kept.length;
      if (removed > 0) messages.set(conversationId, kept);
      return removed;
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
      // 单智能体产品：名册恒为唯一内置智能体（构造时已登记，此处再兜一层）。
      const agent = agents.get(SYSTEM_AGENT_ID);
      return agent ? [agent] : [];
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
    detachTeamAttachment(fileId) {
      let affected = 0;
      for (const [id, task] of [...teamTasks.entries()]) {
        if (task.attachmentFileId !== fileId) continue;
        teamTasks.set(id, {
          ...task,
          attachmentFileId: null,
          updatedAt: new Date().toISOString(),
        });
        affected += 1;
      }
      return affected;
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
    listTeamCollaborators(viewerId) {
      // viewer 自己 + 与之共享至少一个工作台团队的人；无团队时只剩自己。
      const ids = new Set<string>([viewerId]);
      for (const member of teamMembers.values()) {
        if (member.userId !== viewerId) continue;
        for (const other of teamMembers.values()) {
          if (other.teamId === member.teamId) ids.add(other.userId);
        }
      }
      return [...ids]
        .map((id) => users.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .map((row) => ({ user: row.user, lastSeenAt: lastSeen.get(row.user.id) ?? null }))
        .sort((a, b) => {
          // 与 roster 口径一致：最近活跃倒序、null 最后、同值显示名（SQLite 同语义）。
          if (a.lastSeenAt !== b.lastSeenAt) {
            if (a.lastSeenAt === null) return 1;
            if (b.lastSeenAt === null) return -1;
            return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
          }
          return a.user.displayName.localeCompare(b.user.displayName, "zh-Hans-CN");
        });
    },
    addTeamActivity(actorId, input) {
      mustUser(actorId);
      const key = `${actorId}\0${input.sourceId}`;
      if (teamActivityKeys.has(key)) {
        // 日程的档位是时间的函数（今天到期 → 已逾期），sourceId 稳定不代表内容不变：
        // 幂等命中时刷新展示字段，否则团队页会永远停在首次上报的档位（W2-01）。
        // 任务动向仍严格幂等（内容随 status 变化由新的 updatedAt 生成新 sourceId）。
        if (input.kind === "agenda") {
          const row = teamActivities.find(
            (a) => a.actorId === actorId && a.sourceId === input.sourceId,
          );
          if (row) {
            row.title = input.title;
            if (input.detail !== undefined) row.detail = input.detail;
            if (input.status !== undefined) row.status = input.status;
            row.occurredAt = input.occurredAt;
          }
        }
        return false;
      }
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
      // 可见范围必须在过滤阶段生效：先收敛 actor 再排序/截断，否则 limit 会被不可见行占掉。
      const visible = opts.actorIds ? new Set(opts.actorIds) : null;
      const rows = teamActivities
        .filter((a) => (visible ? visible.has(a.actorId) : true))
        .filter((a) => (opts.actorId ? a.actorId === opts.actorId : true))
        .filter((a) => {
          if (!opts.before) return true;
          // 无 beforeId：旧语义（严格小于 occurredAt），老客户端行为不变。
          if (!opts.beforeId) return a.occurredAt < opts.before;
          // 有 beforeId：同 occurredAt 的剩余条目按 id 继续翻（与 SQLite 同语义）。
          return (
            a.occurredAt < opts.before ||
            (a.occurredAt === opts.before && a.id < opts.beforeId)
          );
        })
        // 排序统一 `occurredAt DESC, id DESC`：同刻不再靠插入序（两 Store 曾相反）。
        .sort((a, b) =>
          a.occurredAt < b.occurredAt
            ? 1
            : a.occurredAt > b.occurredAt
              ? -1
              : a.id < b.id
                ? 1
                : a.id > b.id
                  ? -1
                  : 0,
        );
      return rows.slice(0, limit).map((a) => ({ ...a }));
    },
    countTeamActivities(actorId) {
      let n = 0;
      for (const a of teamActivities) if (a.actorId === actorId) n += 1;
      return n;
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
    purgeTeamActivities(before) {
      let removed = 0;
      for (let i = teamActivities.length - 1; i >= 0; i -= 1) {
        const a = teamActivities[i];
        if (a.occurredAt >= before) continue;
        // 幂等键也要一起清：否则同一个 sourceId 之后再也写不进来（写侧会当成重复跳过）。
        teamActivityKeys.delete(`${a.actorId}\0${a.sourceId}`);
        teamActivities.splice(i, 1);
        removed += 1;
      }
      return removed;
    },
    setTeamActivityClearedAt(actorId, at) {
      mustUser(actorId);
      teamActivityClears.set(actorId, at);
    },
    getTeamActivityClearedAt(actorId) {
      return teamActivityClears.get(actorId) ?? null;
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
    listTeamUsage({ from, to, actorIds }) {
      const visible = actorIds ? new Set(actorIds) : null;
      return [...teamUsage.values()]
        .filter((row) => row.date >= from && row.date <= to)
        .filter((row) => (visible ? visible.has(row.actorId) : true))
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
    setTeamUsageClearedAt(actorId, at) {
      mustUser(actorId);
      teamUsageClears.set(actorId, at);
    },
    getTeamUsageClearedAt(actorId) {
      return teamUsageClears.get(actorId) ?? null;
    },
    listWorkspaceTeams(userId) {
      return [...teams.values()]
        .filter((team) => teamMembers.has(teamMemberKey(team.id, userId)))
        .sort(
          (a, b) =>
            (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((team) => ({ ...team }));
    },
    listTeamBriefs(userId) {
      return [...teams.values()]
        .filter((team) => teamMembers.has(teamMemberKey(team.id, userId)))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .map((team) => {
          // d.256：任务概览随简报一起给（组长被问进度时不用逐个 team_get）。
          const summary = summarizeTeamTasks(
            [...teamTasks.values()].filter((task) => task.teamId === team.id),
          );
          const members = [...teamMembers.values()]
            .filter((member) => member.teamId === team.id)
            .map((member) => {
              const found = users.get(member.userId);
              return {
                id: member.userId,
                displayName: found === undefined ? member.userId : found.user.displayName,
                role: member.role,
                open: summary.perMember.get(member.userId) ?? 0,
              };
            })
            .sort((a, b) =>
              a.role === b.role
                ? a.displayName.localeCompare(b.displayName, "zh-Hans-CN")
                : a.role === "owner"
                  ? -1
                  : 1,
            );
          return {
            id: team.id,
            name: team.name,
            goal: team.goal,
            ownerId: team.ownerId,
            role: team.ownerId === userId ? ("owner" as const) : ("member" as const),
            members,
            counts: summary.counts,
          };
        });
    },
    getWorkspaceTeam(teamId, userId) {
      return visibleTeam(teamId, userId) ? snapshotOf(teamId) : null;
    },
    createWorkspaceTeam(ownerId, body) {
      const at = new Date().toISOString();
      const team: WorkspaceTeam = {
        id: randomUUID(),
        name: body.name,
        goal: body.goal ?? "",
        ownerId,
        createdAt: at,
        updatedAt: at,
      };
      teams.set(team.id, team);
      teamMembers.set(teamMemberKey(team.id, ownerId), {
        teamId: team.id,
        userId: ownerId,
        role: "owner",
        joinedAt: at,
      });
      return snapshotOf(team.id);
    },
    updateWorkspaceTeam(teamId, actorId, body) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      const next: WorkspaceTeam = {
        ...team,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.goal !== undefined ? { goal: body.goal } : {}),
        updatedAt: new Date().toISOString(),
      };
      teams.set(teamId, next);
      return snapshotOf(teamId);
    },
    deleteWorkspaceTeam(teamId, actorId) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      teams.delete(teamId);
      for (const [key, m] of [...teamMembers.entries()]) if (m.teamId === teamId) teamMembers.delete(key);
      for (const [id, p] of [...teamPlans.entries()]) if (p.teamId === teamId) teamPlans.delete(id);
      for (const [id, t] of [...teamTasks.entries()]) if (t.teamId === teamId) teamTasks.delete(id);
      return true;
    },
    addWorkspaceMember(teamId, actorId, username) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      const targetId = usersByName.get(username);
      if (!targetId) return "user_not_found";
      if (teamMembers.has(teamMemberKey(teamId, targetId))) return "already_member";
      teamMembers.set(teamMemberKey(teamId, targetId), {
        teamId,
        userId: targetId,
        role: "member",
        joinedAt: new Date().toISOString(),
      });
      touchTeam(teamId);
      return snapshotOf(teamId);
    },
    removeWorkspaceMember(teamId, actorId, targetUserId) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      if (targetUserId === team.ownerId) return "owner";
      if (!teamMembers.has(teamMemberKey(teamId, targetUserId))) return null;
      teamMembers.delete(teamMemberKey(teamId, targetUserId));
      // 被移出的人不该继续挂任务：指给他的任务解绑成「待认领」，
      // 否则团队里会留下一个「指给非成员」的非法引用。
      for (const [id, task] of teamTasks) {
        if (task.teamId === teamId && task.assigneeId === targetUserId) {
          teamTasks.set(id, { ...task, assigneeId: null, updatedAt: new Date().toISOString() });
        }
      }
      touchTeam(teamId);
      return snapshotOf(teamId);
    },
    leaveWorkspaceTeam(teamId, userId) {
      const team = visibleTeam(teamId, userId);
      if (!team) return null;
      // 团队不能无主：owner 先转让或解散，不能自己走掉把团队变成孤儿。
      if (team.ownerId === userId) return "owner";
      teamMembers.delete(teamMemberKey(teamId, userId));
      // 与 removeWorkspaceMember 同口径：人走了，指给他的任务解绑成「待认领」，
      // 不在团队里留下「指给非成员」的非法引用。
      for (const [id, task] of teamTasks) {
        if (task.teamId === teamId && task.assigneeId === userId) {
          teamTasks.set(id, { ...task, assigneeId: null, updatedAt: new Date().toISOString() });
        }
      }
      touchTeam(teamId);
      return snapshotOf(teamId);
    },
    transferTeamOwnership(teamId, actorId, targetUserId) {
      const team = visibleTeam(teamId, actorId);
      if (!team) return null;
      if (team.ownerId !== actorId) return "forbidden";
      const targetKey = teamMemberKey(teamId, targetUserId);
      const target = teamMembers.get(targetKey);
      if (!target) return "not_member";
      const at = new Date().toISOString();
      // 先降自己再升目标：transfer 给自己时同一个 key 两次写，最终仍是 owner（幂等无害，
      // 但 app 层会先挡掉「不能转让给自己」）。
      const ownerKey = teamMemberKey(teamId, actorId);
      const ownerMember = teamMembers.get(ownerKey);
      if (ownerMember) teamMembers.set(ownerKey, { ...ownerMember, role: "member" });
      teamMembers.set(targetKey, { ...target, role: "owner" });
      teams.set(teamId, { ...team, ownerId: targetUserId, updatedAt: at });
      return snapshotOf(teamId);
    },
    createTeamPlan(teamId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      const at = new Date().toISOString();
      const siblings = [...teamPlans.values()].filter((p) => p.teamId === teamId);
      const plan: TeamPlanItem = {
        id: randomUUID(),
        teamId,
        title: body.title,
        detail: body.detail ?? "",
        status: "todo",
        orderIndex: body.orderIndex ?? siblings.length,
        createdBy: actorId,
        createdAt: at,
        updatedAt: at,
      };
      teamPlans.set(plan.id, plan);
      touchTeam(teamId);
      return { ...plan };
    },
    updateTeamPlan(teamId, planId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      const plan = teamPlans.get(planId);
      if (!plan || plan.teamId !== teamId) return "not_found";
      const next: TeamPlanItem = {
        ...plan,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.orderIndex !== undefined ? { orderIndex: body.orderIndex } : {}),
        updatedAt: new Date().toISOString(),
      };
      teamPlans.set(planId, next);
      touchTeam(teamId);
      return { ...next };
    },
    deleteTeamPlan(teamId, planId, actorId) {
      // 非成员与「方案不存在」同口径（都是 404），不泄露团队存在性
      if (!visibleTeam(teamId, actorId)) return "not_found";
      const plan = teamPlans.get(planId);
      if (!plan || plan.teamId !== teamId) return "not_found";
      teamPlans.delete(planId);
      // 删方案不删任务：归属它的任务解绑成独立任务（执行内容比归类更重要）
      for (const [id, task] of teamTasks) {
        if (task.teamId === teamId && task.planId === planId) {
          teamTasks.set(id, { ...task, planId: null, updatedAt: new Date().toISOString() });
        }
      }
      touchTeam(teamId);
      return true;
    },
    listAssignedTeamTasks(userId) {
      const out: {
        teamId: string;
        teamName: string;
        task: TeamTask;
        openBlockers: { id: string; title: string }[];
      }[] = [];
      for (const task of teamTasks.values()) {
        if (task.assigneeId !== userId || task.status === "done") continue;
        const team = teams.get(task.teamId);
        if (!team) continue;
        const openBlockers = (task.blockedBy ?? [])
          .map((id) => teamTasks.get(id))
          .filter((dep): dep is TeamTask => dep !== undefined && dep.status !== "done")
          .map((dep) => ({ id: dep.id, title: dep.title }));
        out.push({ teamId: team.id, teamName: team.name, task: { ...task }, openBlockers });
      }
      // 能做的排前面（前置没完成的其实是「还轮不到你」，不该抢在最前）。
      out.sort(
        (a, b) =>
          a.openBlockers.length - b.openBlockers.length ||
          (a.task.dueAt ?? "9999").localeCompare(b.task.dueAt ?? "9999") ||
          a.task.updatedAt.localeCompare(b.task.updatedAt),
      );
      return out;
    },
    listClaimableTeamTasks(userId) {
      const out: {
        teamId: string;
        teamName: string;
        task: TeamTask;
        openBlockers: { id: string; title: string }[];
      }[] = [];
      for (const task of teamTasks.values()) {
        // 只认「没人认领 + 没完成」：已经派出去的不在这个列表里（那是别人名下的事）。
        if (task.assigneeId !== null || task.status === "done") continue;
        const team = teams.get(task.teamId);
        if (!team) continue;
        if (!teamMembers.has(teamMemberKey(team.id, userId))) continue;
        const openBlockers = (task.blockedBy ?? [])
          .map((id) => teamTasks.get(id))
          .filter((dep): dep is TeamTask => dep !== undefined && dep.status !== "done")
          .map((dep) => ({ id: dep.id, title: dep.title }));
        out.push({ teamId: team.id, teamName: team.name, task: { ...task }, openBlockers });
      }
      // 与「派给我的」排序一致：能做的在前，其次按截止，再按更新时间。
      out.sort(
        (a, b) =>
          a.openBlockers.length - b.openBlockers.length ||
          (a.task.dueAt ?? "9999").localeCompare(b.task.dueAt ?? "9999") ||
          a.task.updatedAt.localeCompare(b.task.updatedAt),
      );
      return out;
    },
    createTeamTask(teamId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      if (body.planId) {
        const plan = teamPlans.get(body.planId);
        if (!plan || plan.teamId !== teamId) return "plan_not_found";
      }
      if (body.assigneeId && memberRole(teamId, body.assigneeId) === null) {
        return "assignee_not_member";
      }
      // 组长语义：别人的活儿只能由组长指派；成员可以自派或留空等认领。
      if (body.assigneeId && body.assigneeId !== actorId && !isTeamOwner(teamId, actorId)) {
        return "not_leader";
      }
      const blockedBy = normalizeBlockers(body.blockedBy);
      const blockerError = validateBlockers(teamTasks, teamId, null, blockedBy);
      if (blockerError !== null) return blockerError;
      const at = new Date().toISOString();
      const task: TeamTask = {
        id: randomUUID(),
        teamId,
        planId: body.planId ?? null,
        title: body.title,
        detail: body.detail ?? "",
        assigneeId: body.assigneeId ?? null,
        status: "todo",
        createdBy: actorId,
        createdAt: at,
        updatedAt: at,
        dueAt: body.dueAt ?? null,
        attachmentFileId: body.attachmentFileId ?? null,
        priority: body.priority ?? "normal",
        result: "",
        completedAt: null,
        completedBy: null,
        returnedAt: null,
        returnedBy: null,
        returnNote: "",
    progress: "",
    progressAt: null,
    progressBy: null,
    nudgedAt: null,
    nudgedBy: null,
        nudgeCount: 0,
        /** 验收（d.272）：刚交上来还没人看。 */
        reviewState: "pending",
        reviewNote: "",
        reviewedAt: null,
        reviewedBy: null,
        blockedBy,
      };
      teamTasks.set(task.id, task);
      touchTeam(teamId);
      return { ...task };
    },
    listTeamTaskComments(teamId, taskId) {
    return [...(teamTaskComments.get(taskId) ?? [])];
  },

  addTeamTaskComment(teamId, taskId, actorId, text) {
    if (!visibleTeam(teamId, actorId)) return "forbidden";
    const task = teamTasks.get(taskId);
    if (!task || task.teamId !== teamId) return "not_found";
    const comment: TeamTaskComment = {
      id: randomUUID(),
      teamId,
      taskId,
      authorId: actorId,
      text,
      createdAt: new Date().toISOString(),
    };
    teamTaskComments.set(taskId, [...(teamTaskComments.get(taskId) ?? []), comment]);
    touchTeam(teamId);
    return comment;
  },

  addTeamEvent(event) {
    const existing = teamEvents.get(event.teamId) ?? [];
    const next = [...existing, event];
    teamEvents.set(
      event.teamId,
      next.length > MAX_TEAM_EVENTS ? next.slice(next.length - MAX_TEAM_EVENTS) : next,
    );
  },

  listTeamEvents(teamId, limit = 50, taskId) {
    // taskId（d.276）：只回某一件活的流水，用于任务卡片的「这件活的历史」。
    const all = (teamEvents.get(teamId) ?? []).filter(
      (e) => taskId === undefined || taskId === null || taskId === "" || e.taskId === taskId,
    );
    const size = Math.max(0, Math.min(Math.floor(limit), MAX_TEAM_EVENTS));
    return all.slice(Math.max(0, all.length - size)).reverse().map((e) => ({ ...e }));
  },

  updateTeamTask(teamId, taskId, actorId, body) {
      if (!visibleTeam(teamId, actorId)) return null;
      const task = teamTasks.get(taskId);
      if (!task || task.teamId !== teamId) return "not_found";
      if (body.planId) {
        const plan = teamPlans.get(body.planId);
        if (!plan || plan.teamId !== teamId) return "plan_not_found";
      }
      if (body.assigneeId && memberRole(teamId, body.assigneeId) === null) {
        return "assignee_not_member";
      }
      // 改派给别人 = 派活，同样只有组长可以做（保持原负责人或改回未认领不算）。
      if (
        body.assigneeId !== undefined &&
        body.assigneeId !== null &&
        body.assigneeId !== actorId &&
        body.assigneeId !== task.assigneeId &&
        !isTeamOwner(teamId, actorId)
      ) {
        return "not_leader";
      }
      /**
       * 任务级权限（d.254）：成员只能动「自己名下」和「还没人认领」的任务。
       *
       * 此前只卡了「改派给别人」，于是成员可以把别人的任务标成完成、改标题、改截止——
       * 派活的人看不到是谁改的，被改的人回来发现状态变了。组长不受限（要能替人收尾）。
       */
      if (!isTeamOwner(teamId, actorId) && task.assigneeId !== null && task.assigneeId !== actorId) {
        return "forbidden";
      }
      const blockedBy = body.blockedBy === undefined ? undefined : normalizeBlockers(body.blockedBy);
      if (blockedBy !== undefined) {
        const blockerError = validateBlockers(teamTasks, teamId, taskId, blockedBy);
        if (blockerError !== null) return blockerError;
      }
      const at = new Date().toISOString();
      // 完成这件事留痕（d.252）：谁标的完成、什么时候、结论是什么。
      // 从 done 退回去 = 结论作废，避免「已重新打开的任务挂着一条旧结论」。
      // 退回（d.261）：把负责人清空 = 装回待认领池，并留下「谁退的、为什么」。
      // 组长代退也算一次退回（returnedBy 记组长），这样任务板能看出「这活退过」。
      // 催办（d.265）：只记「谁在什么时候催过一次」，不动状态、不动负责人。
      const nudged = body.nudge === true;
      if (nudged) {
        if (!isTeamOwner(teamId, actorId)) return "forbidden";
        if (task.assigneeId === null || task.assigneeId === actorId || task.status === "done") {
          return "not_nudgeable";
        }
      }
      // 验收（d.272）：只有组长能验收，而且只能验收「已完成」的活；
      // 打回会把状态改回进行中（结论保留为「上一版」），通过则只打标。
      const reviewed = body.review !== undefined;
      if (reviewed) {
        if (!isTeamOwner(teamId, actorId)) return "forbidden";
        if (task.status !== "done") return "not_reviewable";
      }
      const returned = body.assigneeId === null && task.assigneeId !== null;
      const reclaimed = body.assigneeId !== undefined && body.assigneeId !== null;
      const becameDone = body.status === "done" && task.status !== "done";
      const leftDone = body.status !== undefined && body.status !== "done" && task.status === "done";
      const next: TeamTask = {
        ...task,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        ...(body.planId !== undefined ? { planId: body.planId } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
        ...(body.attachmentFileId !== undefined
          ? { attachmentFileId: body.attachmentFileId }
          : {}),
        // 优先级（d.268）：不传就保持原值。
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.result !== undefined ? { result: body.result } : {}),
        // 进展（d.262）：留一句「做到哪、卡在哪」，与 result（交付结论）分开；空串 = 清掉。
        ...(body.progress !== undefined
          ? body.progress === ""
            ? { progress: "", progressAt: null, progressBy: null }
            : { progress: body.progress, progressAt: at, progressBy: actorId }
          : {}),
        // 催办（d.265）：累计次数不清零，方便看出「催了还不做」。
        ...(nudged
          ? { nudgedAt: at, nudgedBy: actorId, nudgeCount: (task.nudgeCount ?? 0) + 1 }
          : {}),
        // 验收（d.272）：approved 只打标；changes 顺带把任务装回「进行中」，
        // 保留 result 作为上一版结论（改完再标完成会重新进入待验收）。
        ...(reviewed
          ? body.review === "approve"
            ? {
                reviewState: "approved" as const,
                reviewNote: body.reviewNote ?? task.reviewNote ?? "",
                reviewedAt: at,
                reviewedBy: actorId,
              }
            : {
                reviewState: "changes" as const,
                reviewNote: body.reviewNote ?? "",
                reviewedAt: at,
                reviewedBy: actorId,
                status: "doing" as const,
                completedAt: null,
                completedBy: null,
              }
          : {}),
        ...(returned
          ? { returnedAt: at, returnedBy: actorId, returnNote: body.returnNote ?? "" }
          : reclaimed
            ? { returnedAt: null, returnedBy: null, returnNote: "" }
            : {}),
        ...(blockedBy !== undefined ? { blockedBy } : {}),
        ...(becameDone
          ? // 打回后重新标完成（d.275）：要重新进待验收，否则组长再也看不到这条。
            { completedAt: at, completedBy: actorId, reviewState: "pending" as const }
          : leftDone
            ? { completedAt: null, completedBy: null }
            : {}),
        updatedAt: at,
      };
      teamTasks.set(taskId, next);
      touchTeam(teamId);
      return { ...next };
    },
    deleteTeamTask(teamId, taskId, actorId) {
      if (!visibleTeam(teamId, actorId)) return "not_found";
      const task = teamTasks.get(taskId);
      if (!task || task.teamId !== teamId) return "not_found";
      // 任务级权限（d.254）：组长可删任何任务；成员只能删自己名下的，或自己创建、还没人认领的。
      const ownsTask =
        task.assigneeId === actorId || (task.assigneeId === null && task.createdBy === actorId);
      if (!isTeamOwner(teamId, actorId) && !ownsTask) return "forbidden";
      teamTasks.delete(taskId);
      // d.255：删掉的任务不能再当别人的前置，否则任务板上会挂着「等一个不存在的任务」。
      // 不碰 updatedAt：清依赖不是这条任务自己的进度，不该把「多久没动」重置。
      for (const [otherId, other] of teamTasks) {
        if (!other.blockedBy?.includes(taskId)) continue;
        teamTasks.set(otherId, {
          ...other,
          blockedBy: other.blockedBy.filter((id) => id !== taskId),
        });
      }
      touchTeam(teamId);
      return true;
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
