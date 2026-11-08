import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(32),
  displayName: z.string().min(1).max(64),
  // data URL base64 头像，与 UpdateProfileBodySchema.avatar 同上限（约 450KB 图片）
  avatar: z.string().max(600_000).optional(),
});
export type User = z.infer<typeof UserSchema>;

/**
 * 智能体名册项。
 *
 * 位置说明（原本定义在文件末尾的 AgentBodySchema 之前，现移到此处）：
 * ConversationSchema 的 agent 分支要引用它，而 `const` 有 TDZ——
 * 若 AgentSchema 定义在后面，模块初始化时构造 discriminatedUnion 会撞
 * "Cannot access 'AgentSchema' before initialization"。
 */
export const AgentSchema = z.object({
  id: z.string().min(1),
  owner_id: z.string().nullable(),
  name: z.string().min(1).max(32),
  avatar: z.string().max(600_000).nullable(),
  description: z.string().max(500),
});
export type Agent = z.infer<typeof AgentSchema>;

export const MessagePayloadSchema = z.object({
  // 上限 20000：与 agent_finish.text 对齐（agent 回复经 finish 直接入库，两处不齐会「入库即违规」）
  text: z.string().max(20000),
  // 消息附件（M4 前置）：引用共享库文件；text 可空串（纯附件消息）
  // E2E Task 5：key=附件密钥 base64（32B→44 字符），随消息进密文（PlainEnvelope.file.key 同源）；
  // legacy 明文附件无 key → 渲染层走明文 content 直通（规格 §2.4 文件边界）。空串/超长拒绝。
  file: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1).max(255),
      mime: z.string().min(1).max(128),
      size: z.number().int().min(0),
      key: z.string().min(1).max(128).optional(),
      // 文档解析出的文本（PDF/Office 在前端解析，随消息重新加密上行）。
      // 上限与正文 text 对齐：它是给模型的上下文，过大只会挤掉对话本身。
      // 客户端解析时已截断到 16000，这里留余量到 20000。
      text: z.string().max(20000).optional(),
    })
    .optional(),
});
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  senderType: z.enum(["user", "agent"]),
  senderId: z.string().min(1),
  payload: MessagePayloadSchema,
  createdAt: z.string(),
  // E2E 信封（Task 2，设计 §3.3）：enc 恒有；default 只作用于解析侧——
  // 存量 JSON（旧服务端/旧缓存）无 enc → 视为 plain，输出侧类型仍为必填。
  enc: z.enum(["plain", "e2e"]).default("plain"),
  // 信封公开元数据（仅 enc="e2e" 时出现）：cipher 上限 262144（约 196KB 密文，
  // 覆盖附件消息）；chainKid=发送链指纹上限 64（sha256 base64url 43 字符留余量）；n=链索引。
  cipher: z.string().max(262144).optional(),
  chainKid: z.string().max(64).optional(),
  n: z.number().int().min(0).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** Store.addMessage 信封入参（服务端内部契约）：enc="plain" 可整体省略（缺省 plain）。 */
export interface MessageEnvelope {
  enc: "plain" | "e2e";
  cipher?: string;
  chainKid?: string;
  n?: number;
}

