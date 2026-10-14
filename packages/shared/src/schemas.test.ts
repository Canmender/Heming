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
