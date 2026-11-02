import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PET_PRESENCE,
  PRESENCE_BUBBLE_MAX_CHARS,
  PRESENCE_BUBBLE_MS,
  PRESENCE_DEDUPE_MS,
  PRESENCE_MAX_PER_WINDOW,
  createPetPresence,
  createPresenceGate,
  decidePresence,
  derivePresence,
  deriveStaffPresence,
  deriveTaskPresence,
  bubbleTextForEvent,
  formatAgendaClock,
  isPetEventRoute,
  loadPetPresencePrefs,
  parsePetEvent,
  pickDueAgenda,
  prunePetPresence,
  reducePetEvent,
  savePetPresencePrefs,
  startPetPresence,
  resetPetPresenceRuntime,
  PET_PRESENCE_KEY,
  type PresenceAgendaItem,
  type PresenceNotification,
  type PetPresenceVisual,
} from "./petEvent.js";
import { useNotificationStore } from "../store/notifications.js";

describe("事件校验 · 合法载荷", () => {
  it("pose：认得的姿态放行", () => {
    expect(parsePetEvent({ kind: "pose", pose: "speaking" })).toEqual({ kind: "pose", pose: "speaking" });
  });

  it("pose：不认得的姿态拒绝（不是字符串 / 不在表里）", () => {
    expect(parsePetEvent({ kind: "pose", pose: "dancing" })).toBeNull();
    expect(parsePetEvent({ kind: "pose", pose: 42 })).toBeNull();
    expect(parsePetEvent({ kind: "pose" })).toBeNull();
  });

  it("speak：去首尾空白", () => {
    expect(parsePetEvent({ kind: "speak", text: "  早报来了  " })).toEqual({
      kind: "speak",
      text: "早报来了",
    });
  });

  it("speak：空白文本拒绝（空气泡等于没说话）", () => {
    expect(parsePetEvent({ kind: "speak", text: "   " })).toBeNull();
    expect(parsePetEvent({ kind: "speak", text: 123 })).toBeNull();
  });

  it("speak：超长文本截断并加省略号", () => {
    const long = "啊".repeat(300);
    const out = parsePetEvent({ kind: "speak", text: long });
    expect(out).not.toBeNull();
    expect((out as { text: string }).text.length).toBe(201); // 200 + 省略号
    expect((out as { text: string }).text.endsWith("…")).toBe(true);
  });

  it("task：ok 只认严格 true", () => {
    expect(parsePetEvent({ kind: "task", title: "导出完成", ok: true })).toEqual({
      kind: "task",
      title: "导出完成",
      ok: true,
    });
    expect(parsePetEvent({ kind: "task", title: "导出失败" })).toEqual({
      kind: "task",
      title: "导出失败",
      ok: false,
    });
    expect(parsePetEvent({ kind: "task", title: "x", ok: "true" })).toEqual({
      kind: "task",
      title: "x",
      ok: false,
    });
  });

  it("schedule：标题与时间都要有", () => {
    expect(parsePetEvent({ kind: "schedule", title: "晚自习", at: "19:00" })).toEqual({
      kind: "schedule",
      title: "晚自习",
      at: "19:00",
    });
    expect(parsePetEvent({ kind: "schedule", title: "晚自习" })).toBeNull();
    expect(parsePetEvent({ kind: "schedule", at: "19:00" })).toBeNull();
  });

  it("reset：无字段也成立", () => {
    expect(parsePetEvent({ kind: "reset" })).toEqual({ kind: "reset" });
  });
});

describe("事件校验 · 畸形载荷一律返回 null（桌宠没有控制台，不能抛）", () => {
  it("非对象 / 数组 / 空", () => {
    for (const bad of [null, undefined, 0, "", "pose", [], [1, 2], true]) {
      expect(parsePetEvent(bad)).toBeNull();
    }
  });

  it("缺 kind / kind 不认识", () => {
    expect(parsePetEvent({})).toBeNull();
    expect(parsePetEvent({ kind: "unknown" })).toBeNull();
    expect(parsePetEvent({ kind: 123 })).toBeNull();
  });

  it("多余字段被丢弃（不透传，避免把未知数据带进渲染层）", () => {
    const out = parsePetEvent({ kind: "speak", text: "hi", evil: "<script>" });
    expect(out).toEqual({ kind: "speak", text: "hi" });
  });
});