const WsClientEventUnion = z.discriminatedUnion("type", [
  // —— 首帧鉴权（d.30 · P0-3）——
  // 连接建立后**第一帧**必须是这个：token 走消息体，不再走 URL query
  // （query 会进 nginx access_log 与任何中间代理日志）。
  //
  // 约定：auth 帧是**唯一**允许在未鉴权状态下发送的事件；服务端在收到它之前
  // 不登记 socket，因此未鉴权连接收不到任何业务事件。
  z.object({
    type: z.literal("auth"),
    token: z.string().min(1).max(512),
  }),
  z.object({
    type: z.literal("send_message"),
    conversationId: z.string().min(1),
    payload: MessagePayloadSchema,
    // 信封判别（Task 2）：enc 缺省 plain（旧客户端直发兼容）；cipher/chainKid/n 仅 e2e 用。
    enc: z.enum(["plain", "e2e"]).default("plain"),
    cipher: z.string().max(262144).optional(),
    chainKid: z.string().max(64).optional(),
    n: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("agent_chunk"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    // min(1) 下沉到联合体 superRefine：密文 chunk 的 text 恒为空串（内容只进 cipher），
    // 明文 chunk（无 cipher，旧客户端兼容）仍要求非空——成员级直接 min(1) 会拒掉密文形态。
    text: z.string().max(4000),
    // E2E 流式信封（Task 4，设计 §5.3）：cipher 必带 chainKid/n（收端开信封）与 index
    //（AAD=convId+streamId+index 绑定）。缺 cipher = 明文 chunk（legacy 路径）。
    cipher: z.string().max(262144).optional(),
    chainKid: z.string().max(64).optional(),
    n: z.number().int().min(0).optional(),
    index: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("agent_finish"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    // 与 MessagePayloadSchema.text 同上限：finish 文本直接入 messages.payload（不改写），
    // 宽于 payload 会出现「schema 过了、入库即违规」的缝
    text: z.string().max(20000),
    // E2E（Task 4）：finish 也走信封——text 置空、全文进 cipher，服务端按信封入库（§5.3）
    cipher: z.string().max(262144).optional(),
    chainKid: z.string().max(64).optional(),
    n: z.number().int().min(0).optional(),
  }),
  // 双向事件（设计 §3）：客户端上报流失败（aborted/provider_error），服务端回 forbidden。
  // 形状与 WsServerEventSchema 的 agent_error 成员一致（同构复用，见 ws.ts）。
  // E2E（fix I2）：错误正文可回显供应商请求片段 → 同款信封（message 置空、全文进 cipher，
  // 明文路径的 min(1) 约束由联合体 superRefine 按形态分派）。
  z.object({
    type: z.literal("agent_error"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    code: z.string().min(1),
    message: z.string().max(1000),
    cipher: z.string().max(262144).optional(),
    chainKid: z.string().max(64).optional(),
    n: z.number().int().min(0).optional(),
  }),
]);

/**
 * send_message 信封跨字段约束（superRefine 挂在联合体上：Zod 3 的 discriminatedUnion
 * 不接受 ZodEffects 成员，且 superRefine 需看到 enc 的 default 结果）：
 *   enc="e2e" → cipher 必带且非空（空串按缺处理）；
 *   enc="plain" → 必不带 cipher（明文路径不得夹带信封字段）。
 * agent 流式信封（Task 4，设计 §5.3）同口径：
 *   agent_chunk 无 cipher → text min(1)（明文 legacy 路径，成员级已放宽）；
 *   agent_chunk 有 cipher → 必带 chainKid/n/index 且 text 必须为空串（防明文夹带泄漏）；
 *   agent_finish 有 cipher → 必带 chainKid/n 且 text 必须为空串。
 */
export const WsClientEventSchema = WsClientEventUnion.superRefine((ev, ctx) => {
  if (ev.type === "send_message") {
    if (ev.enc === "e2e") {
      if (!ev.cipher) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cipher"],
          message: "e2e message requires cipher",
        });
      }
    } else if (ev.cipher !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cipher"],
        message: "plain message must not carry cipher",
      });
    }
    return;
  }
  if (ev.type === "agent_chunk") {
    if (ev.cipher !== undefined) {
      if (!ev.cipher) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cipher"],
          message: "agent_chunk cipher must be non-empty",
        });
        return;
      }
      if (ev.chainKid === undefined || ev.n === undefined || ev.index === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chainKid"],
          message: "sealed agent_chunk requires chainKid, n and index",
        });
      }
      if (ev.text !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["text"],
          message: "sealed agent_chunk must not carry plaintext text",
        });
      }
    } else if (ev.text.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "agent_chunk text required",
      });
    }
    return;
  }
  if (ev.type === "agent_error") {
    if (ev.cipher !== undefined) {
      if (!ev.cipher) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cipher"],
          message: "agent_error cipher must be non-empty",
        });
        return;
      }
      if (ev.chainKid === undefined || ev.n === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chainKid"],
          message: "sealed agent_error requires chainKid and n",
        });
      }
      if (ev.message !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["message"],
          message: "sealed agent_error must not carry plaintext message",
        });
      }
    } else if (ev.message.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "agent_error message required",
      });
    }
    return;
  }
  if (ev.type === "agent_finish" && ev.cipher !== undefined) {
    if (!ev.cipher) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cipher"],
        message: "agent_finish cipher must be non-empty",
      });
      return;
    }
    if (ev.chainKid === undefined || ev.n === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chainKid"],
        message: "sealed agent_finish requires chainKid and n",
      });
    }
    if (ev.text !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "sealed agent_finish must not carry plaintext text",
      });
    }
  }
});
/**
 * 客户端事件类型取 **input** 侧：enc 带 default("plain")——构造 send_message 时可省略
 * （旧客户端直发兼容由 schema default 落地）；服务端经 safeParse 拿到的仍是 output
 * （enc 恒有）。与 Message（消费侧，取 output/恒有字段）方向相反，属刻意区分。
 */
