import { describe, it, expect } from "vitest";
import {
  WsClientEventSchema,
  WsServerEventSchema,
  MessageSchema,
  MessagePayloadSchema,
  ConversationSchema,
  AgentConversationBodySchema,
  UpdateConversationBodySchema,
  RegisterBodySchema,
  LoginBodySchema,
  CreateFileBodySchema,
  UpdateProfileBodySchema,
  UserSchema,
  AgentSchema,
  AgentBodySchema,
  E2eDeviceKeysSchema,
  ReencryptBodySchema,
  TeamActivityInputSchema,
  CreateTeamActivitiesBodySchema,
  CreateTeamTaskBodySchema,
  TeamRosterSchema,
  TeamActivityListSchema,
  TeamUsageInputSchema,
  CreateTeamUsageBodySchema,
  TeamUsageRangeSchema,
  TeamUsageResponseSchema,
  TeamUsageRankRowSchema,
  TeamUsageClearResultSchema,
} from "./schemas.js";

const iso = "2026-11-02T08:00:00.000Z";

const message = {
  id: "m1",
  conversationId: "c1",
  senderType: "user",
  senderId: "u1",
  payload: { text: "hi" },
  createdAt: iso,
};

describe("WsClientEventSchema", () => {
  it("接受合法 send_message（enc 缺省 plain）", () => {
    const r = WsClientEventSchema.safeParse({ type: "send_message", conversationId: "c1", payload: { text: "hi" } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.enc).toBe("plain");
  });

  it("拒绝缺 conversationId 的 send_message 与未知事件类型", () => {
    expect(WsClientEventSchema.safeParse({ type: "send_message", payload: { text: "hi" } }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("人类 IM 事件已删除：mark_read / typing / recall_message / voice_call_* 全部拒收", () => {
    for (const event of [
      { type: "mark_read", conversationId: "c1" },
      { type: "typing", conversationId: "c1" },
      { type: "recall_message", conversationId: "c1", messageId: "m1" },
      { type: "voice_call_invite", conversationId: "c1", callId: "x", sdp: "s" },
    ]) {
      expect(WsClientEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("auth 首帧：带 token 通过；缺/空/超长拒", () => {
    expect(WsClientEventSchema.safeParse({ type: "auth", token: "t" }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ type: "auth" }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ type: "auth", token: "" }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ type: "auth", token: "x".repeat(513) }).success).toBe(false);
  });
});

describe("Conversation 标题与多段会话字段（d.128）", () => {
  it("ConversationSchema.title 可选且 ≤80", () => {
    const base = {
      type: "agent" as const,
      id: "c1",
      agent: { id: "a1", owner_id: null, name: "助理", avatar: null, description: "" },
      unreadCount: 0,
    };
    expect(ConversationSchema.safeParse(base).success).toBe(true);
    expect(ConversationSchema.safeParse({ ...base, title: "周报整理" }).success).toBe(true);
    expect(ConversationSchema.safeParse({ ...base, title: "x".repeat(81) }).success).toBe(false);
  });

  it("AgentConversationBodySchema 支持 fresh/title；UpdateConversationBodySchema 只收 title", () => {
    expect(AgentConversationBodySchema.safeParse({ agentId: "a1" }).success).toBe(true);
    expect(AgentConversationBodySchema.safeParse({ agentId: "a1", fresh: true, title: "t" }).success).toBe(true);
    expect(AgentConversationBodySchema.safeParse({ agentId: "a1", fresh: "yes" }).success).toBe(false);
    expect(UpdateConversationBodySchema.safeParse({ title: "" }).success).toBe(true);
    expect(UpdateConversationBodySchema.safeParse({ title: "x".repeat(81) }).success).toBe(false);
    expect(UpdateConversationBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("MessageSchema", () => {
  it("接受最小消息；人类 IM 字段（replyTo/recalledAt）不在契约里", () => {
    const r = MessageSchema.safeParse(message);
    expect(r.success).toBe(true);
    expect("replyTo" in (r.success ? r.data : {})).toBe(false);
    expect("recalledAt" in (r.success ? r.data : {})).toBe(false);
  });

  it("拒绝非法 senderType", () => {
    expect(MessageSchema.safeParse({ ...message, senderType: "bot" }).success).toBe(false);
  });

  it("信封字段：无 enc 按 plain；e2e 往返 cipher/chainKid/n", () => {
    const plain = MessageSchema.safeParse(message);
    expect(plain.success && plain.data.enc).toBe("plain");
    const e2e = MessageSchema.safeParse({ ...message, enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 3 });
    expect(e2e.success).toBe(true);
    if (e2e.success) expect(e2e.data).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 3 });
  });
});

describe("WsServerEventSchema", () => {
  it("接受 message_new / agent_chunk / agent_error / error", () => {
    expect(WsServerEventSchema.safeParse({ type: "message_new", message }).success).toBe(true);
    expect(
      WsServerEventSchema.safeParse({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "a1",
        streamId: "s1",
        text: "x",
      }).success,
    ).toBe(true);
    expect(
      WsServerEventSchema.safeParse({
        type: "agent_error",
        conversationId: "c1",
        agentId: "a1",
        streamId: "s1",
        code: "forbidden",
        message: "no",
      }).success,
    ).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "error", code: "x", message: "y" }).success).toBe(true);
  });

  it("已删除的 read_update / typing / message_recalled / voice_call_* 不再属于服务端契约", () => {
    for (const event of [
      { type: "read_update", conversationId: "c1", userId: "u1", at: iso },
      { type: "typing", conversationId: "c1", userId: "u1" },
      { type: "message_recalled", conversationId: "c1", messageId: "m1", at: iso },
      { type: "voice_call_invite", conversationId: "c1", callId: "x", sdp: "s", fromUserId: "u1" },
    ]) {
      expect(WsServerEventSchema.safeParse(event).success).toBe(false);
    }
  });
});

describe("auth 与资料", () => {
  it("RegisterBody / LoginBody / UpdateProfileBody", () => {
    expect(RegisterBodySchema.safeParse({ username: "alice", password: "secret123", displayName: "A" }).success).toBe(true);
    expect(RegisterBodySchema.safeParse({ username: "al", password: "secret123", displayName: "A" }).success).toBe(false);
    expect(LoginBodySchema.safeParse({ username: "admin", password: "admin" }).success).toBe(true);
    expect(LoginBodySchema.safeParse({ username: "admin", password: "" }).success).toBe(false);
    expect(UpdateProfileBodySchema.safeParse({ displayName: "A" }).success).toBe(true);
    expect(UpdateProfileBodySchema.safeParse({ displayName: "" }).success).toBe(false);
    expect(UserSchema.safeParse({ id: "u1", username: "alice", displayName: "A", avatar: "data:x" }).success).toBe(true);
  });
});

describe("会话与智能体", () => {
  it("ConversationSchema 只剩 agent 一种", () => {
    expect(
      ConversationSchema.safeParse({
        type: "agent",
        id: "c1",
        agent: { id: "a1", owner_id: null, name: "和小鸣", avatar: null, description: "" },
        unreadCount: 0,
        lastMessageAt: null,
      }).success,
    ).toBe(true);
    expect(ConversationSchema.safeParse({ type: "direct", id: "c1", peer: {} }).success).toBe(false);
    expect(ConversationSchema.safeParse({ type: "group", id: "c1", name: "g", memberCount: 1 }).success).toBe(false);
  });

  it("AgentConversationBody / AgentSchema / AgentBody", () => {
    expect(AgentConversationBodySchema.safeParse({ agentId: "a1" }).success).toBe(true);
    expect(AgentConversationBodySchema.safeParse({ peerId: "u1" }).success).toBe(false);
    expect(AgentSchema.safeParse({ id: "a1", owner_id: null, name: "n", avatar: null, description: "" }).success).toBe(true);
    expect(AgentBodySchema.safeParse({ name: "n" }).success).toBe(true);
    expect(AgentBodySchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("ConversationSchema 拒绝 unreadCount 负数", () => {
    expect(
      ConversationSchema.safeParse({
        type: "agent",
        id: "c1",
        agent: { id: "a1", owner_id: null, name: "n", avatar: null, description: "" },
        unreadCount: -1,
      }).success,
    ).toBe(false);
  });
});

describe("消息 payload 与文件", () => {
  it("附件可单独存在，key 可选", () => {
    expect(MessagePayloadSchema.safeParse({ text: "", file: { id: "f1", name: "a", mime: "text/plain", size: 1 } }).success).toBe(true);
    expect(
      MessagePayloadSchema.safeParse({
        text: "",
        file: { id: "f1", name: "a", mime: "text/plain", size: 1, key: "k".repeat(40) },
      }).success,
    ).toBe(true);
    expect(MessagePayloadSchema.safeParse({ text: "", file: { id: "f1", name: "a", mime: "text/plain", size: -1 } }).success).toBe(false);
  });

  it("mentions / forward / reactions 已从 payload 移除（多余键被剥掉）", () => {
    const r = MessagePayloadSchema.safeParse({
      text: "hi",
      mentions: [{ agentId: "a", name: "n" }],
      forward: { from: "x", source: "y" },
      reactions: [{ emoji: "👍", userIds: ["u1"] }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ text: "hi" });
  });

  it("CreateFileBody 校验", () => {
    expect(CreateFileBodySchema.safeParse({ name: "a", mime: "text/plain", contentBase64: "aGk=" }).success).toBe(true);
    expect(CreateFileBodySchema.safeParse({ name: "a".repeat(256), mime: "text/plain", contentBase64: "aGk=" }).success).toBe(false);
  });
});

describe("E2E 信封与流式", () => {
  const base = { conversationId: "c1", payload: { text: "" } };

  it("send_message e2e 必带 cipher；plain 不得夹带", () => {
    expect(WsClientEventSchema.safeParse({ ...base, type: "send_message", enc: "e2e" }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...base, type: "send_message", enc: "e2e", cipher: "" }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...base, type: "send_message", enc: "e2e", cipher: "Q2lwaGVy" }).success).toBe(true);
    expect(WsClientEventSchema.safeParse({ ...base, type: "send_message", enc: "plain", cipher: "Q2lwaGVy" }).success).toBe(false);
  });

  it("密文 chunk 必须 text 空串且带 chainKid/n/index", () => {
    const chunk = { type: "agent_chunk", conversationId: "c1", agentId: "a1", streamId: "s1" };
    expect(WsClientEventSchema.safeParse({ ...chunk, text: "" }).success).toBe(false); // 明文空串拒
    expect(WsClientEventSchema.safeParse({ ...chunk, text: "x", cipher: "Qw==", chainKid: "k", n: 1, index: 0 }).success).toBe(false); // 夹明文
    expect(WsClientEventSchema.safeParse({ ...chunk, text: "", cipher: "Qw==", chainKid: "k", n: 1, index: 0 }).success).toBe(true);
  });

  it("密文 finish 必须 text 空串且带 chainKid/n", () => {
    const fin = { type: "agent_finish", conversationId: "c1", agentId: "a1", streamId: "s1" };
    expect(WsClientEventSchema.safeParse({ ...fin, text: "" }).success).toBe(true); // 明文 finish 允许空（服务端 F2 再拒）
    expect(WsClientEventSchema.safeParse({ ...fin, text: "x", cipher: "Qw==", chainKid: "k", n: 1 }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ ...fin, text: "", cipher: "Qw==", chainKid: "k", n: 1 }).success).toBe(true);
  });

  it("E2eDeviceKeys / ReencryptBody", () => {
    const keys = {
      ikEcdh: "a",
      ikSign: "b",
      spk: { pub: "c", sig: "d", createdAt: 1 },
    };
    expect(E2eDeviceKeysSchema.safeParse(keys).success).toBe(true);
    expect(E2eDeviceKeysSchema.safeParse({ ...keys, spk: { pub: "c", sig: "d", createdAt: -1 } }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "Q2lwaGVy" }).success).toBe(true);
    expect(ReencryptBodySchema.safeParse({ enc: "plain", cipher: "Q2lwaGVy" }).success).toBe(false);
    expect(ReencryptBodySchema.safeParse({ enc: "e2e", cipher: "" }).success).toBe(false);
  });
});

describe("团队契约", () => {
  it("动向输入：kind 枚举、标题/来源限长、IS0 时间", () => {
    expect(TeamActivityInputSchema.safeParse({ kind: "task", title: "t", sourceId: "s", occurredAt: iso }).success).toBe(true);
    expect(TeamActivityInputSchema.safeParse({ kind: "chat", title: "t", sourceId: "s", occurredAt: iso }).success).toBe(false);
    expect(TeamActivityInputSchema.safeParse({ kind: "task", title: "x".repeat(201), sourceId: "s", occurredAt: iso }).success).toBe(false);
    expect(TeamActivityInputSchema.safeParse({ kind: "task", title: "t", sourceId: "s", occurredAt: "nope" }).success).toBe(false);
    expect(TeamActivityInputSchema.safeParse({ kind: "task", title: "t", sourceId: "s".repeat(201), occurredAt: iso }).success).toBe(false);
  });

  it("动向输入：task/agenda 的 detail/status 只能是状态摘要（d.109 C1 写侧收紧）", () => {
    const base = { title: "t", sourceId: "s", occurredAt: iso };
    // 合法摘要：与 share.ts 实际输出一字不差
    for (const [detail, status] of [
      ["任务 · 进行中", "running"],
      ["任务 · 已完成", "done"],
      ["任务 · 失败", "failed"],
      ["任务 · 已中断", "cancelled"],
    ]) {
      expect(TeamActivityInputSchema.safeParse({ ...base, kind: "task", detail, status }).success).toBe(true);
    }
    for (const [detail, status] of [
      ["日程 · 已逾期", "overdue"],
      ["日程 · 今天到期", "today"],
      ["日程 · 24 小时内到期", "next24h"],
    ]) {
      expect(TeamActivityInputSchema.safeParse({ ...base, kind: "agenda", detail, status }).success).toBe(true);
    }
    // detail/status 都是可选的：只报标题也合法
    expect(TeamActivityInputSchema.safeParse({ ...base, kind: "task" }).success).toBe(true);
    expect(TeamActivityInputSchema.safeParse({ ...base, kind: "agenda" }).success).toBe(true);

    // 自由文本 / 状态串不合法 → 拒绝，文案是给人看的中文
    const badDetail = TeamActivityInputSchema.safeParse({ ...base, kind: "task", detail: "这是正文……" });
    expect(badDetail.success).toBe(false);
    if (!badDetail.success) {
      expect(badDetail.error.issues[0]?.message).toBe("只接受标题与状态摘要");
      expect(badDetail.error.issues[0]?.path).toEqual(["detail"]);
    }
    const badTaskStatus = TeamActivityInputSchema.safeParse({ ...base, kind: "task", status: "todo" });
    expect(badTaskStatus.success).toBe(false);
    if (!badTaskStatus.success) {
      expect(badTaskStatus.error.issues[0]?.message).toBe("只接受标题与状态摘要");
    }
    // 精确集合而不是正则：夹带后缀的「任务 · 进行中（正文）」也不放过
    expect(
      TeamActivityInputSchema.safeParse({ ...base, kind: "task", detail: "任务 · 进行中（正文）" }).success,
    ).toBe(false);
    expect(TeamActivityInputSchema.safeParse({ ...base, kind: "agenda", detail: "日程 · 明天到期" }).success).toBe(false);
    expect(TeamActivityInputSchema.safeParse({ ...base, kind: "agenda", status: "later" }).success).toBe(false);
    // 其他 kind（agent/staff/join）保持自由文本现状
    expect(
      TeamActivityInputSchema.safeParse({ ...base, kind: "agent", detail: "和小鸣聊了 3 轮", status: "ok" }).success,
    ).toBe(true);
  });

  it("读侧不校验旧数据：detail 是收紧前写入的自由文本也照样读出", () => {
    expect(
      TeamActivityListSchema.safeParse({
        activities: [
          {
            id: "x",
            actorId: "u1",
            kind: "agenda",
            title: "旧日程",
            detail: "这是正文……",
            status: "whatever",
            sourceId: "s",
            occurredAt: iso,
            createdAt: iso,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("创建任务契约接受交付物（d.109 A1）", () => {
    expect(CreateTeamTaskBodySchema.safeParse({ title: "写落地页" }).success).toBe(true);
    expect(CreateTeamTaskBodySchema.safeParse({ title: "写落地页", attachmentFileId: "f9" }).success).toBe(true);
    expect(CreateTeamTaskBodySchema.safeParse({ title: "写落地页", attachmentFileId: null }).success).toBe(true);
    // 空串不是合法文件 id（与 PATCH 的 UpdateTeamTaskBodySchema 同口径）
    expect(CreateTeamTaskBodySchema.safeParse({ title: "写落地页", attachmentFileId: "" }).success).toBe(false);
  });

  it("批量写入 1..50 条", () => {
    const item = { kind: "task", title: "t", sourceId: "s", occurredAt: iso };
    expect(CreateTeamActivitiesBodySchema.safeParse({ items: [] }).success).toBe(false);
    expect(CreateTeamActivitiesBodySchema.safeParse({ items: [item] }).success).toBe(true);
    expect(CreateTeamActivitiesBodySchema.safeParse({ items: Array.from({ length: 51 }, () => item) }).success).toBe(false);
  });

  it("名册与动向列表形状", () => {
    expect(
      TeamRosterSchema.safeParse({
        members: [
          { user: { id: "u1", username: "alice", displayName: "A" }, lastSeenAt: iso, online: true },
        ],
        onlineCount: 1,
      }).success,
    ).toBe(true);
    expect(
      TeamActivityListSchema.safeParse({
        activities: [
          { id: "x", actorId: "u1", kind: "task", title: "t", sourceId: "s", occurredAt: iso, createdAt: iso },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("②-3 团队用量契约", () => {
  const item = {
    date: "2026-11-02",
    model: "gpt-x",
    tokens: 100,
    unreported: 0,
    connections: ["主连接"],
  };

  it("白名单字段：缺省 unreported/connections 有默认；null token 合法（未上报 ≠ 0）", () => {
    const parsed = TeamUsageInputSchema.safeParse({
      date: "2026-11-02",
      model: "gpt-x",
      tokens: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        date: "2026-11-02",
        model: "gpt-x",
        tokens: null,
        unreported: 0,
        connections: [],
      });
    }
  });

  it("日期键必须是 YYYY-MM-DD；越界字段拒绝", () => {
    expect(TeamUsageInputSchema.safeParse({ ...item, date: "2026-1-1" }).success).toBe(false);
    expect(TeamUsageInputSchema.safeParse({ ...item, date: "2026-13-01" }).success).toBe(false);
    expect(TeamUsageInputSchema.safeParse({ ...item, tokens: -1 }).success).toBe(false);
    expect(TeamUsageInputSchema.safeParse({ ...item, tokens: 1.5 }).success).toBe(false);
    expect(TeamUsageInputSchema.safeParse({ ...item, model: "" }).success).toBe(false);
    expect(TeamUsageInputSchema.safeParse({ ...item, model: "x".repeat(121) }).success).toBe(false);
    expect(
      TeamUsageInputSchema.safeParse({ ...item, connections: Array.from({ length: 6 }, () => "c") })
        .success,
    ).toBe(false);
  });

  it("批量写入 1..50 条；range 只接受 7d/30d", () => {
    expect(CreateTeamUsageBodySchema.safeParse({ items: [] }).success).toBe(false);
    expect(CreateTeamUsageBodySchema.safeParse({ items: [item] }).success).toBe(true);
    expect(
      CreateTeamUsageBodySchema.safeParse({ items: Array.from({ length: 51 }, () => item) }).success,
    ).toBe(false);
    expect(TeamUsageRangeSchema.safeParse("7d").success).toBe(true);
    expect(TeamUsageRangeSchema.safeParse("30d").success).toBe(true);
    expect(TeamUsageRangeSchema.safeParse("90d").success).toBe(false);
  });

  it("响应形状：self 有明细，排行行只有聚合数与显示名", () => {
    const response = {
      range: "7d",
      from: "2026-10-27",
      to: "2026-11-02",
      self: {
        total: 100,
        unreported: 1,
        byModel: [{ model: "gpt-x", tokens: 100, unreported: 1, connections: ["主连接"] }],
        byDay: [{ date: "2026-11-02", tokens: 100, unreported: 1 }],
      },
      ranking: [{ userId: "u1", displayName: "A", tokens: 100, unreported: 1, days: 1 }],
    };
    expect(TeamUsageResponseSchema.safeParse(response).success).toBe(true);
    // 排行行即使被塞进明细字段也会被剥掉（契约里没有这些键）
    const withDetail = TeamUsageRankRowSchema.safeParse({
      ...response.ranking[0],
      models: ["gpt-x"],
      connections: ["主连接"],
    });
    expect(withDetail.success).toBe(true);
    if (withDetail.success) expect(withDetail.data).not.toHaveProperty("models");
  });

  it("清除结果：deleted 为非负整数", () => {
    expect(TeamUsageClearResultSchema.safeParse({ deleted: 0 }).success).toBe(true);
    expect(TeamUsageClearResultSchema.safeParse({ deleted: 3 }).success).toBe(true);
    expect(TeamUsageClearResultSchema.safeParse({ deleted: -1 }).success).toBe(false);
    expect(TeamUsageClearResultSchema.safeParse({ deleted: 1.5 }).success).toBe(false);
  });
});
