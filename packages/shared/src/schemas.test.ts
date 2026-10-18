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
  E2eDeviceKeysSchema,
  ReencryptBodySchema,
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
      recalledAt: null,
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
      recalledAt: null,
    });
    expect(r.success).toBe(false);
  });
  it("recall_message / message_recalled 事件形状", () => {
    expect(WsClientEventSchema.safeParse({ type: "recall_message", conversationId: "c1", messageId: "m1" }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ type: "recall_message", conversationId: "c1" }).success).toBe(false);
    expect(
      WsServerEventSchema.safeParse({
        type: "message_recalled", conversationId: "c1", messageId: "m1", at: "2026-10-17T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
  it("Message 恒有 recalledAt（null 或 ISO）", () => {
    expect(MessageSchema.safeParse({
      id: "m1", conversationId: "c1", senderType: "user", senderId: "u1",
      payload: { text: "hi" }, replyTo: null, createdAt: "2026-10-17T00:00:00.000Z", recalledAt: null,
    }).success).toBe(true);
    // 缺 recalledAt 应失败（同步双端后新契约）
    expect(MessageSchema.safeParse({
      id: "m1", conversationId: "c1", senderType: "user", senderId: "u1",
      payload: { text: "hi" }, replyTo: null, createdAt: "2026-10-17T00:00:00.000Z",
    }).success).toBe(false);
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
        recalledAt: null,
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

  // E2E Task 5：附件密钥随消息进密文（PlainEnvelope.file.key 已预留，schema 同步收口）
  it("MessagePayload.file.key 可选且被保留（解密渲染的密钥载体）", () => {
    const key = "A".repeat(44); // 32B base64 = 44 字符
    const r = MessagePayloadSchema.safeParse({
      text: "",
      file: { id: "f1", name: "a.png", mime: "image/png", size: 12, key },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.file?.key).toBe(key); // parse 后不得被 strip 掉
  });

  it("MessagePayload.file.key 空串/超长拒绝（非密钥形状不入库）", () => {
    const base = { id: "f1", name: "a.png", mime: "image/png", size: 12 };
    expect(
      MessagePayloadSchema.safeParse({ text: "", file: { ...base, key: "" } }).success,
    ).toBe(false);
    expect(
      MessagePayloadSchema.safeParse({ text: "", file: { ...base, key: "k".repeat(129) } })
        .success,
    ).toBe(false);
  });
});

describe("MessagePayloadSchema forward（二期 IM Task 4 消息转发）", () => {
  it("payload.forward 可选且限长", () => {
    expect(MessagePayloadSchema.safeParse({ text: "x", forward: { from: "甲", source: "群A" } }).success).toBe(true);
    expect(MessagePayloadSchema.safeParse({ text: "x", forward: { from: "甲", source: "s".repeat(65) } }).success).toBe(false);
  });
});

describe("MessagePayloadSchema reactions（二期 IM Task 6 表情回应）", () => {
  it("payload.reactions 形状", () => {
    expect(
      MessagePayloadSchema.safeParse({ text: "x", reactions: [{ emoji: "👍", userIds: ["u1"] }] })
        .success,
    ).toBe(true);
    expect(
      MessagePayloadSchema.safeParse({ text: "x", reactions: [{ emoji: "👍".repeat(17), userIds: [] }] })
        .success,
    ).toBe(false);
  });
  it("reactions 数组上限 20 种、userIds 上限 500", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ emoji: `e${i}`, userIds: ["u1"] }));
    expect(MessagePayloadSchema.safeParse({ text: "x", reactions: mk(20) }).success).toBe(true);
    expect(MessagePayloadSchema.safeParse({ text: "x", reactions: mk(21) }).success).toBe(false);
    expect(
      MessagePayloadSchema.safeParse({
        text: "x",
        reactions: [{ emoji: "👍", userIds: Array.from({ length: 500 }, (_, i) => `u${i}`) }],
      }).success,
    ).toBe(true);
    expect(
      MessagePayloadSchema.safeParse({
        text: "x",
        reactions: [{ emoji: "👍", userIds: Array.from({ length: 501 }, (_, i) => `u${i}`) }],
      }).success,
    ).toBe(false);
  });
  it("react_message 已废（E2E Task 2）：客户端事件拒收；message_updated 服务端广播已随 E2E 事件化移除", () => {
    // 回应改为 e2e 信封消息（kind=reaction，设计 §4）：react_message 客户端事件从契约移除，
    // 服务端对旧客户端发来的该事件应回 bad_event（parse 失败）。message_updated 服务端广播
    // 亦无生产者（回应事件化后），随 E2E 收尾一并从 WsServerEventSchema 删除。
    expect(
      WsClientEventSchema.safeParse({ type: "react_message", conversationId: "c1", messageId: "m1", emoji: "👍" })
        .success,
    ).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ type: "react_message", conversationId: "c1", messageId: "m1" }).success,
    ).toBe(false);
    expect(
      WsServerEventSchema.safeParse({
        type: "message_updated",
        message: {
          id: "m1",
          conversationId: "c1",
          senderType: "user",
          senderId: "u1",
          payload: { text: "x", reactions: [{ emoji: "👍", userIds: ["u2"] }] },
          replyTo: null,
          createdAt: "2026-10-17T00:00:00.000Z",
          recalledAt: null,
        },
      }).success,
    ).toBe(false);
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
      message: { id: "m1", conversationId: "c1", senderType: "agent", senderId: "a1", payload: { text: "你好", mentions: [{ agentId: "a1", name: "和小鸣" }] }, replyTo: null, createdAt: "2026-10-16T00:00:00.000Z", recalledAt: null },
      streamId: "s1",
    });
    expect(mn.success).toBe(true);
  });
});