export type WsClientEvent = z.input<typeof WsClientEventSchema>;

export const WsServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_new"),
    message: MessageSchema,
    streamId: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent_chunk"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    // 收端两种形态并存：明文 text（legacy 触发端）/ 密文信封（text 空串 + cipher 字段）——
    // 广播面不加约束（客户端事件侧的 superRefine 已卡住源头）
    text: z.string().max(4000),
    cipher: z.string().max(262144).optional(),
    chainKid: z.string().max(64).optional(),
    n: z.number().int().min(0).optional(),
    index: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("agent_error"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    code: z.string().min(1),
    // 密文错误（fix I2）message 为空串 + cipher 透传；明文（服务端自产 forbidden 等）非空
    message: z.string().max(1000),
    cipher: z.string().max(262144).optional(),
    chainKid: z.string().max(64).optional(),
    n: z.number().int().min(0).optional(),
  }),
]);
export type WsServerEvent = z.infer<typeof WsServerEventSchema>;

export const RegisterBodySchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(128),
  displayName: z.string().min(1).max(64),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  username: z.string().min(3).max(32),
  // 登录端不规定密码策略（策略在注册侧 RegisterBodySchema），
  // 否则 HEMING_SEED_USERS 播种的短密码账号（如 admin/admin）无法登录。
  password: z.string().min(1).max(128),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