/* ══════════════════════ 在场感（d.58） ══════════════════════ */

const NOW = new Date(2026, 10, 2, 18, 30, 0).getTime();
const dueIn = (minutes: number) => NOW + minutes * 60_000;

function agendaItem(title: string, dueTs: number, id = 7): PresenceAgendaItem {
  return { title, dueTs, refId: `agenda:${id}` };
}

function notification(patch: Partial<PresenceNotification> = {}): PresenceNotification {
  return { kind: "task", title: "周报已完成", body: "", key: "task:t1:done", ...patch };
}

describe("事件契约扩展：route（点击气泡直达页面的白名单）", () => {
  it("合法 route 带上；非法 route 忽略但事件本身仍可用", () => {
    expect(parsePetEvent({ kind: "speak", text: "hi", route: "staff" })).toEqual({
      kind: "speak",
      text: "hi",
      route: "staff",
    });
    expect(parsePetEvent({ kind: "speak", text: "hi", route: "evil://x" })).toEqual({
      kind: "speak",
      text: "hi",
    });
    expect(isPetEventRoute("tasks")).toBe(true);
    expect(isPetEventRoute("chat")).toBe(false);
  });

  it("task / schedule 也可带 route", () => {
    expect(parsePetEvent({ kind: "task", title: "x", ok: true, route: "tasks" })).toEqual({
      kind: "task",
      title: "x",
      ok: true,
      route: "tasks",
    });
    expect(parsePetEvent({ kind: "schedule", title: "晚自习", at: "19:00", route: "infohub" })).toEqual({
      kind: "schedule",
      title: "晚自习",
      at: "19:00",
      route: "infohub",
    });
  });
});

describe("打扰强度偏好（本机，默认「正常」）", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    } as unknown as Storage & { map: Map<string, string> };
  }

  it("缺键 / 坏 JSON / 未知档位 → 回落到「正常」", () => {
    expect(loadPetPresencePrefs(fakeStorage()).intensity).toBe("normal");
    expect(loadPetPresencePrefs(fakeStorage({ [PET_PRESENCE_KEY]: "{坏" })).intensity).toBe("normal");
    expect(
      loadPetPresencePrefs(fakeStorage({ [PET_PRESENCE_KEY]: JSON.stringify({ intensity: "max" }) }))
        .intensity,
    ).toBe("normal");
  });

  it("保存后能读回；写失败不抛（隐私模式）", () => {
    const store = fakeStorage();
    savePetPresencePrefs({ intensity: "eager" }, store);
    expect(loadPetPresencePrefs(store).intensity).toBe("eager");
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    } as unknown as Storage;
    expect(() => savePetPresencePrefs({ intensity: "quiet" }, broken)).not.toThrow();
  });
});

describe("气泡文案：只带类型 + 标题级信息，≤60 字", () => {
  it("任务成功/失败措辞固定；标题压缩到一行", () => {
    expect(bubbleTextForEvent({ kind: "task", title: "周报", ok: true })).toBe("完成了：周报");
    expect(bubbleTextForEvent({ kind: "task", title: "部署", ok: false })).toBe("没成功：部署");
  });

  it("日程只带 HH:MM + 标题（不带证据/会话/发送人）", () => {
    expect(bubbleTextForEvent({ kind: "schedule", title: "晚自习", at: "19:00" })).toBe("19:00 晚自习");
    expect(formatAgendaClock(new Date(2026, 10, 2, 9, 5).getTime())).toBe("09:05");
  });

  it("超长文本被截断到上限并压成一行", () => {
    const text = bubbleTextForEvent({ kind: "speak", text: `第一行\n${"啊".repeat(200)}` });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(PRESENCE_BUBBLE_MAX_CHARS);
    expect(text).not.toContain("\n");
    expect(text!.endsWith("…")).toBe(true);
  });
});

