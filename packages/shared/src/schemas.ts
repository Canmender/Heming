import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(32),
  displayName: z.string().min(1).max(64),
  // data URL base64 头像，与 UpdateProfileBodySchema.avatar 同上限（约 450KB 图片）
  avatar: z.string().max(600_000).optional(),
});
export type User = z.infer<typeof UserSchema>;

export const MessagePayloadSchema = z.object({ text: z.string().max(20000) });
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  senderType: z.enum(["user", "agent"]),
  senderId: z.string().min(1),
  payload: MessagePayloadSchema,
  replyTo: z.string().nullable(),
  createdAt: z.string(),
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
]);
export type WsClientEvent = z.infer<typeof WsClientEventSchema>;

export const WsServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_new"), message: MessageSchema }),
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
