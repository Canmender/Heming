import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../lib/memory/storage.js";
import type { StorageLike } from "../lib/memory/types.js";
import {
  MAX_BODY_CHARS,
  MAX_NOTIFICATIONS,
  MAX_TITLE_CHARS,
  NOTIFICATIONS_KEY,
  normalizeNotification,
  pruneNotifications,
  readNotifications,
  setNotificationStorage,
  unreadCount,
  useNotificationStore,
  type AppNotification,
} from "./notifications.js";

let storage: StorageLike;

beforeEach(() => {
  storage = createMemoryStorage();
  setNotificationStorage(storage);
  useNotificationStore.setState({ items: [] });
});

function makeItem(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: `ntf-${Math.random().toString(36).slice(2, 8)}`,
    kind: "message",
    key: `message:${Math.random().toString(36).slice(2, 8)}`,
    title: "鲍勃",
    body: "在吗",
    createdAt: 1_700_000_000_000,
    read: false,
    conversationId: "c1",
    ...overrides,
  };
}

describe("normalizeNotification / pruneNotifications / readNotifications", () => {
  it("非对象、缺 id/key、未知 kind、无标题都丢弃", () => {
    expect(normalizeNotification(null)).toBeNull();
    expect(normalizeNotification({ kind: "message", key: "k", title: "t" })).toBeNull();
    expect(normalizeNotification({ id: "1", key: "", title: "t", kind: "message" })).toBeNull();
    expect(
      normalizeNotification({ id: "1", key: "k", title: "   ", kind: "message", createdAt: 1 }),
    ).toBeNull();
    expect(normalizeNotification({ id: "1", key: "k", title: "t", kind: "sms", createdAt: 1 })).toBeNull();
  });

  it("正文/标题按码点截断，多余字段不带入", () => {
    const item = normalizeNotification({
      id: "1",
      key: "k",
      kind: "task",
      title: "任".repeat(MAX_TITLE_CHARS + 20),
      body: "字".repeat(MAX_BODY_CHARS + 20),
      createdAt: 10,
      read: true,
      taskId: "t1",
      多余: "忽略",
    });
    expect(item && [...item.title]).toHaveLength(MAX_TITLE_CHARS);
    expect(item && [...item.body]).toHaveLength(MAX_BODY_CHARS);
    expect(item?.taskId).toBe("t1");
    expect(item && "多余" in item).toBe(false);
  });

  it("超过条数上限淘汰最旧", () => {
    const list = Array.from({ length: MAX_NOTIFICATIONS + 6 }, (_, i) =>
      makeItem({ createdAt: 1_000 + i }),
    );
    const pruned = pruneNotifications(list);
    expect(pruned).toHaveLength(MAX_NOTIFICATIONS);
    expect(pruned[0].createdAt).toBe(1_000 + MAX_NOTIFICATIONS + 5);
    expect(pruned.some((n) => n.createdAt === 1_000)).toBe(false);
  });

  it("缺键 / 坏 JSON / 坏条目都回退空或只丢坏条目", () => {
    expect(readNotifications(storage)).toEqual([]);
    storage.setItem(NOTIFICATIONS_KEY, "{oops");
    expect(readNotifications(storage)).toEqual([]);
    storage.setItem(NOTIFICATIONS_KEY, JSON.stringify([makeItem({ title: "好" }), 42]));
    expect(readNotifications(storage).map((n) => n.title)).toEqual(["好"]);
  });
});

