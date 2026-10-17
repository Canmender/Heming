import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(32),
  displayName: z.string().min(1).max(64),
  // data URL base64 头像，与 UpdateProfileBodySchema.avatar 同上限（约 450KB 图片）
  avatar: z.string().max(600_000).optional(),
});
export type User = z.infer<typeof UserSchema>;

export const MessagePayloadSchema = z.object({
  // 上限 20000：与 agent_finish.text 对齐（agent 回复经 finish 直接入库，两处不齐会「入库即违规」）
  text: z.string().max(20000),
  // 单条消息 mentions 上限：@ 选择器为人工点选，50 已远超一屏；防契约无限扩张
  mentions: z
    .array(z.object({ agentId: z.string().min(1), name: z.string().min(1).max(64) }))
    .max(50)
    .optional(),
  // 消息附件（M4 前置）：引用共享库文件；text 可空串（纯附件消息）
  file: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1).max(255),
      mime: z.string().min(1).max(128),
      size: z.number().int().min(0),
    })
    .optional(),
  // 转发来源（二期 IM Task 4）：发送者展示名 + 源会话名；转发时剥离 mentions、保留 text/file
  forward: z
    .object({ from: z.string().min(1).max(64), source: z.string().min(1).max(64) })
    .optional(),
  // 表情回应（二期 IM Task 6）：每条目一个 emoji + 参与该 emoji 的 userIds。
  // emoji 上限 16（多码位组合 emoji 留余量）；种类上限 20（UI 浮排 12 个常用，仍留余量）；
  // userIds 由服务端 toggle 维护（不去重上限），schema 上限 500 防单条 payload 炸库。
  reactions: z
    .array(
      z.object({
        emoji: z.string().min(1).max(16),
        userIds: z.array(z.string().min(1)).max(500),
      }),
    )
    .max(20)
    .optional(),
});
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  senderType: z.enum(["user", "agent"]),
  senderId: z.string().min(1),
  payload: MessagePayloadSchema,
  replyTo: z.string().nullable(),
  createdAt: z.string(),
  // 撤回时间（ISO）；null=未撤回。恒有字段（双端同步后缺字段即契约违规）
  recalledAt: z.string().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const WsClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send_message"),
    conversationId: z.string().min(1),
    payload: MessagePayloadSchema,
    replyTo: z.string().optional(),
  }),
  z.object({
    type: z.literal("mark_read"),
    conversationId: z.string().min(1),
  }),
  // 消息撤回（仅发送者本人可撤；服务端校验后广播 message_recalled）
  z.object({
    type: z.literal("recall_message"),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  // 表情回应（二期 IM Task 6）：toggle 语义——服务端按 (messageId, userId, emoji) 加/删，
  // 结果经 message_updated 广播整条消息。emoji 上限与 payload.reactions 单个条目对齐。
  z.object({
    type: z.literal("react_message"),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1).max(16),
  }),
  z.object({
    type: z.literal("agent_chunk"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    text: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal("agent_finish"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    // 与 MessagePayloadSchema.text 同上限：finish 文本直接入 messages.payload（不改写），
    // 宽于 payload 会出现「schema 过了、入库即违规」的缝
    text: z.string().max(20000),
    replyTo: z.string().optional(),
  }),
  // 双向事件（设计 §3）：客户端上报流失败（aborted/provider_error），服务端回 forbidden。
  // 形状与 WsServerEventSchema 的 agent_error 成员一致（同构复用，见 ws.ts）。
  z.object({
    type: z.literal("agent_error"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1).max(1000),
  }),
]);
export type WsClientEvent = z.infer<typeof WsClientEventSchema>;

export const WsServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_new"),
    message: MessageSchema,
    streamId: z.string().optional(),
  }),
  z.object({
    type: z.literal("read_update"),
    conversationId: z.string().min(1),
    userId: z.string().min(1),
    at: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  // 撤回广播：消息不移除，接收端按 messageId 置 recalledAt（at = 撤回时间）
  z.object({
    type: z.literal("message_recalled"),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    at: z.string(),
  }),
  // 表情回应广播（二期 IM Task 6）：整条消息替换（接收端按 message.id 覆盖本地同 id 条目）
  z.object({
    type: z.literal("message_updated"),
    message: MessageSchema,
  }),
  z.object({
    type: z.literal("agent_chunk"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    text: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal("agent_error"),
    conversationId: z.string().min(1),
    agentId: z.string().min(1),
    streamId: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1).max(1000),
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

export const ConversationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("direct"),
    id: z.string().min(1),
    peer: UserSchema,
    unreadCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("group"),
    id: z.string().min(1),
    name: z.string().min(1).max(64),
    // 口径裁决（计划 Task 4 写死）：memberIds 允许空数组（单人群，creator 自动入群）→ memberCount 下限 1
    memberCount: z.number().int().min(1),
    unreadCount: z.number().int().min(0),
  }),
]);
export type Conversation = z.infer<typeof ConversationSchema>;

export const DirectConversationBodySchema = z.object({ peerId: z.string().min(1) });
export const GroupConversationBodySchema = z.object({
  name: z.string().min(1).max(32),
  memberIds: z.array(z.string().min(1)).max(200),
});
export const CreateConversationBodySchema = z.union([
  DirectConversationBodySchema,
  GroupConversationBodySchema,
]);

export const ReadStateSchema = z.object({ userId: z.string().min(1), at: z.string() });
export type ReadState = z.infer<typeof ReadStateSchema>;
export const ReadStateListSchema = z.array(ReadStateSchema);

export const MemberSchema = z.object({
  kind: z.enum(["user", "agent"]),
  id: z.string().min(1),
  name: z.string().min(1),
  avatar: z.string().max(600_000).nullable(),
  user: UserSchema.nullable(),
});
export type Member = z.infer<typeof MemberSchema>;

export const CreateFriendRequestBodySchema = z.object({ username: z.string().min(3).max(32) });

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

export const AgentSchema = z.object({
  id: z.string().min(1),
  owner_id: z.string().nullable(),
  name: z.string().min(1).max(32),
  avatar: z.string().max(600_000).nullable(),
  description: z.string().max(500),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentBodySchema = z.object({
  name: z.string().min(1).max(32),
  avatar: z.string().max(600_000).nullable().optional(),
  description: z.string().max(500).default(""),
});
export type AgentBody = z.infer<typeof AgentBodySchema>;

/** POST /api/conversations/:id/agents：把名册 agent 挂到会话（幂等由服务端语义保证）。 */
export const AttachAgentBodySchema = z.object({ agentId: z.string().min(1) });
export type AttachAgentBody = z.infer<typeof AttachAgentBodySchema>;
