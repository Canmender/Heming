import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(32),
  displayName: z.string().min(1).max(64),
  avatar: z.string().max(512).optional(),
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
  password: z.string().min(6).max(128),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const CreateConversationBodySchema = z.object({ peerId: z.string().min(1) });
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
