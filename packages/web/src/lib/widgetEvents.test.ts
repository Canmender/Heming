import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWidgetNotifyEvent,
  clipWidgetEventText,
  createWidgetEvents,
  resetWidgetEvents,
  startWidgetEvents,
  subscribeNewNotifications,
  WIDGET_EVENT_TEXT_MAX,
} from "./widgetEvents.js";
import type { AppNotification } from "../store/notifications.js";
import type { WidgetNotifyEvent, WidgetsBridge } from "../types/widgets.js";

/**
 * 通知中心 → 界面插件事件转发（d.98 §4.2）。
 *
 * 这层唯一的职责是**脱敏**：只把 kind/title/summary/route/at 交出去，
 * 不带正文、附件、会话名、发送人、conversationId/taskId。
 * 用例直接对 JSON 串做断言——「哪些字段没出去」是硬约定，不是实现细节。
 */

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "ntf-1",
    kind: "task",
    key: "task:1:done",
    title: "整理季度报表 已完成",
    body: "3 个工具 · 用时 12s",
    createdAt: 1_700_000_000_000,
    read: false,
    conversationId: "conv-secret",
    taskId: "task-secret",
    ...overrides,
  };
}

describe("clipWidgetEventText", () => {
  it("压成一行并截断到 60 字（按字符，不劈 emoji）", () => {
    expect(clipWidgetEventText("  两行\n文字  ")).toBe("两行 文字");
    expect(clipWidgetEventText("x".repeat(80))).toHaveLength(WIDGET_EVENT_TEXT_MAX);
    expect(clipWidgetEventText("x".repeat(80)).endsWith("…")).toBe(true);
    const emoji = "😀".repeat(70);
    expect([...clipWidgetEventText(emoji)]).toHaveLength(WIDGET_EVENT_TEXT_MAX);
    expect(clipWidgetEventText(undefined)).toBe("");
  });
});

describe("buildWidgetNotifyEvent（脱敏口径）", () => {
  it("任务收尾：只带标题 + 状态路由，不带执行细节", () => {
    const event = buildWidgetNotifyEvent(notification());
    expect(event).toEqual({
      kind: "notify",
      title: "整理季度报表 已完成",
      summary: "",
      route: "tasks",
      at: "2023-11-14T22:13:20.000Z",
    });
  });

  it("幕僚简报：summary 取简报摘要（≤60 字，与旧桌宠口径一致）", () => {
    const event = buildWidgetNotifyEvent(
      notification({ kind: "staff", key: "staff:1", title: "幕僚简报", body: "今天 3 个日程、2 个任务临期" }),
    );
    expect(event?.summary).toBe("今天 3 个日程、2 个任务临期");
    expect(event?.route).toBe("staff");
  });

  it("待确认：summary 只取工具显示名，不带参数正文", () => {
    const event = buildWidgetNotifyEvent(
      notification({ kind: "approval", key: "approval:1", title: "助手请求调用工具", body: "写入文件、查询" }),
    );
    expect(event?.summary).toBe("写入文件、查询");
    expect(event?.route).toBeUndefined();
  });

  it("自动化失败：不带路由与正文（标题已含状态）", () => {
    const event = buildWidgetNotifyEvent(
      notification({ kind: "automation", key: "automation:1", title: "「每日同步」执行失败", body: "ENOENT: ..." }),
    );
    expect(event?.summary).toBe("");
    expect(event?.route).toBeUndefined();
  });

  it("事件 JSON 里不存在正文/附件/会话/发送人/内部 id", () => {
    for (const kind of ["task", "approval", "staff", "automation"] as const) {
      const json = JSON.stringify(
        buildWidgetNotifyEvent(
          notification({
            kind,
            body: "含正文/附件名/会话名",
            conversationId: "conv-secret",
            taskId: "task-secret",
            automationId: "auto-secret",
          }),
        ),
      );
      expect(json).not.toContain("body");
      expect(json).not.toContain("conversationId");
      expect(json).not.toContain("conv-secret");
      expect(json).not.toContain("taskId");
      expect(json).not.toContain("task-secret");
      expect(json).not.toContain("automation");
      expect(json).not.toContain("sender");
    }
  });

  it("标题超长截断、空标题丢弃、坏时间用当前时间兜底", () => {
    const long = buildWidgetNotifyEvent(notification({ title: "长".repeat(120) }));
    expect([...(long?.title ?? "")]).toHaveLength(WIDGET_EVENT_TEXT_MAX);
    expect(buildWidgetNotifyEvent(notification({ title: "   " }))).toBeNull();
    const bad = buildWidgetNotifyEvent(notification({ createdAt: Number.NaN }));
    expect(Number.isNaN(Date.parse(bad?.at ?? ""))).toBe(false);
  });
});