/** PUT /api/me：avatar 为 data URL base64 字符串（如 data:image/png;base64,...），上限约 450KB 图片。 */
export const UpdateProfileBodySchema = z.object({
  displayName: z.string().min(1).max(64),
  avatar: z.string().max(600_000).optional(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBodySchema>;

/**
 * d.54 团队系统：人类私聊 / 群聊已删除，会话只剩「用户 ↔ 智能体」一种是聊天。
 * 不再用 discriminatedUnion——保留 type 字段是为了旧缓存解析时的向后兼容。
 */
export const ConversationSchema = z.object({
  type: z.literal("agent"),
  id: z.string().min(1),
  agent: AgentSchema,
  unreadCount: z.number().int().min(0),
  /** 最后一条消息时间（ISO）；无消息为 null。 */
  lastMessageAt: z.string().nullable().optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** 建智能体一对一：agentId 指向名册项，owner 校验在服务端做（schema 只管形状）。 */
export const AgentConversationBodySchema = z.object({ agentId: z.string().min(1) });

export const SharedFileMetaSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type SharedFileMeta = z.infer<typeof SharedFileMetaSchema>;

export const CreateFileBodySchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(128),
  contentBase64: z.string().max(4_000_000),
});
export type CreateFileBody = z.infer<typeof CreateFileBodySchema>;

export const AgentBodySchema = z.object({
  name: z.string().min(1).max(32),
  avatar: z.string().max(600_000).nullable().optional(),
  description: z.string().max(500).default(""),
});
export type AgentBody = z.infer<typeof AgentBodySchema>;

// —— E2E Task 2：公钥分发与明文重加密契约（设计 §3.1/§7）——

/**
 * 每设备公钥包：IK 双键（ECDH 密钥协商 + ECDSA 签名链）+ 签名预键 SPK。
 * base64(SPKI) P-256 实长 124 字符内、ECDSA 签名 DER→base64 128 字符内，
 * 上限 512 放足余量；spk.createdAt 为生成时刻（epoch ms，防 SPK 陈旧用）。
 * 首版不做 OPK：不设 opks 字段（带 opks 的请求体按未知键剥掉，见测试锁定）。
 */
export const E2eDeviceKeysSchema = z.object({
  ikEcdh: z.string().min(1).max(512),
  ikSign: z.string().min(1).max(512),
  spk: z.object({
    pub: z.string().min(1).max(512),
    sig: z.string().min(1).max(512),
    createdAt: z.number().int().min(0),
  }),
});
export type E2eDeviceKeys = z.infer<typeof E2eDeviceKeysSchema>;

/** PUT /api/e2e/keys：仅登记本人（userId 取自登录态，body 不含 userId）。 */
export const PutE2eKeysBodySchema = E2eDeviceKeysSchema;
export type PutE2eKeysBody = E2eDeviceKeys;

/** GET /api/e2e/keys 响应：{[userId]: devices[]}（登录可读全部用户设备公钥）。 */
export const E2eKeysResponseSchema = z.record(z.string(), z.array(E2eDeviceKeysSchema));
export type E2eKeysResponse = z.infer<typeof E2eKeysResponseSchema>;

/**
 * PUT /api/messages/:id/reencrypt：把本人 plain 消息原子重封为 e2e 信封（设计 §7）。
 * body 即目标信封——enc 恒为 "e2e"（plain 重封无意义 → 400），cipher 必带非空。
 */
export const ReencryptBodySchema = z.object({
  enc: z.literal("e2e"),
  cipher: z.string().min(1).max(262144),
  chainKid: z.string().max(64).optional(),
  n: z.number().int().min(0).optional(),
});
export type ReencryptBody = z.infer<typeof ReencryptBodySchema>;

// —— d.54 团队系统（去 IM）：名册、在线状态与动向摘要 ——

/** 动向类型：任务 / AI 对话 / 幕僚 / 日程里程碑 / 成员加入。 */
export const TeamActivityKindSchema = z.enum(["task", "agent", "staff", "agenda", "join"]);
export type TeamActivityKind = z.infer<typeof TeamActivityKindSchema>;

/** ISO 时间字符串（允许带毫秒）；只做可解析性校验，不锁定时区写法。 */
const IsoTimeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)), { message: "invalid timestamp" });

/**
 * 客户端上报的动向摘要。
 *
 * 白名单字段是刻意的：正文、提示词、工具参数、任务结果、日程证据都不在契约里，
 * 服务端无从接收，客户端也无处夹带。
 *
 * ★ `detail` / `status` 不是自由文本：对 task/agenda 两类，它们只能是**标题与状态摘要**
 *（服务端白名单见下方 `TASK_ACTIVITY_*` / `AGENDA_ACTIVITY_*`）。这样「不含正文」的
 * 隐私承诺不再只靠客户端自觉——客户端即使想夹带也过不了闸。
 */
const TeamActivityBaseSchema = z.object({
  kind: TeamActivityKindSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
  status: z.string().max(40).optional(),
  /** 客户端确定性幂等键：同一 actor 下重复上报只入一条。 */
  sourceId: z.string().min(1).max(200),
  occurredAt: IsoTimeSchema,
});
export type TeamActivityInput = z.infer<typeof TeamActivityBaseSchema>;