// —— E2E Task 2：信封契约（Message/send_message 双形态 + superRefine 边界）——

describe("MessageSchema 信封字段（E2E Task 2）", () => {
  const base = {
    id: "m1",
    conversationId: "c1",
    senderType: "user",
    senderId: "u1",
    payload: { text: "hi" },
    replyTo: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    recalledAt: null,
  };

  it("存量 JSON 无 enc → default 按 plain（双端同步兼容锁定）", () => {
    const r = MessageSchema.safeParse({ ...base });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.enc).toBe("plain");
  });

  it("enc 枚举：plain/e2e 接受，其余拒", () => {
    expect(MessageSchema.safeParse({ ...base, enc: "plain" }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e" }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...base, enc: "cipher" }).success).toBe(false);
  });

  it("e2e 信封字段往返（cipher/chainKid/n）", () => {
    const r = MessageSchema.safeParse({
      ...base,
      enc: "e2e",
      cipher: "Q2lwaGVyZGF0YQ==",
      chainKid: "kid-fingerprint",
      n: 7,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.enc).toBe("e2e");
      expect(r.data.cipher).toBe("Q2lwaGVyZGF0YQ==");
      expect(r.data.chainKid).toBe("kid-fingerprint");
      expect(r.data.n).toBe(7);
    }
  });

  it("信封边界：cipher 262144 过 / 262145 拒；chainKid 64 过 / 65 拒；n 负数与非整数拒", () => {
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", cipher: "x".repeat(262144) }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", cipher: "x".repeat(262145) }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", chainKid: "k".repeat(64) }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", chainKid: "k".repeat(65) }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", n: 0 }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", n: -1 }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, enc: "e2e", n: 1.5 }).success).toBe(false);
  });
});

