import { describe, it, expect } from "vitest";
import {
  AgentSchema,
  AgentBodySchema,
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
  MessagePayloadSchema,
  AttachAgentBodySchema,
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

describe("MessagePayloadSchema file 附件（M4 前置）", () => {
  it("MessagePayload 允许仅附件（text 空串）", () => {
    const r = MessagePayloadSchema.safeParse({
      text: "",
      file: { id: "f1", name: "a.png", mime: "image/png", size: 12 },
    });
    expect(r.success).toBe(true);
  });

  it("MessagePayload.file 缺 id 拒绝", () => {
    const r = MessagePayloadSchema.safeParse({
      text: "hi",
      file: { name: "a.png", mime: "image/png", size: 12 },
    });
    expect(r.success).toBe(false);
  });

  it("MessagePayload.file.size 负数拒绝", () => {
    const r = MessagePayloadSchema.safeParse({
      text: "hi",
      file: { id: "f1", name: "a.png", mime: "image/png", size: -1 },
    });
    expect(r.success).toBe(false);
  });
});

describe("M3 schemas", () => {
  it("Agent 名册（owner 可空）", () => {
    expect(AgentSchema.safeParse({ id: "a1", owner_id: null, name: "和小鸣", avatar: null, description: "" }).success).toBe(true);
    expect(AgentSchema.safeParse({ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "x" }).success).toBe(true);
    expect(AgentSchema.safeParse({ id: "a1", owner_id: null, name: "", avatar: null, description: "" }).success).toBe(false);
  });
  it("AgentBody 与 partial", () => {
    expect(AgentBodySchema.safeParse({ name: "文案" }).success).toBe(true);
    expect(AgentBodySchema.safeParse({ name: "" }).success).toBe(false);
    expect(AgentBodySchema.partial().safeParse({ description: "改简介" }).success).toBe(true);
  });
  it("payload 可带 mentions", () => {
    const r = WsClientEventSchema.safeParse({
      type: "send_message", conversationId: "c1",
      payload: { text: "@和小鸣 看下", mentions: [{ agentId: "a1", name: "和小鸣" }] },
    });
    expect(r.success).toBe(true);
  });
  it("agent_chunk / agent_finish 客户端事件", () => {
    expect(WsClientEventSchema.safeParse({ type: "agent_chunk", conversationId: "c1", agentId: "a1", streamId: "s1", text: "你" }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ type: "agent_finish", conversationId: "c1", agentId: "a1", streamId: "s1", text: "你好" }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ type: "agent_chunk", conversationId: "c1", agentId: "a1", streamId: "s1", text: "" }).success).toBe(false);
  });
  it("I4：finish.text 上限 20000 与 payload.text 对齐（20000 过 / 20001 拒）", () => {
    const atLimit = "x".repeat(20000);
    expect(WsClientEventSchema.safeParse({ type: "agent_finish", conversationId: "c1", agentId: "a1", streamId: "s1", text: atLimit }).success).toBe(true);
    expect(MessagePayloadSchema.safeParse({ text: atLimit }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ type: "agent_finish", conversationId: "c1", agentId: "a1", streamId: "s1", text: `${atLimit}x` }).success).toBe(false);
    expect(MessagePayloadSchema.safeParse({ text: `${atLimit}x` }).success).toBe(false);
  });
  it("I4：payload.mentions 上限 50（50 过 / 51 拒）", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ agentId: `a${i}`, name: `智能体${i}` }));
    expect(MessagePayloadSchema.safeParse({ text: "@x", mentions: mk(50) }).success).toBe(true);
    expect(MessagePayloadSchema.safeParse({ text: "@x", mentions: mk(51) }).success).toBe(false);
  });
  it("AttachAgentBodySchema（agentId 非空）", () => {
    expect(AttachAgentBodySchema.safeParse({ agentId: "a1" }).success).toBe(true);
    expect(AttachAgentBodySchema.safeParse({ agentId: "" }).success).toBe(false);
    expect(AttachAgentBodySchema.safeParse({}).success).toBe(false);
  });
  it("客户端 agent_error 双向事件（合法通过 / 空 code 拒绝）", () => {
    expect(
      WsClientEventSchema.safeParse({
        type: "agent_error", conversationId: "c1", agentId: "a1", streamId: "s1",
        code: "aborted", message: "用户中断",
      }).success,
    ).toBe(true);
    expect(
      WsClientEventSchema.safeParse({
        type: "agent_error", conversationId: "c1", agentId: "a1", streamId: "s1",
        code: "", message: "x",
      }).success,
    ).toBe(false);
  });
  it("服务端 agent_chunk / agent_error 与 message_new.streamId", () => {
    expect(WsServerEventSchema.safeParse({ type: "agent_chunk", conversationId: "c1", agentId: "a1", streamId: "s1", text: "你" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "agent_error", conversationId: "c1", agentId: "a1", streamId: "s1", code: "provider_error", message: "401" }).success).toBe(true);
    const mn = WsServerEventSchema.safeParse({
      type: "message_new",
      message: { id: "m1", conversationId: "c1", senderType: "agent", senderId: "a1", payload: { text: "你好", mentions: [{ agentId: "a1", name: "和小鸣" }] }, replyTo: null, createdAt: "2026-10-16T00:00:00.000Z" },
      streamId: "s1",
    });
    expect(mn.success).toBe(true);
  });
});