/** 任务摘要的合法 detail（与 `lib/team/share.ts` 的 `TASK_STATUS_LABEL` 一字不差）。 */
const TASK_ACTIVITY_DETAILS = new Set([
  "任务 · 进行中",
  "任务 · 已完成",
  "任务 · 失败",
  "任务 · 已中断",
]);
/** 任务摘要的合法 status。 */
const TASK_ACTIVITY_STATUSES = new Set(["running", "done", "failed", "cancelled"]);
/** 日程摘要的合法 detail（与 `lib/team/share.ts` 的 `BUCKET_LABEL` 一字不差）。 */
const AGENDA_ACTIVITY_DETAILS = new Set([
  "日程 · 已逾期",
  "日程 · 今天到期",
  "日程 · 24 小时内到期",
]);
/** 日程摘要的合法 status。 */
const AGENDA_ACTIVITY_STATUSES = new Set(["overdue", "today", "next24h"]);

/** 摘要被拒时的统一中文文案（400 直接透给用户，不暴露字段路径）。 */
const ACTIVITY_SUMMARY_ONLY = "只接受标题与状态摘要";

/**
 * 写侧动向输入：`kind` 为 task / agenda 时，`detail` 与 `status` 只能取状态摘要白名单
 * （用精确集合而不是正则——正则容易放过「任务 · 进行中（正文…）」这类夹带）。
 * 其他 kind（agent / staff / join）保持自由文本现状。
 */
export const TeamActivityInputSchema = TeamActivityBaseSchema.superRefine((v, ctx) => {
  if (v.kind === "task") {
    if (v.detail !== undefined && !TASK_ACTIVITY_DETAILS.has(v.detail)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["detail"], message: ACTIVITY_SUMMARY_ONLY });
    }
    if (v.status !== undefined && !TASK_ACTIVITY_STATUSES.has(v.status)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: ACTIVITY_SUMMARY_ONLY });
    }
  } else if (v.kind === "agenda") {
    if (v.detail !== undefined && !AGENDA_ACTIVITY_DETAILS.has(v.detail)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["detail"], message: ACTIVITY_SUMMARY_ONLY });
    }
    if (v.status !== undefined && !AGENDA_ACTIVITY_STATUSES.has(v.status)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: ACTIVITY_SUMMARY_ONLY });
    }
  }
});

/**
 * 读侧动向（服务端输出）：**不套用上面那条写侧白名单**。
 *
 * 老库存里可能已经有收紧前写入的自由文本，读出来再校验只会让整条列表 500；
 * 展示层按 `status` 派生标签、不直出 `detail`（见 `lib/team/labels.ts`）。
 */
export const TeamActivitySchema = TeamActivityBaseSchema.extend({
  id: z.string().min(1),
  actorId: z.string().min(1),
  createdAt: IsoTimeSchema,
});
export type TeamActivity = z.infer<typeof TeamActivitySchema>;

export const CreateTeamActivitiesBodySchema = z.object({
  items: z.array(TeamActivityInputSchema).min(1).max(50),
});
export type CreateTeamActivitiesBody = z.infer<typeof CreateTeamActivitiesBodySchema>;