describe("WsClientEventSchema send_message 信封 superRefine（E2E Task 2）", () => {
  const send = (extra: Record<string, unknown>): unknown => ({
    type: "send_message",
    conversationId: "c1",
    payload: { text: "" },
    ...extra,
  });

  it("缺 enc → default plain（旧客户端直发兼容）", () => {
    const r = WsClientEventSchema.safeParse(send({}));
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "send_message") expect(r.data.enc).toBe("plain");
  });

  it("e2e 必带 cipher：缺失拒、空串拒、正常值过", () => {
    expect(WsClientEventSchema.safeParse(send({ enc: "e2e" })).success).toBe(false);
    expect(WsClientEventSchema.safeParse(send({ enc: "e2e", cipher: "" })).success).toBe(false);
    expect(WsClientEventSchema.safeParse(send({ enc: "e2e", cipher: "Q2lwaGVy" })).success).toBe(true);
  });

  it("e2e 可带 chainKid/n（可选公开元数据）", () => {
    expect(
      WsClientEventSchema.safeParse(send({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 3 })).success,
    ).toBe(true);
    expect(WsClientEventSchema.safeParse(send({ enc: "e2e", cipher: "Q2lwaGVy", n: -1 })).success).toBe(false);
  });

  it("plain 必不带 cipher：带 cipher 拒；不带 enc/cipher 的纯明文照旧过", () => {
    expect(WsClientEventSchema.safeParse(send({ cipher: "Q2lwaGVy" })).success).toBe(false);
    expect(WsClientEventSchema.safeParse(send({ enc: "plain", cipher: "Q2lwaGVy" })).success).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ type: "send_message", conversationId: "c1", payload: { text: "你好" } })
        .success,
    ).toBe(true);
  });

  it("cipher 超 262144 拒（e2e 路径长度上限）", () => {
    expect(WsClientEventSchema.safeParse(send({ enc: "e2e", cipher: "x".repeat(262145) })).success).toBe(false);
    expect(WsClientEventSchema.safeParse(send({ enc: "e2e", cipher: "x".repeat(262144) })).success).toBe(true);
  });
});

// —— E2E Task 2：公钥分发与重加密 body 契约 ——

describe("E2eDeviceKeysSchema / PUT /api/e2e/keys body", () => {
  const device = {
    ikEcdh: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    ikSign: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAF",
    spk: { pub: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE", sig: "MEUCIQDx", createdAt: 1760659200000 },
  };

  it("双公钥 + spk 往返（首版无 opks 字段也能过——多余键被 Zod 剥掉而非拒）", () => {
    const r = E2eDeviceKeysSchema.safeParse(device);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.spk.createdAt).toBe(1760659200000);
    // 带 opks 的旧形态请求体：剥掉未知键（YAGNI：服务端不落 OPK）
    const legacy = E2eDeviceKeysSchema.safeParse({ ...device, opks: [{ id: "o1", pub: "AA==" }] });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data).not.toHaveProperty("opks");
  });

  it("缺字段 / 空 base64 / 超长 base64 / 负 createdAt 拒", () => {
    expect(E2eDeviceKeysSchema.safeParse({ ...device, ikSign: undefined }).success).toBe(false);
    expect(E2eDeviceKeysSchema.safeParse({ ...device, ikEcdh: "" }).success).toBe(false);
    expect(E2eDeviceKeysSchema.safeParse({ ...device, ikEcdh: "A".repeat(513) }).success).toBe(false);
    expect(E2eDeviceKeysSchema.safeParse({ ...device, spk: { ...device.spk, sig: "A".repeat(513) } }).success).toBe(
      false,
    );
    expect(E2eDeviceKeysSchema.safeParse({ ...device, spk: { ...device.spk, createdAt: -1 } }).success).toBe(false);
    expect(E2eDeviceKeysSchema.safeParse({ ...device, spk: { pub: "AA==", sig: "BB==" } }).success).toBe(false);
  });
});

describe("ReencryptBodySchema（PUT /api/messages/:id/reencrypt）", () => {
  it("合法 e2e 信封：cipher 必填，chainKid/n 可选", () => {
    expect(ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "Q2lwaGVy" }).success).toBe(true);
    expect(
      ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 9 }).success,
    ).toBe(true);
  });

  it("enc 非 e2e / 空 cipher / cipher 超长 / n 负数 拒", () => {
    expect(ReencryptBodySchema.safeParse({ enc: "plain", cipher: "Q2lwaGVy" }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "" }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ enc: "e2e" }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "x".repeat(262145) }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "x", n: -1 }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ cipher: "Q2lwaGVy" }).success).toBe(false); // 缺 enc
  });
});

