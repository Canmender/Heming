import { describe, expect, it } from "vitest";
import {
  EMPTY_PET_PRESENCE,
  PRESENCE_BUBBLE_MAX_CHARS,
  PRESENCE_BUBBLE_MS,
  adaptWidgetEvent,
  bubbleTextForEvent,
  parsePetEvent,
  prunePetPresence,
  reducePetEvent,
  type PetPresenceVisual,
} from "./petEvent.js";

/**
 * 拆分后事件层只剩**消费端**：宿主转发 → 气泡/姿态。
 * 生产/渠道互斥/频控留在宿主（那边有 getMainWindow 权威判据），这里不重复测。
 */
const NOW = 1_000_000;

function reduce(
  prev: PetPresenceVisual,
  raw: unknown,
  opts: Partial<{ now: number; intensity: "quiet" | "normal" | "eager"; busy: boolean }> = {},
) {
  return reducePetEvent(prev, raw, {
    now: opts.now ?? NOW,
    intensity: opts.intensity ?? "normal",
    busy: opts.busy,
  });
}

describe("旧契约解析", () => {
  it("五种 kind 的合法载荷", () => {
    expect(parsePetEvent({ kind: "pose", pose: "happy" })).toEqual({ kind: "pose", pose: "happy" });
    expect(parsePetEvent({ kind: "speak", text: " 在 ", route: "tasks" })).toEqual({
      kind: "speak",
      text: "在",
      route: "tasks",
    });
    expect(parsePetEvent({ kind: "task", title: "周报", ok: true })).toEqual({
      kind: "task",
      title: "周报",
      ok: true,
    });
    expect(parsePetEvent({ kind: "schedule", title: "晚自习", at: "19:00" })).toEqual({
      kind: "schedule",
      title: "晚自习",
      at: "19:00",
    });
    expect(parsePetEvent({ kind: "reset" })).toEqual({ kind: "reset" });
  });

  it("畸形载荷返回 null（静默忽略，不抛）", () => {
    for (const bad of [
      null,
      42,
      [],
      { kind: "speak", text: "" },
      { kind: "speak", text: "  " },
      { kind: "pose", pose: "dancing" },
      { kind: "task", ok: true },
      { kind: "schedule", title: "x" },
      { kind: "unknown" },
    ]) {
      expect(parsePetEvent(bad)).toBeNull();
    }
  });

  it("非法 route 不带上（事件本身仍可用）", () => {
    expect(parsePetEvent({ kind: "speak", text: "在", route: "admin" })).toEqual({
      kind: "speak",
      text: "在",
    });
  });
});

describe("宿主转发事件（notify）适配", () => {
  it("带 at 的 notify 按日程提醒", () => {
    expect(
      adaptWidgetEvent({ kind: "notify", title: "晚自习", at: "19:00", route: "infohub" }),
    ).toEqual({ kind: "schedule", title: "晚自习", at: "19:00", route: "infohub" });
  });

  it("无 at 时优先 summary，没有就用 title", () => {
    expect(adaptWidgetEvent({ kind: "notify", title: "简报", summary: "今天 3 个任务待处理" })).toEqual(
      { kind: "speak", text: "今天 3 个任务待处理" },
    );
    expect(adaptWidgetEvent({ kind: "notify", title: "简报" })).toEqual({
      kind: "speak",
      text: "简报",
    });
  });

  it("theme/tray 与畸形载荷不产生表达", () => {
    for (const bad of [null, { kind: "theme", theme: "dark" }, { kind: "tray", action: "toggle" }, { kind: "notify" }, {}]) {
      expect(adaptWidgetEvent(bad)).toBeNull();
    }
  });

  it("旧契约事件仍可直接喂给适配器（迁移期联调）", () => {
    expect(adaptWidgetEvent({ kind: "task", title: "部署", ok: false })).toEqual({
      kind: "task",
      title: "部署",
      ok: false,
    });
  });
});

describe("强度三档的归约", () => {
  it("正常档（默认）：只冒泡、不动姿态，4 秒后到期", () => {
    const next = reduce({ ...EMPTY_PET_PRESENCE }, { kind: "task", title: "周报", ok: true });
    expect(next.bubble?.text).toBe("完成了：周报");
    expect(next.bubble?.until).toBe(NOW + PRESENCE_BUBBLE_MS);
    expect(next.pose).toBeNull();
  });

  it("安静档：只换姿态、不冒泡（失败/日程 → alerting）", () => {
    const next = reduce({ ...EMPTY_PET_PRESENCE }, { kind: "task", title: "周报", ok: false }, {
      intensity: "quiet",
    });
    expect(next.bubble).toBeNull();
    expect(next.pose).toBe("alerting");
  });

  it("积极档：气泡 + 姿态；成功任务给开心（唯一的进入动作）", () => {
    const next = reduce({ ...EMPTY_PET_PRESENCE }, { kind: "task", title: "周报", ok: true }, {
      intensity: "eager",
    });
    expect(next.bubble?.text).toBe("完成了：周报");
    expect(next.pose).toBe("happy");
  });

  it("显式 pose 不受强度影响", () => {
    const next = reduce({ ...EMPTY_PET_PRESENCE }, { kind: "pose", pose: "thinking" }, {
      intensity: "quiet",
    });
    expect(next.pose).toBe("thinking");
    expect(next.bubble).toBeNull();
  });

  it("busy（正在对话）时整条事件被丢弃，由调用方排队", () => {
    const prev = { ...EMPTY_PET_PRESENCE };
    expect(reduce(prev, { kind: "speak", text: "打断吗" }, { busy: true })).toBe(prev);
  });

  it("reset 清空；畸形事件原样返回（同一引用）", () => {
    const withBubble = reduce({ ...EMPTY_PET_PRESENCE }, { kind: "speak", text: "在" });
    expect(reduce(withBubble, { kind: "reset" })).toEqual(EMPTY_PET_PRESENCE);
    expect(reduce(withBubble, { kind: "speak", text: "" })).toBe(withBubble);
  });
});

describe("气泡文案与到期清理", () => {
  it("只带标题级信息，长文本截到上限", () => {
    const long = "一".repeat(PRESENCE_BUBBLE_MAX_CHARS + 20);
    const text = bubbleTextForEvent({ kind: "speak", text: long });
    expect(text).not.toBeNull();
    expect([...(text as string)].length).toBe(PRESENCE_BUBBLE_MAX_CHARS);
    expect((text as string).endsWith("…")).toBe(true);
  });

  it("多行压成一行（气泡不是文章）", () => {
    expect(bubbleTextForEvent({ kind: "speak", text: "第一行\n第二行" })).toBe("第一行 第二行");
  });

  it("任务成功/失败、日程的文案模板", () => {
    expect(bubbleTextForEvent({ kind: "task", title: "周报", ok: true })).toBe("完成了：周报");
    expect(bubbleTextForEvent({ kind: "task", title: "周报", ok: false })).toBe("没成功：周报");
    expect(bubbleTextForEvent({ kind: "schedule", title: "晚自习", at: "19:00" })).toBe(
      "19:00 晚自习",
    );
  });

  it("过期即清空；未过期不动", () => {
    const next = reduce({ ...EMPTY_PET_PRESENCE }, { kind: "speak", text: "在" });
    expect(prunePetPresence(next, NOW + 10)).toBe(next);
    expect(prunePetPresence(next, NOW + PRESENCE_BUBBLE_MS + 1)).toEqual(EMPTY_PET_PRESENCE);
  });
});