/** 名册成员：用户资料 + 最近活跃 + 当前是否在线（在线态只在服务端进程内，不落库）。 */
export const TeamMemberSchema = z.object({
  user: UserSchema,
  lastSeenAt: z.string().nullable(),
  online: z.boolean(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamRosterSchema = z.object({
  members: z.array(TeamMemberSchema),
  onlineCount: z.number().int().min(0),
});
export type TeamRoster = z.infer<typeof TeamRosterSchema>;

export const TeamActivityListSchema = z.object({
  activities: z.array(TeamActivitySchema),
});
export type TeamActivityList = z.infer<typeof TeamActivityListSchema>;

export const TeamActivityWriteResultSchema = z.object({
  inserted: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type TeamActivityWriteResult = z.infer<typeof TeamActivityWriteResultSchema>;

// —— ②-3 团队用量：白名单摘要的服务端聚合 ——
//
// 隐私红线与团队动向同口径：请求体里**只有**「自然日 / 模型名 / 连接名 / token 数 /
// 未上报轮数」五个维度——提示词、对话正文、工具参数、任务结果、文件都不在契约里，
// 客户端无从夹带，服务端也无处接收。响应里的全站排行只给聚合数与显示名，**不给明细**。

/**
 * 自然日键 `YYYY-MM-DD`：由客户端按**本地时区**算好，服务端不猜时区（跨时区口径不会劈叉）。
 * 形状之外还要过日历校验：`2026-13-01`、`2026-02-31` 这类滚月/滚日必须拒，
 * 否则服务端会静默把它当成另一天去聚合。
 */
const DayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid day key")
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number);
    const ms = Date.UTC(y, m - 1, d);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
  }, "invalid day key");

export const TeamUsageInputSchema = z.object({
  /** 自然日（本地日）。 */
  date: DayKeySchema,
  /** 模型名（供应商返回的原样名字）。 */
  model: z.string().min(1).max(120),
  /**
   * 该 (date, model) 的**已上报** token 合计。
   * `null` = 该日该模型一次都没上报（d.32 口径：未上报 ≠ 0）。
   */
  tokens: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  /** 未上报的轮数（与 tokens 同一维度）。 */
  unreported: z.number().int().min(0).max(1_000_000).default(0),
  /** 涉及的连接名（用户自命名，最多 5 个；超出由客户端先合并/截断）。 */
  connections: z.array(z.string().min(1).max(64)).max(5).default([]),
});
export type TeamUsageInput = z.infer<typeof TeamUsageInputSchema>;

/** 单次上报上限与团队动向一致（50 条）。 */
export const CreateTeamUsageBodySchema = z.object({
  items: z.array(TeamUsageInputSchema).min(1).max(50),
});
export type CreateTeamUsageBody = z.infer<typeof CreateTeamUsageBodySchema>;

export const TeamUsageWriteResultSchema = z.object({
  written: z.number().int().min(0),
  /** 服务端实际存的（去重后的）行数：同一 (actor,date,model) 重复上报不增加行。 */
  stored: z.number().int().min(0),
});
export type TeamUsageWriteResult = z.infer<typeof TeamUsageWriteResultSchema>;

/** `DELETE /api/team/usage/mine` 的响应：删除条数（0 也表示「现在确实没有你的行」）。 */
export const TeamUsageClearResultSchema = z.object({
  deleted: z.number().int().min(0),
});
export type TeamUsageClearResult = z.infer<typeof TeamUsageClearResultSchema>;

export const TeamUsageRangeSchema = z.enum(["7d", "30d"]);
export type TeamUsageRange = z.infer<typeof TeamUsageRangeSchema>;

/** 本人按模型的明细（含连接名快照；连接名是用户自命名的白名单字段）。 */
export const TeamUsageByModelSchema = z.object({
  model: z.string().min(1),
  tokens: z.number().int().min(0),
  unreported: z.number().int().min(0),
  connections: z.array(z.string()),
});
export type TeamUsageByModel = z.infer<typeof TeamUsageByModelSchema>;

export const TeamUsageByDaySchema = z.object({
  date: z.string().min(1),
  tokens: z.number().int().min(0),
  unreported: z.number().int().min(0),
});
export type TeamUsageByDay = z.infer<typeof TeamUsageByDaySchema>;

export const TeamUsageSelfSchema = z.object({
  total: z.number().int().min(0),
  unreported: z.number().int().min(0),
  byModel: z.array(TeamUsageByModelSchema),
  byDay: z.array(TeamUsageByDaySchema),
});
export type TeamUsageSelf = z.infer<typeof TeamUsageSelfSchema>;

/** 全站排行一行：**只有聚合数与显示名**（连模型名都不给，避免反推明细）。 */
export const TeamUsageRankRowSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  tokens: z.number().int().min(0),
  unreported: z.number().int().min(0),
  /** 有数据的天数（不是条数）。 */
  days: z.number().int().min(0),
});
export type TeamUsageRankRow = z.infer<typeof TeamUsageRankRowSchema>;