describe("createWidgetEvents", () => {
  it("新通知 → publish；publish 抛错只吞这条", () => {
    const listeners: Array<(item: AppNotification) => void> = [];
    const publish = vi.fn();
    const runtime = createWidgetEvents({
      publish,
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    });
    expect(runtime.handle(notification())).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({ kind: "notify", route: "tasks" });

    const throwing = createWidgetEvents({
      publish: () => {
        throw new Error("IPC 抖动");
      },
      subscribe: () => () => {},
    });
    expect(() => throwing.handle(notification())).not.toThrow();
    expect(throwing.handle(notification())).toBe(false);
    runtime.dispose();
    throwing.dispose();
  });

  it("dispose 后不再转发，并退订", () => {
    const unsubscribe = vi.fn();
    const publish = vi.fn();
    const runtime = createWidgetEvents({ publish, subscribe: () => unsubscribe });
    runtime.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.handle(notification())).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("subscribeNewNotifications", () => {
  it("只转发订阅之后新增的条目，按旧→新顺序", () => {
    let items: AppNotification[] = [notification({ id: "old", key: "old" })];
    const listeners: Array<(state: { items: AppNotification[] }, prev: { items: AppNotification[] }) => void> = [];
    const store = {
      getState: () => ({ items }),
      subscribe: (listener: (state: { items: AppNotification[] }, prev: { items: AppNotification[] }) => void) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeNewNotifications>[1];

    const seen: string[] = [];
    subscribeNewNotifications((item) => seen.push(item.id), store);
    const prev = { items };
    items = [
      notification({ id: "new-2", key: "new-2" }),
      notification({ id: "new-1", key: "new-1" }),
      ...items,
    ];
    listeners[0]?.({ items }, prev);
    // 列表是倒序的（最新在前），转发应按发生顺序（旧→新）
    expect(seen).toEqual(["new-1", "new-2"]);
    // items 没变时不该重复触发
    listeners[0]?.({ items }, { items });
    expect(seen).toHaveLength(2);
  });
});

describe("startWidgetEvents", () => {
  beforeEach(() => {
    resetWidgetEvents();
    delete window.__heming_widgets;
  });

  it("无界面插件桥 → 空操作", () => {
    const dispose = startWidgetEvents({}, undefined);
    expect(typeof dispose).toBe("function");
    dispose();
  });

  it("有桥 → 订阅通知并按脱敏事件转发；重复调用幂等", () => {
    let listener: ((item: AppNotification) => void) | undefined;
    const publish = vi.fn();
    const bridge = { publish } as unknown as WidgetsBridge;
    const dispose = startWidgetEvents(
      {
        subscribe: (fn) => {
          listener = fn;
          return () => {
            listener = undefined;
          };
        },
      },
      bridge,
    );
    listener?.(notification());
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0][0] as WidgetNotifyEvent;
    expect(event.kind).toBe("notify");
    // 幂等：第二次调用不会重复订阅
    const second = startWidgetEvents({}, bridge);
    expect(second).not.toBe(dispose);
    dispose();
    expect(listener).toBeUndefined();
  });
});
