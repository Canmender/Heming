import { describe, it, expect } from "vitest";
import {
  WsClientEventSchema,
  WsServerEventSchema,
  MessageSchema,
  RegisterBodySchema,
  LoginBodySchema,
  CreateFileBodySchema,
  UpdateProfileBodySchema,
  UserSchema,
  ConversationSchema,
  CreateConversationBodySchema,
  ReadStateSchema,
  MemberSchema,
} from "./schemas.js";

describe("WsClientEventSchema", () => {
  it("接受合法 send_message", () => {
    const r = WsClientEventSchema.safeParse({
      type: "send_message",
      conversationId: "c1",
      payload: { text: "你好" },
    });
    expect(r.success).toBe(true);
  });
  it("拒绝缺 conversationId 的 send_message", () => {
    const r = WsClientEventSchema.safeParse({
      type: "send_message",
      payload: { text: "x" },
    });
    expect(r.success).toBe(false);
  });
  it("拒绝未知事件类型", () => {
    expect(WsClientEventSchema.safeParse({ type: "hack" }).success).toBe(false);
  });
});

describe("MessageSchema", () => {
  it("要求 replyTo 字段可为 null", () => {
    const r = MessageSchema.safeParse({
      id: "m1",
      conversationId: "c1",
      senderType: "user",
      senderId: "u1",
      payload: { text: "hi" },
      replyTo: null,
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });
  it("拒绝非法 senderType", () => {
    const r = MessageSchema.safeParse({
      id: "m1",
      conversationId: "c1",
      senderType: "bot",
      senderId: "u1",
      payload: { text: "hi" },
      replyTo: null,
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});

describe("WsServerEventSchema", () => {
  it("接受 message_new", () => {
    const r = WsServerEventSchema.safeParse({
      type: "message_new",
      message: {
        id: "m1",
        conversationId: "c1",
        senderType: "user",
        senderId: "u1",
        payload: { text: "hi" },
        replyTo: null,
        createdAt: "2026-10-13T00:00:00.000Z",
      },
    });
    expect(r.success).toBe(true);
  });
});

describe("RegisterBodySchema", () => {
  it("username 至少 3 字符", () => {
    expect(RegisterBodySchema.safeParse({ username: "ab", password: "p123456", displayName: "甲" }).success).toBe(false);
    expect(RegisterBodySchema.safeParse({ username: "abc", password: "p123456", displayName: "甲" }).success).toBe(true);
  });
});

describe("LoginBodySchema", () => {
  it("登录端不规定密码策略：短密码（播种账号 admin/admin）body 合法", () => {
    expect(LoginBodySchema.safeParse({ username: "admin", password: "admin" }).success).toBe(true);
    expect(LoginBodySchema.safeParse({ username: "admin", password: "a" }).success).toBe(true);
  });

  it("仍拒绝空密码", () => {
    expect(LoginBodySchema.safeParse({ username: "admin", password: "" }).success).toBe(false);
  });
});

describe("CreateFileBodySchema", () => {
  it("接受合法上传体", () => {
    expect(
      CreateFileBodySchema.safeParse({ name: "a.txt", mime: "text/plain", contentBase64: "aGk=" }).success,
    ).toBe(true);
  });
  it("拒绝超长文件名", () => {
    expect(
      CreateFileBodySchema.safeParse({ name: "x".repeat(256), mime: "text/plain", contentBase64: "aGk=" })
        .success,
    ).toBe(false);
  });
});

describe("UpdateProfileBodySchema", () => {
  it("接受 displayName + data URL avatar", () => {
    const r = UpdateProfileBodySchema.safeParse({
      displayName: "和鸣",
      avatar: `data:image/png;base64,${"A".repeat(64)}`,
    });
    expect(r.success).toBe(true);
  });

  it("接受仅 displayName（avatar 可省略）", () => {
    expect(UpdateProfileBodySchema.safeParse({ displayName: "Alice" }).success).toBe(true);
  });

  it("拒绝空 displayName", () => {
    expect(UpdateProfileBodySchema.safeParse({ displayName: "" }).success).toBe(false);
  });

  it("拒绝超 64 字 displayName", () => {
    expect(UpdateProfileBodySchema.safeParse({ displayName: "名".repeat(65) }).success).toBe(false);
  });

  it("拒绝超 600_000 字符的 avatar", () => {
    const r = UpdateProfileBodySchema.safeParse({
      displayName: "Alice",
      avatar: "x".repeat(600_001),
    });
    expect(r.success).toBe(false);
  });
});

describe("UserSchema.avatar", () => {
  it("接受存入 data URL 头像的 User（与 UpdateProfileBody 上限一致）", () => {
    const r = UserSchema.safeParse({
      id: "u1",
      username: "alice",
      displayName: "Alice",
      avatar: `data:image/png;base64,${"A".repeat(1000)}`,
    });
    expect(r.success).toBe(true);
  });
});

describe("M2 schemas", () => {
  it("接受 direct 会话（含 unreadCount）", () => {
    expect(ConversationSchema.safeParse({
      id: "c1", type: "direct", unreadCount: 3,
      peer: { id: "u1", username: "alice", displayName: "爱丽丝" },
    }).success).toBe(true);
  });
  it("接受 group 会话", () => {
    expect(ConversationSchema.safeParse({
      id: "g1", type: "group", name: "评审组", memberCount: 4, unreadCount: 0,
    }).success).toBe(true);
  });
  it("拒绝缺 name 的 group", () => {
    expect(ConversationSchema.safeParse({ id: "g1", type: "group", memberCount: 4, unreadCount: 0 }).success).toBe(false);
  });
  it("memberCount 边界（min(1) 口径）：0 拒绝、1 接受", () => {
    expect(
      ConversationSchema.safeParse({ id: "g1", type: "group", name: "单人群", memberCount: 0, unreadCount: 0 })
        .success,
    ).toBe(false);
    expect(
      ConversationSchema.safeParse({ id: "g1", type: "group", name: "单人群", memberCount: 1, unreadCount: 0 })
        .success,
    ).toBe(true);
  });
  it("建会话 body 二选一（peerId 或 name+memberIds）", () => {
    expect(CreateConversationBodySchema.safeParse({ peerId: "u1" }).success).toBe(true);
    expect(CreateConversationBodySchema.safeParse({ name: "群", memberIds: ["u1"] }).success).toBe(true);
    expect(CreateConversationBodySchema.safeParse({ name: "群", memberIds: [] }).success).toBe(true);
    expect(CreateConversationBodySchema.safeParse({}).success).toBe(false);
  });
  it("ReadState 与 Member", () => {
    expect(ReadStateSchema.safeParse({ userId: "u1", at: "2026-10-14T00:00:00.000Z" }).success).toBe(true);
    expect(MemberSchema.safeParse({
      kind: "agent", id: "a1", name: "和小鸣", avatar: null, user: null,
    }).success).toBe(true);
    expect(MemberSchema.safeParse({
      kind: "user", id: "u1", name: "张三", avatar: null,
      user: { id: "u1", username: "zhang", displayName: "张三" },
    }).success).toBe(true);
  });
});