// —— E2E Task 4：agent 流式信封（chunk/finish 的 cipher 字段，设计 §5.3）——

describe("agent_chunk/agent_finish 信封（E2E Task 4）", () => {
  const chunkBase = { type: "agent_chunk", conversationId: "c1", agentId: "a1", streamId: "s1" };
  const finishBase = { type: "agent_finish", conversationId: "c1", agentId: "a1", streamId: "s1" };
  const sealed = { text: "", cipher: "Q2lwaGVy", chainKid: "k1", n: 0, index: 0 };

  it("密文 chunk：text 置空，cipher/chainKid/n/index 必带（缺一即拒）", () => {
    expect(WsClientEventSchema.safeParse({ ...chunkBase, ...sealed }).success).toBe(true);
    const { chainKid: _k, ...noKid } = sealed;
    const { n: _n, ...noN } = sealed;
    const { index: _i, ...noIndex } = sealed;
    expect(WsClientEventSchema.safeParse({ ...chunkBase, ...noKid }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...chunkBase, ...noN }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...chunkBase, ...noIndex }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...chunkBase, ...sealed, cipher: "" }).success).toBe(false);
  });

  it("密文 chunk 不得夹带明文 text（防明文泄漏）", () => {
    expect(WsClientEventSchema.safeParse({ ...chunkBase, ...sealed, text: "漏了" }).success).toBe(false);
  });

  it("明文 chunk（无 cipher）text 保持 min(1)：空串拒、非空过", () => {
    expect(WsClientEventSchema.safeParse({ ...chunkBase, text: "" }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...chunkBase, text: "你" }).success).toBe(true);
  });

  it("密文 finish：text 置空，cipher/chainKid/n 必带；夹明文或缺信封字段拒", () => {
    expect(
      WsClientEventSchema.safeParse({ ...finishBase, text: "", cipher: "Q2lwaGVy", chainKid: "k1", n: 0 })
        .success,
    ).toBe(true);
    expect(
      WsClientEventSchema.safeParse({ ...finishBase, text: "", cipher: "Q2lwaGVy", chainKid: "k1" }).success,
    ).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ ...finishBase, text: "", cipher: "Q2lwaGVy", n: 0 }).success,
    ).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ ...finishBase, text: "你好", cipher: "Q2lwaGVy", chainKid: "k1", n: 0 })
        .success,
    ).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ ...finishBase, text: "", cipher: "", chainKid: "k1", n: 0 }).success,
    ).toBe(false);
    // 明文 finish（无 cipher）行为不变：text 可空串（服务端 F2 层拒）
    expect(WsClientEventSchema.safeParse({ ...finishBase, text: "" }).success).toBe(true);
  });

  it("服务端 agent_chunk 广播可带信封字段（密文时 text 空串也过）", () => {
    expect(WsServerEventSchema.safeParse({ ...chunkBase, ...sealed }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ ...chunkBase, text: "" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ ...chunkBase, text: "你" }).success).toBe(true);
  });

  it("agent_error 信封（fix I2）：cipher/chainKid/n 可选，密文 message 置空且字段落输出", () => {
    const base = {
      type: "agent_error",
      conversationId: "c1",
      agentId: "a1",
      streamId: "s1",
      code: "provider_error",
    };
    // 明文 legacy：message min(1) 保持
    expect(WsClientEventSchema.safeParse({ ...base, message: "401 bad key" }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ ...base, message: "" }).success).toBe(false);
    // 密文：message 置空 + cipher/chainKid/n 落输出（缺一即拒、夹明文拒、空 cipher 拒）
    const sealed = WsClientEventSchema.safeParse({
      ...base,
      message: "",
      cipher: "Q2lwaGVy",
      chainKid: "k1",
      n: 0,
    });
    expect(sealed.success).toBe(true);
    if (sealed.success) {
      expect(sealed.data).toMatchObject({ cipher: "Q2lwaGVy", chainKid: "k1", n: 0, message: "" });
    }
    expect(
      WsClientEventSchema.safeParse({ ...base, message: "401", cipher: "Q2lwaGVy", chainKid: "k1", n: 0 })
        .success,
    ).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...base, message: "", cipher: "Q2lwaGVy", chainKid: "k1" }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...base, message: "", cipher: "Q2lwaGVy", n: 0 }).success).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ ...base, message: "", cipher: "", chainKid: "k1", n: 0 }).success,
    ).toBe(false);
    // 服务端广播面：密文形态放行（客户端 superRefine 已卡源头；服务端广播透传见 ws.test）
    expect(
      WsServerEventSchema.safeParse({ ...base, message: "", cipher: "Q2lwaGVy", chainKid: "k1", n: 0 })
        .success,
    ).toBe(true);
    expect(WsServerEventSchema.safeParse({ ...base, message: "401" }).success).toBe(true);
  });
});