describe("通知 → 事件派生（任务收尾 / 幕僚简报 / 日程临期）", () => {
  it("任务收尾：剥掉状态后缀、body 不进事件（结果正文/会话名不外泄）", () => {
    const plan = deriveTaskPresence(
      notification({ title: "周报执行失败", body: "错误详情：连接超时；会话：研发群；发送人：张三" }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.event).toEqual({ kind: "task", title: "周报", ok: false, route: "tasks" });
    const serialized = JSON.stringify(plan!.event);
    expect(serialized).not.toContain("连接超时");
    expect(serialized).not.toContain("研发群");
    expect(serialized).not.toContain("张三");
  });

  it("不是「收尾」类任务通知（如记录被清理）→ 不打断", () => {
    expect(deriveTaskPresence(notification({ title: "任务记录被清理" }))).toBeNull();
    expect(deriveTaskPresence(notification({ kind: "staff", title: "幕僚简报" }))).toBeNull();
  });

  it("幕僚简报 + 临期日程 → schedule（标题 + HH:MM，route=信息中枢）", () => {
    const plan = deriveStaffPresence(
      notification({ kind: "staff", title: "幕僚简报", body: "今天有 1 条日程临期。", key: "staff:r1" }),
      [agendaItem("晚自习", dueIn(30))],
      NOW,
    );
    expect(plan!.event).toEqual({ kind: "schedule", title: "晚自习", at: "19:00", route: "infohub" });
    expect(plan!.route).toBe("infohub");
  });

  it("幕僚简报 + 无临期日程 → speak（summary 截断 ≤60，不带证据原文）", () => {
    const plan = deriveStaffPresence(
      notification({
        kind: "staff",
        title: "幕僚简报",
        body: `今天有 2 条日程临期、1 个任务需要留意。${"细节".repeat(80)}`,
        key: "staff:r2",
      }),
      [agendaItem("太远的日程", dueIn(60 * 48))],
      NOW,
    );
    expect(plan!.event.kind).toBe("speak");
    const text = (plan!.event as { text: string }).text;
    expect(text.startsWith("幕僚简报：")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(PRESENCE_BUBBLE_MAX_CHARS);
    expect(plan!.route).toBe("staff");
  });

  it("日程挑选：逾期优先，其次最近到期；24 小时外不打扰", () => {
    const list = [agendaItem("明天", dueIn(60 * 20), 1), agendaItem("已逾期", NOW - 60_000, 2)];
    expect(pickDueAgenda(list, NOW)?.title).toBe("已逾期");
    expect(pickDueAgenda([agendaItem("太远", dueIn(60 * 48), 3)], NOW)).toBeNull();
  });

  it("不认识的类型（approval / message）静默忽略", () => {
    expect(derivePresence(notification({ kind: "approval" }), { now: NOW })).toBeNull();
    expect(derivePresence(notification({ kind: "message" }), { now: NOW })).toBeNull();
  });

  it("去重键缺失时用标题/时间兜底（不允许空 key）", () => {
    const plan = deriveTaskPresence({ kind: "task", title: "周报已完成" });
    expect(plan!.dedupeKey.length).toBeGreaterThan(0);
  });
});

describe("渠道互斥 + 频控（单一判据）", () => {
  const plan = deriveTaskPresence(notification())!;

  it("主窗口在前台 → 只走通知中心，桌宠不说，且不消耗频控额度", () => {
    const gate = createPresenceGate();
    const fg = decidePresence(plan, { mainForeground: true, now: NOW, gate });
    expect(fg.action).toBe("notification-center");
    // 前台判过之后，同一条事件在后台仍可正常送达（额度没有被前台消费）
    const bg = decidePresence(plan, { mainForeground: false, now: NOW, gate });
    expect(bg.action).toBe("pet");
  });

  it("主窗口不在前台 → 桌宠说", () => {
    const gate = createPresenceGate();
    expect(decidePresence(plan, { mainForeground: false, now: NOW, gate }).action).toBe("pet");
  });

  it("同一事件 10 分钟内只冒泡一次（重复 → duplicate）", () => {
    const gate = createPresenceGate();
    expect(decidePresence(plan, { mainForeground: false, now: NOW, gate }).action).toBe("pet");
    const again = decidePresence(plan, { mainForeground: false, now: NOW + 1000, gate });
    expect(again).toMatchObject({ action: "drop", reason: "duplicate" });
    // 过了 10 分钟窗口后可以再次提醒（新的一天/新一次简报）
    const later = decidePresence(plan, { mainForeground: false, now: NOW + PRESENCE_DEDUPE_MS + 1, gate });
    expect(later.action).toBe("pet");
  });

  it("10 分钟内最多冒泡 N 次（批量任务收尾不刷屏）", () => {
    const gate = createPresenceGate();
    for (let i = 0; i < PRESENCE_MAX_PER_WINDOW; i += 1) {
      const event = deriveTaskPresence(notification({ title: `任务${i}已完成`, key: `k${i}` }))!;
      expect(decidePresence(event, { mainForeground: false, now: NOW + i, gate }).action).toBe("pet");
    }
    const overflow = deriveTaskPresence(notification({ title: "任务溢出已完成", key: "k-overflow" }))!;
    expect(decidePresence(overflow, { mainForeground: false, now: NOW + 10, gate })).toMatchObject({
      action: "drop",
      reason: "rate-limited",
    });
  });
});

describe("事件 → 表达状态（三档强度必须真的不同）", () => {
  const prev = { ...EMPTY_PET_PRESENCE };
  const event = { kind: "schedule" as const, title: "晚自习", at: "19:00", route: "infohub" as const };

  it("安静档：只换姿态，不冒泡", () => {
    const out = reducePetEvent(prev, event, { now: NOW, intensity: "quiet" });
    expect(out.bubble).toBeNull();
    expect(out.pose).toBe("alerting");
    expect(out.poseUntil).toBe(NOW + PRESENCE_BUBBLE_MS);
  });

  it("正常档：只冒泡 4 秒（不动姿态）", () => {
    const out = reducePetEvent(prev, event, { now: NOW, intensity: "normal" });
    expect(out.pose).toBeNull();
    expect(out.bubble).toEqual({ text: "19:00 晚自习", route: "infohub", until: NOW + PRESENCE_BUBBLE_MS });
  });

  it("积极档：姿态 + 气泡（成功任务给开心 → 有轻微动作）", () => {
    const out = reducePetEvent(prev, { kind: "task", title: "周报", ok: true, route: "tasks" }, {
      now: NOW,
      intensity: "eager",
    });
    expect(out.pose).toBe("happy");
    expect(out.bubble?.text).toBe("完成了：周报");
    expect(out.bubble?.route).toBe("tasks");
  });

  it("三档结果两两不同（不是只存了个值）", () => {
    const quiet = reducePetEvent(prev, event, { now: NOW, intensity: "quiet" });
    const normal = reducePetEvent(prev, event, { now: NOW, intensity: "normal" });
    const eager = reducePetEvent(prev, event, { now: NOW, intensity: "eager" });
    expect(JSON.stringify(quiet)).not.toBe(JSON.stringify(normal));
    expect(JSON.stringify(normal)).not.toBe(JSON.stringify(eager));
    expect(JSON.stringify(quiet)).not.toBe(JSON.stringify(eager));
    expect(quiet.bubble).toBeNull();
    expect(normal.pose).toBeNull();
    expect(eager.bubble).not.toBeNull();
    expect(eager.pose).not.toBeNull();
  });

  it("畸形事件无反应（返回同一个状态对象，不抛）", () => {
    for (const bad of [null, { kind: "speak", text: "" }, { kind: "pose", pose: "dancing" }, [], 42]) {
      expect(reducePetEvent(prev, bad, { now: NOW, intensity: "eager" })).toBe(prev);
    }
  });

  it("与用户对话中（busy）不打断：本次不显示", () => {
    expect(reducePetEvent(prev, event, { now: NOW, intensity: "eager", busy: true })).toBe(prev);
  });

  it("reset 清空；过期后由 prune 收回", () => {
    const out = reducePetEvent(prev, event, { now: NOW, intensity: "eager" });
    expect(reducePetEvent(out, { kind: "reset" }, { now: NOW, intensity: "eager" })).toEqual(
      EMPTY_PET_PRESENCE,
    );
    expect(prunePetPresence(out, NOW + PRESENCE_BUBBLE_MS - 1)).toBe(out); // 未到期
    const pruned = prunePetPresence(out, NOW + PRESENCE_BUBBLE_MS + 1);
    expect(pruned.bubble).toBeNull();
    expect(pruned.pose).toBeNull();
  });
});

describe("在场感运行器（订阅 → 派生 → 互斥/频控 → emit）", () => {
  function makeRuntime(overrides: {
    mainForeground?: () => boolean;
    emit?: (payload: unknown) => void;
    agenda?: () => PresenceAgendaItem[];
    now?: () => number;
  } = {}) {
    let listener: ((item: PresenceNotification) => void) | null = null;
    const runtime = createPetPresence({
      emit: overrides.emit ?? (() => {}),
      mainForeground: overrides.mainForeground ?? (() => false),
      agenda: overrides.agenda ?? (() => []),
      now: overrides.now ?? (() => NOW),
      subscribe: (cb) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
    });
    return { runtime, push: (item: PresenceNotification) => listener?.(item) };
  }

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("前台：不 emit（只走通知中心）", async () => {
    const emit = vi.fn();
    const { runtime, push } = makeRuntime({ mainForeground: () => true, emit });
    push(notification());
    await flush();
    expect(emit).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("后台：emit 一次，且重复事件不再 emit", async () => {
    const emit = vi.fn();
    const { runtime, push } = makeRuntime({ emit });
    push(notification());
    await flush();
    push(notification());
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toEqual({
      kind: "task",
      title: "周报",
      ok: true,
      route: "tasks",
    });
    runtime.dispose();
  });

  it("桌宠不可达（emit 抛错）→ 丢弃、不重试、不抛", async () => {
    const { runtime, push } = makeRuntime({
      emit: () => {
        throw new Error("ipc closed");
      },
    });
    push(notification());
    await flush();
    expect(() => runtime.dispose()).not.toThrow();
  });

  it("dispose 之后不再处理", async () => {
    const emit = vi.fn();
    const { runtime, push } = makeRuntime({ emit });
    runtime.dispose();
    push(notification());
    await flush();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("startPetPresence（App 挂载入口）", () => {
  function installPetBridge(): void {
    (window as unknown as { __heming_pet?: unknown }).__heming_pet = {
      emit: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    };
  }

  it("无桌宠桥（浏览器）→ 空操作，不抛", () => {
    delete (window as unknown as { __heming_pet?: unknown }).__heming_pet;
    const dispose = startPetPresence();
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
  });

  it("有桥：订阅新通知并 emit；重复启动幂等；退订后停止", async () => {
    installPetBridge();
    const emitted: unknown[] = [];
    const hub: { listener: ((item: PresenceNotification) => void) | null } = { listener: null };
    const overrides = {
      emit: (payload: unknown) => void emitted.push(payload),
      mainForeground: () => false,
      agenda: () => [],
      now: () => NOW,
      subscribe: (cb: (item: PresenceNotification) => void) => {
        hub.listener = cb;
        return () => {
          hub.listener = null;
        };
      },
    };
    const dispose = startPetPresence(overrides);
    const disposeAgain = startPetPresence(overrides); // 幂等：第二个是空操作
    hub.listener?.(notification());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toHaveLength(1);
    disposeAgain();
    dispose();
    hub.listener?.(notification({ key: "another" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toHaveLength(1); // 已退订
    resetPetPresenceRuntime();
  });

  it("只处理订阅之后新增的通知（错过不补发：已有的不回放）", async () => {
    installPetBridge();
    useNotificationStore.setState({ items: [] });
    const emitted: unknown[] = [];
    const dispose = startPetPresence({
      emit: (payload: unknown) => void emitted.push(payload),
      mainForeground: () => false,
      agenda: () => [],
      now: () => NOW,
    });
    useNotificationStore.getState().push({ kind: "task", key: "task:t1:done", title: "周报已完成" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toHaveLength(1);
    dispose();
    resetPetPresenceRuntime();
    delete (window as unknown as { __heming_pet?: unknown }).__heming_pet;
  });
});