export const TeamUsageResponseSchema = z.object({
  range: TeamUsageRangeSchema,
  /** 区间（自然日闭区间，YYYY-MM-DD）。 */
  from: z.string().min(1),
  to: z.string().min(1),
  self: TeamUsageSelfSchema,
  ranking: z.array(TeamUsageRankRowSchema),
});
export type TeamUsageResponse = z.infer<typeof TeamUsageResponseSchema>;

// ══════════════════════════════════════════════════════════════════════
// 团队工作台（d.92）：用户自建团队 / 目标 / 方案 / 任务
// ══════════════════════════════════════════════════════════════════════
//
// 与「全站名册」是两层东西：
// - 现有 TeamRoster/TeamActivity 仍描述「全站一个团队」的名册与动向摘要；
// - 这里的 WorkspaceTeam 是用户自建的工作组：有名字、目标、方案与任务，
//   成员由 owner 按用户名拉进来（不做公开邀请链接，不公开注册）。
//
// 智能体接口预留：所有写操作都走 REST（带用户 token），能力提供者 `team_*`
// 走同一套 API——权限判定只有服务端一处（是否成员 / 是否 owner）。

export const TeamItemStatusSchema = z.enum(["todo", "doing", "done", "blocked"]);
export type TeamItemStatus = z.infer<typeof TeamItemStatusSchema>;

export const TeamMemberRoleSchema = z.enum(["owner", "member"]);
export type TeamMemberRole = z.infer<typeof TeamMemberRoleSchema>;

export const WorkspaceTeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  /** 团队目标（自由文本；空串 = 还没写）。 */
  goal: z.string().max(500),
  ownerId: z.string().min(1),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type WorkspaceTeam = z.infer<typeof WorkspaceTeamSchema>;

export const TeamPlanItemSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  title: z.string().min(1).max(120),
  detail: z.string().max(2000),
  status: TeamItemStatusSchema,
  /** 排序值（小的在前；同值按 createdAt）。 */
  orderIndex: z.number().int().min(0).max(9999),
  createdBy: z.string().min(1),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type TeamPlanItem = z.infer<typeof TeamPlanItemSchema>;

export const TeamTaskSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  /** 归属方案项；null = 独立任务。 */
  planId: z.string().nullable(),
  title: z.string().min(1).max(120),
  detail: z.string().max(2000),
  /** 指给谁做（必须是团队成员）；null = 待认领。 */
  assigneeId: z.string().nullable(),
  status: TeamItemStatusSchema,
  createdBy: z.string().min(1),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  /** 截止时间（ISO）；null = 没定。 */
  dueAt: z.string().nullable(),
  /** 任务交付物引用共享文件库里的文件 id；null = 还没有上传。 */
  attachmentFileId: z.string().nullable(),
});
export type TeamTask = z.infer<typeof TeamTaskSchema>;

export const WorkspaceTeamMemberSchema = z.object({
  user: UserSchema,
  role: TeamMemberRoleSchema,
  joinedAt: IsoTimeSchema,
});
export type WorkspaceTeamMember = z.infer<typeof WorkspaceTeamMemberSchema>;

/** 一个团队的完整工作台快照（成员 + 方案 + 任务；任务/方案按时间正序，方案再按 orderIndex）。 */
export const TeamWorkspaceSnapshotSchema = z.object({
  team: WorkspaceTeamSchema,
  members: z.array(WorkspaceTeamMemberSchema),
  plans: z.array(TeamPlanItemSchema),
  tasks: z.array(TeamTaskSchema),
});
export type TeamWorkspaceSnapshot = z.infer<typeof TeamWorkspaceSnapshotSchema>;