describe("voice_call 契约", () => {
  it("接受合法 voice_call_invite", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_invite",
      conversationId: "c1",
      callId: "call-1",
      sdp: "v=0\r\no=- 123 2 IN IP4 0.0.0.0\r\n...",
    });
    expect(r.success).toBe(true);
  });

  it("拒绝缺 callId 的 voice_call_invite", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_invite",
      conversationId: "c1",
      sdp: "v=0",
    });
    expect(r.success).toBe(false);
  });

  it("接受合法 voice_call_accept", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_accept",
      conversationId: "c1",
      callId: "call-1",
      sdp: "v=0\r\no=- 456 2 IN IP4 0.0.0.0\r\n...",
    });
    expect(r.success).toBe(true);
  });

  it("接受合法 voice_call_reject（枚举 reason）", () => {
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "busy",
    }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "decline",
    }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "timeout",
    }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({
      type: "voice_call_reject", conversationId: "c1", callId: "call-1", reason: "other",
    }).success).toBe(false);
  });

  it("接受合法 voice_call_hangup", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_hangup",
      conversationId: "c1",
      callId: "call-1",
    });
    expect(r.success).toBe(true);
  });

  it("接受合法 voice_call_ice", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_ice",
      conversationId: "c1",
      callId: "call-1",
      candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
    });
    expect(r.success).toBe(true);
  });

  it("拒绝空 candidate 的 voice_call_ice", () => {
    const r = WsClientEventSchema.safeParse({
      type: "voice_call_ice",
      conversationId: "c1",
      callId: "call-1",
      candidate: "",
    });
    expect(r.success).toBe(false);
  });

  it("服务端事件镜像：voice_call_invite / accept / reject / hangup / ice 均可解析", () => {
    const base = { conversationId: "c1", callId: "call-1" };
    expect(WsServerEventSchema.safeParse({ type: "voice_call_invite", ...base, sdp: "v=0", fromUserId: "u1" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_accept", ...base, sdp: "v=0", fromUserId: "u2" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_reject", ...base, reason: "busy" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_hangup", ...base }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_ice", ...base, candidate: "c:1", fromUserId: "u1" }).success).toBe(true);
  });

  it("服务端 voice_call_invite / accept / ice 必带 fromUserId（Mesh 对端路由防伪造）", () => {
    const base = { conversationId: "c1", callId: "call-1" };
    expect(WsServerEventSchema.safeParse({ type: "voice_call_invite", ...base, sdp: "v=0" }).success).toBe(false);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_accept", ...base, sdp: "v=0" }).success).toBe(false);
    expect(WsServerEventSchema.safeParse({ type: "voice_call_ice", ...base, candidate: "c:1" }).success).toBe(false);
  });

  it("客户端 voice_call_invite / accept / ice 不带 fromUserId（带也被 strip）", () => {
    const base = { conversationId: "c1", callId: "call-1" };
    for (const type of ["voice_call_invite", "voice_call_accept", "voice_call_ice"] as const) {
      const r = WsClientEventSchema.safeParse({
        type,
        ...base,
        sdp: "v=0",
        candidate: "c:1",
        fromUserId: "spoofed",
      });
      expect(r.success).toBe(true);
      expect(r.success && (r.data as Record<string, unknown>).fromUserId).toBeUndefined();
    }
  });
});