describe("useNotificationStore", () => {
  it("push 新条目为未读并落盘；同 key 再 push 返回 null 不重复", () => {
    const id = useNotificationStore.getState().push({
      kind: "message",
      key: "message:m1",
      title: "鲍勃",
      body: "在吗",
      conversationId: "c1",
    });
    expect(id).toBeTypeOf("string");
    expect(unreadCount(useNotificationStore.getState().items)).toBe(1);
    expect(readNotifications(storage)).toHaveLength(1);
    expect(
      useNotificationStore.getState().push({ kind: "message", key: "message:m1", title: "鲍勃" }),
    ).toBeNull();
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });

  it("空 key / 空标题不入库", () => {
    expect(useNotificationStore.getState().push({ kind: "message", key: "", title: "x" })).toBeNull();
    expect(
      useNotificationStore.getState().push({ kind: "message", key: "k", title: "  \n " }),
    ).toBeNull();
    expect(useNotificationStore.getState().items).toEqual([]);
  });

  it("markRead 只动一条；重复调用不改变引用；markAllRead 清零未读", () => {
    const a = useNotificationStore.getState().push({ kind: "message", key: "k1", title: "A" });
    useNotificationStore.getState().push({ kind: "message", key: "k2", title: "B" });
    useNotificationStore.getState().markRead(a as string);
    expect(unreadCount(useNotificationStore.getState().items)).toBe(1);

    const before = useNotificationStore.getState().items;
    useNotificationStore.getState().markRead(a as string);
    expect(useNotificationStore.getState().items).toBe(before);

    useNotificationStore.getState().markAllRead();
    expect(unreadCount(useNotificationStore.getState().items)).toBe(0);
    const after = useNotificationStore.getState().items;
    useNotificationStore.getState().markAllRead();
    expect(useNotificationStore.getState().items).toBe(after);
    expect(readNotifications(storage).every((n) => n.read)).toBe(true);
  });

  it("remove 摘单条，clearAll 清空并落盘", () => {
    const a = useNotificationStore.getState().push({ kind: "task", key: "k1", title: "任务A", taskId: "t1" });
    useNotificationStore.getState().push({ kind: "task", key: "k2", title: "任务B" });
    useNotificationStore.getState().remove("不存在");
    expect(useNotificationStore.getState().items).toHaveLength(2);
    useNotificationStore.getState().remove(a as string);
    expect(useNotificationStore.getState().items.map((n) => n.title)).toEqual(["任务B"]);
    useNotificationStore.getState().clearAll();
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(readNotifications(storage)).toEqual([]);
  });

  it("满上限后 push 最旧一条被淘汰", () => {
    useNotificationStore.setState({
      items: Array.from({ length: MAX_NOTIFICATIONS }, (_, i) =>
        makeItem({ key: `k${i}`, createdAt: 1_000 + i }),
      ),
    });
    useNotificationStore.getState().push({
      kind: "message",
      key: "newest",
      title: "最新",
      now: 9_000,
    });
    const items = useNotificationStore.getState().items;
    expect(items).toHaveLength(MAX_NOTIFICATIONS);
    expect(items[0].title).toBe("最新");
    expect(items.some((n) => n.key === "k0")).toBe(false);
  });
});

describe("approval 通知与 removeByKey（d.34）", () => {
  it("approval 能落盘并原样读回（新 kind 不被归一化丢掉）", () => {
    const id = useNotificationStore.getState().push({
      kind: "approval",
      key: "approval:req-1",
      title: "小鸣 请求调用工具",
      body: "写文件（fs__write_file）（等待确认）",
      conversationId: "c9",
    });
    expect(id).not.toBeNull();

    const again = readNotifications(storage);
    expect(again).toHaveLength(1);
    expect(again[0].kind).toBe("approval");
    expect(again[0].conversationId).toBe("c9");
  });

  it("staff 简报能落盘并原样读回（d.48）", () => {
    const id = useNotificationStore.getState().push({
      kind: "staff",
      key: "staff:run-1",
      title: "幕僚简报",
      body: "有 2 条日程临期。",
    });
    expect(id).not.toBeNull();

    const again = readNotifications(storage);
    expect(again).toHaveLength(1);
    expect(again[0].kind).toBe("staff");
  });

  it("removeByKey 只删指定 key，其它通知不动", () => {
    useNotificationStore.setState({
      items: [
        makeItem({ key: "approval:req-1", kind: "approval", title: "待确认" }),
        makeItem({ key: "message:m1", kind: "message", title: "消息" }),
        makeItem({ key: "task:t1", kind: "task", title: "任务" }),
      ],
    });

    useNotificationStore.getState().removeByKey("approval:req-1");

    const keys = useNotificationStore.getState().items.map((n) => n.key);
    expect(keys).toEqual(["message:m1", "task:t1"]);
    // 落盘同步
    expect(readNotifications(storage).map((n) => n.key)).toEqual(["message:m1", "task:t1"]);
  });

  it("removeByKey 对不存在的 key 是 no-op（不触发多余写盘）", () => {
    useNotificationStore.setState({ items: [makeItem({ key: "a" })] });
    useNotificationStore.getState().removeByKey("不存在");
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });
});
