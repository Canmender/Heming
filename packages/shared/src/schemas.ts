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
 */
export const TeamActivityInputSchema = z.object({
  kind: TeamActivityKindSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
  status: z.string().max(40).optional(),
  /** 客户端确定性幂等键：同一 actor 下重复上报只入一条。 */
  sourceId: z.string().min(1).max(200),
  occurredAt: IsoTimeSchema,
});
export type TeamActivityInput = z.infer<typeof TeamActivityInputSchema>;

export const TeamActivitySchema = TeamActivityInputSchema.extend({
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