export const WorkspaceTeamListSchema = z.object({
  teams: z.array(WorkspaceTeamSchema),
});
export type WorkspaceTeamList = z.infer<typeof WorkspaceTeamListSchema>;

export const CreateWorkspaceTeamBodySchema = z.object({
  name: z.string().trim().min(1, "请填写团队名称").max(40, "团队名称最多 40 字"),
  goal: z.string().trim().max(500, "目标最多 500 字").optional(),
});
export type CreateWorkspaceTeamBody = z.infer<typeof CreateWorkspaceTeamBodySchema>;

export const UpdateWorkspaceTeamBodySchema = z
  .object({
    name: z.string().trim().min(1, "团队名称不能为空").max(40, "团队名称最多 40 字").optional(),
    goal: z.string().trim().max(500, "目标最多 500 字").optional(),
  })
  .refine((v) => v.name !== undefined || v.goal !== undefined, { message: "没有要修改的字段" });
export type UpdateWorkspaceTeamBody = z.infer<typeof UpdateWorkspaceTeamBodySchema>;

export const AddTeamMemberBodySchema = z.object({
  username: z.string().trim().min(1, "请填写用户名").max(64, "用户名过长"),
});
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;

export const CreateTeamPlanBodySchema = z.object({
  title: z.string().trim().min(1, "请填写方案标题").max(120, "标题最多 120 字"),
  detail: z.string().trim().max(2000, "说明最多 2000 字").optional(),
  orderIndex: z.number().int().min(0).max(9999).optional(),
});
export type CreateTeamPlanBody = z.infer<typeof CreateTeamPlanBodySchema>;

export const UpdateTeamPlanBodySchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(120, "标题最多 120 字").optional(),
    detail: z.string().trim().max(2000, "说明最多 2000 字").optional(),
    status: TeamItemStatusSchema.optional(),
    orderIndex: z.number().int().min(0).max(9999).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.detail !== undefined ||
      v.status !== undefined ||
      v.orderIndex !== undefined,
    { message: "没有要修改的字段" },
  );
export type UpdateTeamPlanBody = z.infer<typeof UpdateTeamPlanBodySchema>;

export const CreateTeamTaskBodySchema = z.object({
  title: z.string().trim().min(1, "请填写任务标题").max(120, "标题最多 120 字"),
  detail: z.string().trim().max(2000, "说明最多 2000 字").optional(),
  planId: z.string().trim().min(1).nullable().optional(),
  assigneeId: z.string().trim().min(1).nullable().optional(),
  dueAt: IsoTimeSchema.nullable().optional(),
  /** 交付物（共享文件库里的文件 id）；与 PATCH 的 `attachmentFileId` 同口径。 */
  attachmentFileId: z.string().trim().min(1).nullable().optional(),
});
export type CreateTeamTaskBody = z.infer<typeof CreateTeamTaskBodySchema>;

export const UpdateTeamTaskBodySchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(120, "标题最多 120 字").optional(),
    detail: z.string().trim().max(2000, "说明最多 2000 字").optional(),
    planId: z.string().trim().min(1).nullable().optional(),
    assigneeId: z.string().trim().min(1).nullable().optional(),
    status: TeamItemStatusSchema.optional(),
    dueAt: IsoTimeSchema.nullable().optional(),
    attachmentFileId: z.string().trim().min(1).nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.detail !== undefined ||
      v.planId !== undefined ||
      v.assigneeId !== undefined ||
      v.status !== undefined ||
      v.dueAt !== undefined ||
      v.attachmentFileId !== undefined,
    { message: "没有要修改的字段" },
  );
export type UpdateTeamTaskBody = z.infer<typeof UpdateTeamTaskBodySchema>;
